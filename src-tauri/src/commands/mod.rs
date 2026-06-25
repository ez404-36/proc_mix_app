// Tauri commands exposed to the frontend via invoke().

pub mod sftp;

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::core::executor::{self, ExecuteRequest, ExecutorState};
use crate::core::http_server::{self, HttpServerState};
use crate::core::scheduler::{self, SchedulerState};
use crate::core::scope_tracker::CaptureScope;
use crate::core::shells;
use crate::core::ssh::history as ssh_history;
use crate::core::workflow::{self, WorkflowExecutorState};
use crate::platform::process_watch::{self, WatcherState};
use crate::platform::tray::{self, TrayLabels};
use crate::security::admin_password;
use crate::security::api_token;
use crate::security::ssh_password;
use crate::storage::commands as storage_commands;
use crate::storage::history as storage_history;
use crate::storage::http_server as storage_http_server;
use crate::storage::schedules as storage_schedules;
use crate::storage::workflows as storage_workflows;
use crate::storage::DbPool;

#[tauri::command]
pub async fn execute_command(
    app: AppHandle,
    state: State<'_, Arc<ExecutorState>>,
    req: ExecuteRequest,
) -> Result<String, String> {
    executor::spawn_execution(app, state.inner().clone(), req).await
}

#[tauri::command]
pub async fn cancel_execution(
    state: State<'_, Arc<ExecutorState>>,
    execution_id: String,
) -> Result<(), String> {
    executor::cancel_execution(state.inner().clone(), execution_id).await
}

#[tauri::command]
pub async fn list_running_executions(
    state: State<'_, Arc<ExecutorState>>,
) -> Result<Vec<String>, String> {
    let map = state.inner().running.lock().await;
    Ok(map.keys().cloned().collect())
}

#[tauri::command]
pub async fn update_tray_menu(app: AppHandle, labels: TrayLabels) -> Result<(), String> {
    tray::apply_labels(&app, &labels).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_commands(
    pool: State<'_, DbPool>,
) -> Result<Vec<storage_commands::CommandRecord>, String> {
    storage_commands::list_all(pool.inner()).await
}

#[tauri::command]
pub async fn upsert_command(
    pool: State<'_, DbPool>,
    command: storage_commands::CommandRecord,
) -> Result<(), String> {
    storage_commands::upsert(pool.inner(), &command).await
}

#[tauri::command]
pub async fn delete_command(pool: State<'_, DbPool>, id: String) -> Result<(), String> {
    storage_commands::delete(pool.inner(), &id).await
}

/// Cascade-delete every `local`-scoped command owned by the given workflow.
/// Called by the frontend when a workflow is deleted so its private commands
/// go with it. Idempotent — a workflow with no local commands is a no-op.
#[tauri::command]
pub async fn delete_local_commands_for_workflow(
    pool: State<'_, DbPool>,
    workflow_id: String,
) -> Result<(), String> {
    storage_commands::delete_local_for_workflow(pool.inner(), &workflow_id).await
}

// ----------------------------------------------------------------------
// Workflow CRUD + execution commands.
//
// CRUD wrappers mirror the command-library trio exactly (list / upsert /
// delete over `storage::workflows`). `execute_workflow` is the only one
// with real logic: it resolves every `CommandRecord` referenced by a
// `command` / `condition` node from storage, hands the graph + resolved
// commands to the workflow engine, and returns the run id. The engine
// itself never touches the DB — keeping it testable — so resolution lives
// here at the command boundary.
// ----------------------------------------------------------------------

#[tauri::command]
pub async fn list_workflows(
    pool: State<'_, DbPool>,
) -> Result<Vec<storage_workflows::WorkflowRecord>, String> {
    storage_workflows::list_all(pool.inner()).await
}

#[tauri::command]
pub async fn upsert_workflow(
    pool: State<'_, DbPool>,
    workflow: storage_workflows::WorkflowRecord,
) -> Result<(), String> {
    storage_workflows::upsert(pool.inner(), &workflow).await
}

#[tauri::command]
pub async fn delete_workflow(pool: State<'_, DbPool>, id: String) -> Result<(), String> {
    storage_workflows::delete(pool.inner(), &id).await
}

/// Start a workflow run. The frontend sends the full `WorkflowRecord`
/// (matching the `upsert` / `execute_command` convention of passing the
/// materialised record rather than re-fetching by id), so an unsaved
/// edit can be run without a round-trip through the DB. The referenced
/// commands ARE resolved from storage here: a node carries only a
/// `commandId`, and the engine needs the full `CommandRecord` (script,
/// shell, variables, …) to spawn it.
///
/// Returns the run id; graph progress arrives on the `workflow-event`
/// channel. A node whose `commandId` is not found in storage surfaces as
/// a `WorkflowError::UnknownCommand` from the engine (emitted as a
/// `workflowError` event), so we do not pre-validate here beyond loading
/// the table.
///
/// `node_variable_values` (camelCase `nodeVariableValues` on the wire)
/// carries the per-node variable values the frontend collected via
/// `resolveVariableValues` — spec defaults merged with the user's prompt
/// answers for any no-default variable. Each entry is keyed by node id
/// and handed to the engine, which substitutes it per command run. A
/// node with all-defaulted variables can be omitted from the map.
#[tauri::command]
pub async fn execute_workflow(
    app: AppHandle,
    executor_state: State<'_, Arc<ExecutorState>>,
    workflow_state: State<'_, Arc<WorkflowExecutorState>>,
    pool: State<'_, DbPool>,
    workflow: storage_workflows::WorkflowRecord,
    node_variable_values: HashMap<String, BTreeMap<String, String>>,
) -> Result<String, String> {
    let commands = storage_commands::resolve_map(pool.inner()).await?;

    workflow::execute_workflow(
        app,
        executor_state.inner().clone(),
        workflow_state.inner().clone(),
        workflow,
        commands,
        node_variable_values,
        // A direct UI run always streams to the live console.
        false,
    )
    .await
}

/// Run a workflow STARTING FROM a specific node, seeding that node's input
/// with `seed_input` (the editor's "example input" for the node — a prior
/// run's capture, a manual sample, or `null` when empty). The node and every
/// downstream node execute and stream the same per-node events as a full run,
/// so the editor recomputes their input/output previews. Cancellation reuses
/// `cancel_workflow` with the returned run id.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn run_workflow_from_node(
    app: AppHandle,
    executor_state: State<'_, Arc<ExecutorState>>,
    workflow_state: State<'_, Arc<WorkflowExecutorState>>,
    pool: State<'_, DbPool>,
    workflow: storage_workflows::WorkflowRecord,
    node_variable_values: HashMap<String, BTreeMap<String, String>>,
    start_node_id: String,
    seed_input: Option<String>,
) -> Result<String, String> {
    let commands = storage_commands::resolve_map(pool.inner()).await?;

    workflow::execute_workflow_from(
        app,
        executor_state.inner().clone(),
        workflow_state.inner().clone(),
        workflow,
        commands,
        node_variable_values,
        start_node_id,
        seed_input,
    )
    .await
}

#[tauri::command]
pub async fn cancel_workflow(
    workflow_state: State<'_, Arc<WorkflowExecutorState>>,
    run_id: String,
) -> Result<(), String> {
    workflow::cancel_workflow(workflow_state.inner().clone(), run_id).await
}

// ----------------------------------------------------------------------
// Scheduler (cron) commands — v0.2.0.
//
// Schedules fire commands / workflows automatically while the app is
// running (see core::scheduler). Every mutation signals the running loop to
// reload so the change takes effect immediately. Schedules are deliberately
// NOT part of export/import — they are local to a machine's clock.
// ----------------------------------------------------------------------

#[tauri::command]
pub async fn list_schedules(
    pool: State<'_, DbPool>,
) -> Result<Vec<storage_schedules::ScheduleRecord>, String> {
    storage_schedules::list_all(pool.inner()).await
}

/// Insert-or-update a schedule. The cron expression is validated before any
/// write (returns `INVALID_CRON` on a syntax error). After a successful write
/// the running scheduler loop is signalled to reload so the change is picked
/// up immediately.
/// Collect the names of every `sensitive` variable declared by the command
/// `command_id`. Used by `upsert_schedule` to tell the storage layer which
/// scheduled values to move into the OS keychain. A missing command (or a load
/// failure) yields an empty set — the upsert then persists nothing as a secret,
/// which is the safe default (no value is wrongly treated as secret, and the
/// command-not-found case surfaces later as a `missingVariable`/error fire).
async fn resolve_sensitive_var_names(
    pool: &DbPool,
    command_id: &str,
) -> std::collections::BTreeSet<String> {
    let Ok(commands) = storage_commands::list_all(pool).await else {
        return std::collections::BTreeSet::new();
    };
    commands
        .into_iter()
        .find(|c| c.id == command_id)
        .map(|c| {
            c.variables
                .iter()
                .filter(|spec| spec.sensitive)
                .map(|spec| spec.name.clone())
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn upsert_schedule(
    pool: State<'_, DbPool>,
    scheduler_state: State<'_, Arc<SchedulerState>>,
    schedule: storage_schedules::ScheduleRecord,
) -> Result<(), String> {
    // Validate the cron expression up front so a bad value never reaches the
    // table (where the loop would silently skip it).
    scheduler::cron_spec::validate(&schedule.cron).map_err(|_| "INVALID_CRON".to_string())?;

    // Resolve which of the target command's variables are `sensitive` so the
    // storage layer can move their values into the OS keychain instead of
    // persisting them as plaintext in the `variable_values` JSON column. Only
    // applies to `command` targets — workflow targets do not flow sensitive
    // schedule prompts in v1 (the nested value shape has no single command spec
    // to consult), so they pass an empty set and round-trip unchanged.
    let sensitive_vars = if schedule.target_kind == "command" {
        resolve_sensitive_var_names(pool.inner(), &schedule.target_id).await
    } else {
        std::collections::BTreeSet::new()
    };

    storage_schedules::upsert(pool.inner(), &schedule, &sensitive_vars).await?;
    // The record carries the frontend's (now stale) `next_run_at`; recompute it
    // from the just-saved cron so the schedule tile's cached display value
    // reflects the edit instead of the old time.
    scheduler::recompute_next_run(pool.inner(), &schedule).await?;
    scheduler_state.inner().signal_reload();
    Ok(())
}

#[tauri::command]
pub async fn delete_schedule(
    pool: State<'_, DbPool>,
    scheduler_state: State<'_, Arc<SchedulerState>>,
    id: String,
) -> Result<(), String> {
    storage_schedules::delete(pool.inner(), &id).await?;
    scheduler_state.inner().signal_reload();
    Ok(())
}

/// Toggle a schedule's `enabled` flag. The frontend supplies `updated_at`
/// (matching the JS-owned timestamp convention). Reloads the loop so an
/// enabled schedule starts firing (or a disabled one stops) immediately.
#[tauri::command]
pub async fn set_schedule_enabled(
    pool: State<'_, DbPool>,
    scheduler_state: State<'_, Arc<SchedulerState>>,
    id: String,
    enabled: bool,
    updated_at: String,
) -> Result<(), String> {
    storage_schedules::set_enabled(pool.inner(), &id, enabled, &updated_at).await?;
    // Refresh the cached `next_run_at` so the tile reflects the new state:
    // disabling clears it (shows "never"); enabling recomputes the next fire.
    scheduler::recompute_next_run_by_id(pool.inner(), &id).await?;
    scheduler_state.inner().signal_reload();
    Ok(())
}

/// Manually fire a schedule's target NOW, out of band. Runs through the same
/// headless fire path as a cron tick (honouring timeout / retries / stored
/// variables) and records a `scheduledRun` history event, but does NOT touch
/// the schedule's stats or `next_run_at` — the cron timing is unaffected.
#[tauri::command]
pub async fn run_schedule_now(
    app: AppHandle,
    executor_state: State<'_, Arc<ExecutorState>>,
    workflow_state: State<'_, Arc<WorkflowExecutorState>>,
    pool: State<'_, DbPool>,
    id: String,
) -> Result<(), String> {
    scheduler::run_now(
        &app,
        pool.inner(),
        executor_state.inner(),
        workflow_state.inner(),
        &id,
    )
    .await
}

/// Preview the next `count` fire times for a cron expression WITHOUT saving
/// anything. Drives the live preview in the schedule form. Returns the
/// times as RFC 3339 local-time strings, or `INVALID_CRON` when the
/// expression does not parse.
#[tauri::command]
pub fn preview_next_runs(cron: String, count: u32) -> Result<Vec<String>, String> {
    scheduler::cron_spec::validate(&cron).map_err(|_| "INVALID_CRON".to_string())?;
    let count = count.clamp(1, 20) as usize;
    let mut out = Vec::with_capacity(count);
    let mut cursor = chrono::Local::now();
    for _ in 0..count {
        match scheduler::cron_spec::next_after(&cron, &cursor) {
            Ok(Some(next)) => {
                out.push(next.to_rfc3339());
                cursor = next;
            }
            // No further occurrences (e.g. a one-off year in the past) —
            // stop early rather than erroring.
            Ok(None) => break,
            Err(_) => return Err("INVALID_CRON".to_string()),
        }
    }
    Ok(out)
}

/// Returns the list of shell identifiers (matching the JS `Shell` union)
/// that resolve to an executable on the host PATH. The CRUD form on the
/// frontend uses this to filter the shell dropdown so users can't pick a
/// binary their system doesn't have.
#[tauri::command]
pub fn get_available_shells() -> Vec<String> {
    shells::detect_available_shells()
}

/// Fetch best-effort CLI help for `utility` so the CommandForm can show a
/// flag-hint tooltip beside the script field. The frontend extracts the
/// leading utility name from the script and validates it before calling;
/// the backend re-validates and only ever runs `<utility> --help` / `-h`
/// / `man` (never a shell). See `core::utility_help` for the security
/// model. An absent / unrecognised utility returns a `NotFound` result
/// rather than an error.
#[tauri::command]
pub async fn fetch_utility_help(
    utility: String,
) -> Result<crate::core::utility_help::UtilityHelp, String> {
    crate::core::utility_help::fetch_help(utility).await
}

/// Parse structured flag / positional-argument metadata from the raw
/// `--help` output of a utility. Fetches help text via `fetch_help`
/// (same security model and probes as `fetch_utility_help`) and runs the
/// heuristic `flag_parser::parse_flags` over it.
///
/// Returns an empty `ParsedCli` when the utility is not found or its help
/// text cannot be parsed — the frontend treats this as "no pre-fill
/// available" and falls back to the plain script editor.
#[tauri::command]
pub async fn parse_utility_flags(
    utility: String,
) -> Result<crate::core::flag_parser::ParsedCli, String> {
    let help = crate::core::utility_help::fetch_help(utility).await?;
    if help.status == crate::core::utility_help::UtilityHelpStatus::NotFound {
        return Ok(crate::core::flag_parser::ParsedCli {
            positional_args: vec![],
            flags: vec![],
        });
    }
    let text = help.text.unwrap_or_default();
    Ok(crate::core::flag_parser::parse_flags(&text))
}

/// Preview the result of running an output schema against a sample of
/// stdout, WITHOUT executing any command. The OutputSchemaEditor calls
/// this so the user can see the extracted fields / return value live as
/// they edit the schema. Parsing happens in the authoritative
/// `core::extractor` — the TS side never re-implements it.
///
/// Mirrors the `result` execution-event payload: on success `error` is
/// `None` and `fields` / `return_value` are populated; on a schema /
/// parse failure `error` carries the message and the other fields are
/// empty (the editor shows the error inline).
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewExtractionResult {
    pub fields: serde_json::Value,
    pub return_value: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[tauri::command]
pub fn preview_extraction(
    schema: storage_commands::OutputSchemaRecord,
    sample_stdout: String,
) -> PreviewExtractionResult {
    match crate::core::extractor::extract(&schema, &sample_stdout) {
        Ok(out) => PreviewExtractionResult {
            fields: serde_json::to_value(&out.fields).unwrap_or(serde_json::Value::Null),
            return_value: out.return_value,
            error: None,
        },
        Err(e) => PreviewExtractionResult {
            fields: serde_json::json!({}),
            return_value: serde_json::Value::Null,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub fn get_platform() -> String {
    if cfg!(target_os = "linux") {
        "linux".to_string()
    } else if cfg!(target_os = "macos") {
        "macos".to_string()
    } else if cfg!(target_os = "windows") {
        "windows".to_string()
    } else {
        "unknown".to_string()
    }
}

// ----------------------------------------------------------------------
// Admin-password commands.
//
// These three commands manage the sudo password used by the "Run as
// administrator" feature on Unix. They never echo the password back to
// the frontend — only a boolean status is queryable. The password is
// stored in the OS keychain via `security::admin_password`, NEVER in
// SQLite or any Tauri-emitted event.
//
// On Windows the elevation path is UAC and these commands are still
// callable (they manage the same keychain entry), but no current
// platform UI invokes them. Tests cover only the empty-password
// boundary check; round-trip behavior is validated by manual QA
// against the real OS keychain (see security::admin_password tests
// for the rationale).
// ----------------------------------------------------------------------

/// Returns `true` if a sudo password is currently stored in the OS
/// keychain. Used by the Settings UI to decide between "Set password"
/// and "Clear saved password", and by the CommandForm to decide
/// whether to show the "you'll be asked on first run" hint.
#[tauri::command]
pub fn admin_password_status() -> Result<bool, String> {
    admin_password::has().map_err(|e| e.to_string())
}

/// Persist the given sudo password. The password is trimmed of
/// leading/trailing whitespace because a stray newline from a paste
/// would make sudo reject every subsequent run. Empty strings (after
/// trimming) are rejected with a typed error rather than silently
/// stored — sudo would reject them too, and storing one would create
/// an "I can't log in any more" mystery for the user.
#[tauri::command]
pub fn set_admin_password(password: String) -> Result<(), String> {
    let trimmed = password.trim();
    if trimmed.is_empty() {
        return Err("password cannot be empty".to_string());
    }
    admin_password::set(trimmed).map_err(|e| e.to_string())
}

/// Remove the stored sudo password. Idempotent — calling it when
/// nothing is stored is not an error, so the UI can call it
/// unconditionally without first reading the status.
#[tauri::command]
pub fn clear_admin_password() -> Result<(), String> {
    admin_password::clear().map_err(|e| e.to_string())
}

// ----------------------------------------------------------------------
// Built-in HTTP server commands (v0.10.0).
//
// Manage the optional REST API server and its keychain-backed Bearer token.
// The token VALUE crosses IPC only ONCE — as the return of
// `regenerate_api_token` (for display/copy). Status queries return only a
// boolean; the auth middleware reads the value in-process. See
// `core::http_server` and docs/http-server.md.
// ----------------------------------------------------------------------

/// Live status of the HTTP server: whether it is running, the bind it was
/// started with, and the addresses other machines can reach it at. Read by the
/// header mini-panel.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpServerStatus {
    pub running: bool,
    pub port: u16,
    pub bind_lan: bool,
    /// The `procmix.local` mDNS hostname (without trailing dot) when the server
    /// is running and an mDNS announcement is active; `None` otherwise. The UI
    /// shows `http://{mdnsHost}:{port}` as the friendly LAN address.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mdns_host: Option<String>,
    /// The machine's LAN IPv4 (e.g. `192.168.1.42`) when running and detected;
    /// `None` otherwise. The UI shows `http://{lanAddress}:{port}` as a reliable
    /// fallback for networks where mDNS is filtered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lan_address: Option<String>,
}

#[tauri::command]
pub async fn http_server_status(
    state: State<'_, Arc<HttpServerState>>,
    pool: State<'_, DbPool>,
) -> Result<HttpServerStatus, String> {
    let running = state.is_running().await;
    // When running, report the LIVE bind; otherwise reflect the persisted
    // config so the UI shows what a start would use.
    let cfg = match state.running_config().await {
        Some(cfg) => cfg,
        None => storage_http_server::load(pool.inner()).await?,
    };
    // The LAN address + mDNS hostname are only meaningful while running and only
    // when a LAN IP was detected (mDNS is announced on that IP). The hostname is
    // reported without its trailing dot for display.
    let lan_ip = if running { state.lan_ip().await } else { None };
    let lan_address = lan_ip.map(|ip| ip.to_string());
    let mdns_host = lan_ip.map(|_| {
        http_server::mdns::MDNS_HOSTNAME
            .trim_end_matches('.')
            .to_string()
    });
    Ok(HttpServerStatus {
        running,
        port: cfg.port,
        bind_lan: cfg.bind_lan,
        mdns_host,
        lan_address,
    })
}

/// Start the server using the persisted config. A bind failure (e.g.
/// `PORT_IN_USE`) surfaces as a typed error string.
#[tauri::command]
pub async fn start_http_server(
    app: AppHandle,
    state: State<'_, Arc<HttpServerState>>,
    pool: State<'_, DbPool>,
) -> Result<(), String> {
    let cfg = storage_http_server::load(pool.inner()).await?;
    http_server::start(&app, state.inner(), cfg).await
}

/// Stop the server. Idempotent.
#[tauri::command]
pub async fn stop_http_server(state: State<'_, Arc<HttpServerState>>) -> Result<(), String> {
    http_server::stop(state.inner()).await;
    Ok(())
}

/// Read the persisted server config (token excluded — it is keychain-only).
#[tauri::command]
pub async fn get_http_server_config(
    pool: State<'_, DbPool>,
) -> Result<storage_http_server::HttpServerConfig, String> {
    storage_http_server::load(pool.inner()).await
}

/// Persist a new server config and reconcile the LIVE server.
///
/// The reconcile decision is based on whether the server is ACTUALLY running
/// right now — not on the persisted `enabled` flag, which only records the
/// autostart intent for the next launch and can diverge from reality (the user
/// may have started/stopped the server manually from the panel without flipping
/// `enabled`). So:
///   - currently running → restart with the new config (`start` stops the old
///     instance first), making a port / bind / console-log change take effect
///     immediately without a manual stop+start;
///   - currently stopped → only persist; a settings edit must not silently
///     spin up a server the user had stopped.
///
/// The port is validated before the DB write (an invalid port returns
/// `INVALID_PORT:` and the row is untouched).
#[tauri::command]
pub async fn set_http_server_config(
    app: AppHandle,
    state: State<'_, Arc<HttpServerState>>,
    pool: State<'_, DbPool>,
    config: storage_http_server::HttpServerConfig,
) -> Result<(), String> {
    storage_http_server::save(pool.inner(), &config).await?;
    if state.is_running().await {
        // Auto-restart on the new config. `start` stops the running instance
        // first, so this is an atomic restart that picks up the new port/bind/
        // console-log setting.
        http_server::start(&app, state.inner(), config).await?;
    }
    Ok(())
}

/// Whether an API token is currently stored.
#[tauri::command]
pub fn api_token_status() -> Result<bool, String> {
    api_token::has().map_err(|e| e.to_string())
}

/// Generate a fresh API token, store it, and return the plaintext value ONCE
/// for the UI to display/copy. Overwrites any existing token.
#[tauri::command]
pub fn regenerate_api_token() -> Result<String, String> {
    api_token::generate().map_err(|e| e.to_string())
}

/// Remove the stored API token. Idempotent.
#[tauri::command]
pub fn clear_api_token() -> Result<(), String> {
    api_token::clear().map_err(|e| e.to_string())
}

/// Snapshot the in-memory request log (most-recent requests) for the live UI.
#[tauri::command]
pub async fn list_request_log(
    state: State<'_, Arc<HttpServerState>>,
) -> Result<Vec<http_server::log::RequestLogEntry>, String> {
    Ok(state.request_log.snapshot())
}

/// Clear the in-memory request log shown in the panel. The persistent
/// `http-server.log` file (audit trail) is intentionally left untouched.
#[tauri::command]
pub async fn clear_request_log(state: State<'_, Arc<HttpServerState>>) -> Result<(), String> {
    state.request_log.clear();
    Ok(())
}

// ----------------------------------------------------------------------
// Process Capture commands.
//
// Control the background "command recorder" (see `docs/process-capture.md`).
// `WatcherState` lives in app state alongside `ExecutorState`. The watcher
// emits captured process starts on the `capture-event` channel; the raw
// capture stream is ephemeral on the frontend and is never persisted here.
//
// The frontend must only call `start_process_capture` AFTER the user has
// granted one-time consent (`processCaptureEnabled`) — that gate lives in
// the TS layer (`resolveCaptureConsent`). On non-Windows, `start` returns
// the `CAPTURE_UNSUPPORTED` sentinel so the UI can hide the feature.
// ----------------------------------------------------------------------

/// Start observing process births and emitting `capture-event`s, constrained
/// to `scope` (defaults to [`CaptureScope::All`] when omitted, preserving the
/// pre-scoping behaviour). Idempotent; returns `Err("CAPTURE_UNSUPPORTED")` on
/// platforms without a backend, `Err("CAPTURE_REQUIRES_PRIVILEGE")` when the
/// Linux proc connector needs `CAP_NET_ADMIN`.
///
/// Not license-gated: Process Capture (Recorder) is available in every tier,
/// including Basic. It is still gated by one-time user consent in the TS layer
/// (`resolveCaptureConsent`) and by platform support.
#[tauri::command]
pub async fn start_process_capture(
    app: AppHandle,
    state: State<'_, Arc<WatcherState>>,
    scope: Option<CaptureScope>,
) -> Result<(), String> {
    process_watch::start(
        app,
        state.inner().clone(),
        scope.unwrap_or(CaptureScope::All),
    )
    .await
}

/// Stop an in-flight capture session. Idempotent.
#[tauri::command]
pub async fn stop_process_capture(state: State<'_, Arc<WatcherState>>) -> Result<(), String> {
    process_watch::stop(state.inner().clone()).await
}

/// Whether a capture session is currently running.
#[tauri::command]
pub async fn process_capture_status(state: State<'_, Arc<WatcherState>>) -> Result<bool, String> {
    Ok(state.inner().is_running().await)
}

/// List processes the user can scope capture to (the "record this app and its
/// children" picker). Returns an empty list on platforms whose target
/// enumeration is not yet implemented. Run off the async runtime: the `/proc`
/// walk is blocking IO.
#[tauri::command]
pub async fn list_capture_targets() -> Result<Vec<process_watch::CaptureTarget>, String> {
    tokio::task::spawn_blocking(process_watch::list_targets)
        .await
        .map_err(|e| format!("failed to enumerate capture targets: {e}"))
}

// ----------------------------------------------------------------------
// History commands.
//
// All six handlers wrap the corresponding `storage::history` function.
// IPC payload shapes are defined by the serde-derived structs in
// `storage::history`; the wire-format tests in that module lock the
// camelCase contract on both directions. UI callers go through
// `src/utils/historyRepository.ts` rather than `invoke()` directly.
// ----------------------------------------------------------------------

/// Page through history events. Empty/missing filter fields mean "no
/// constraint". Returns a `HistoryPage` containing the page items, the
/// total matching-row count for the paginator, and the resolved page +
/// page_size after clamping.
#[tauri::command]
pub async fn list_history(
    pool: State<'_, DbPool>,
    filter: storage_history::HistoryFilter,
    page: u32,
    page_size: u32,
) -> Result<storage_history::HistoryPage, String> {
    storage_history::list_paginated(pool.inner(), &filter, page, page_size).await
}

/// Fetch a single event by id. Used by undo/restore — the UI knows the
/// id of the source event and needs only the snapshot.
#[tauri::command]
pub async fn get_history_event(
    pool: State<'_, DbPool>,
    id: String,
) -> Result<Option<storage_history::HistoryEvent>, String> {
    storage_history::get_by_id(pool.inner(), &id).await
}

/// Persist a new event. The caller (frontend) generates `id` and
/// `createdAt` — same convention used by `upsert_command`. Returns the
/// id back so the caller has a single source of truth in case it wants
/// to display the freshly-inserted row.
#[tauri::command]
pub async fn record_history_event(
    pool: State<'_, DbPool>,
    event: storage_history::HistoryEvent,
) -> Result<String, String> {
    let id = event.id.clone();
    storage_history::insert_event(pool.inner(), &event).await?;
    Ok(id)
}

/// Update an in-flight `command_run` / `workflow_run` event with the final
/// outcome. Called by `useExecutionBridge` / `useWorkflowBridge` when a run
/// reaches a terminal state. `output` / `result` carry the captured aggregate
/// console output and any structured extraction so the History view can replay
/// a finished run (bounded by `MAX_HISTORY_OUTPUT_BYTES` in the storage layer).
/// A missing `execution_id` is a no-op (see the storage-layer docstring).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_run_history_event(
    pool: State<'_, DbPool>,
    execution_id: String,
    exit_code: Option<i32>,
    duration_ms: Option<u64>,
    status: storage_history::RunStatus,
    timed_out: Option<bool>,
    output: Option<Vec<storage_history::HistoryLogLine>>,
    result: Option<storage_history::HistoryExtractedResult>,
) -> Result<(), String> {
    storage_history::update_run_event(
        pool.inner(),
        &execution_id,
        exit_code,
        duration_ms,
        status,
        timed_out,
        output,
        result,
    )
    .await
}

/// Delete a single event by id. Idempotent.
#[tauri::command]
pub async fn delete_history_event(pool: State<'_, DbPool>, id: String) -> Result<(), String> {
    storage_history::delete(pool.inner(), &id).await
}

/// Drop history rows. Backs the "Clear history" UI action. The UI computes
/// an ISO-8601 cutoff from the chosen range and passes exactly one bound:
///
///   * `after = Some(iso)`  → delete rows AT OR NEWER than the cutoff
///     (`created_at >= after`). Used by the recency-window options
///     (last hour / today / last week) which clear the most recent records.
///   * `before = Some(iso)` → delete rows OLDER than the cutoff
///     (`created_at < before`). Used by "older than N days".
///   * both `None`          → clear the whole table ("all time").
///
/// `after` takes precedence if both are somehow set.
#[tauri::command]
pub async fn clear_history(
    pool: State<'_, DbPool>,
    after: Option<String>,
    before: Option<String>,
) -> Result<(), String> {
    match (after, before) {
        (Some(cutoff), _) => storage_history::clear_after(pool.inner(), &cutoff).await,
        (None, Some(cutoff)) => storage_history::clear_before(pool.inner(), &cutoff).await,
        (None, None) => storage_history::clear_all(pool.inner()).await,
    }
}

// ----------------------------------------------------------------------
// Import / Export.
//
// The JSON envelope is built, parsed and validated entirely in the TS
// layer (`utils/dataTransfer.ts`), where the `Command` / `Workflow` app
// types and their repositories already live. Rust's only job here is the
// native file dialog + raw file IO — it treats the document as an opaque
// String so the DTO shapes are never duplicated across the boundary.
//
// `rfd`'s dialog API is blocking; we run it on the blocking pool via
// `spawn_blocking` so it does not stall the async command runtime.
// ----------------------------------------------------------------------

/// Open a native "save" dialog and write `payload` (a JSON document
/// already serialized by the frontend) to the chosen path.
///
/// Returns `Ok(true)` when the file was written, `Ok(false)` when the
/// user cancelled the dialog. Filesystem errors surface as `Err(String)`
/// — never silently swallowed.
#[tauri::command]
pub async fn export_data(payload: String) -> Result<bool, String> {
    let path = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .add_filter("JSON", &["json"])
            .set_file_name("procmix-export.json")
            .save_file()
    })
    .await
    .map_err(|e| format!("file dialog task failed: {e}"))?;

    let Some(path) = path else {
        return Ok(false);
    };

    tokio::task::spawn_blocking(move || std::fs::write(&path, payload.as_bytes()))
        .await
        .map_err(|e| format!("write task failed: {e}"))?
        .map_err(|e| format!("write export file: {e}"))?;

    Ok(true)
}

/// Return a snapshot of the current process's environment variables.
///
/// Used by the frontend to detect key conflicts: when a command declares a
/// `Command.env` entry whose key already exists in the process environment,
/// the UI shows a warning that the command's value will override the
/// inherited one. The returned map is a point-in-time snapshot — environment
/// variables do not change at runtime for a GUI app, so the frontend caches
/// the result.
#[tauri::command]
pub async fn get_process_env() -> Result<std::collections::HashMap<String, String>, String> {
    Ok(std::env::vars().collect())
}

// --------------------------------------------------------------------------
// Env-file manager commands.
//
// These expose a simple config-file–backed list of .env file paths and
// per-file read/write/delete operations. The list is stored as a JSON array
// in `<app_config_dir>/env-files.json`. File content is read/written on the
// filesystem using `std::fs` (synchronous, but wrapped in spawn_blocking so
// the async executor is not blocked).
// --------------------------------------------------------------------------

/// Return the list of .env file paths currently registered in the config.
#[tauri::command]
pub async fn list_env_files(app: AppHandle) -> Result<Vec<String>, String> {
    crate::storage::env_config::load_env_file_paths(&app).await
}

/// Add a .env file path to the config list. Returns the updated list.
///
/// Holds the process-wide config lock for the whole load→mutate→save cycle so
/// a concurrent `add_env_file` / `remove_env_file` cannot clobber this update.
#[tauri::command]
pub async fn add_env_file(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    let _guard = crate::storage::env_config::lock_config().await;
    let mut paths = crate::storage::env_config::load_env_file_paths(&app).await?;
    if !paths.contains(&path) {
        paths.push(path);
        crate::storage::env_config::save_env_file_paths(&app, &paths).await?;
    }
    Ok(paths)
}

/// Remove a .env file path from the config list. Returns the updated list.
///
/// Holds the process-wide config lock for the whole load→mutate→save cycle so
/// a concurrent `add_env_file` / `remove_env_file` cannot clobber this update.
#[tauri::command]
pub async fn remove_env_file(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    let _guard = crate::storage::env_config::lock_config().await;
    let mut paths = crate::storage::env_config::load_env_file_paths(&app).await?;
    paths.retain(|p| p != &path);
    crate::storage::env_config::save_env_file_paths(&app, &paths).await?;
    Ok(paths)
}

/// Parse a .env file and return its entries (key/value/line).
///
/// Returns a summary that always succeeds at the IPC level; parse errors
/// are reported inside `EnvFileSummary.error` so the UI can surface them
/// inline without a full command failure.
#[tauri::command]
pub async fn read_env_file(path: String) -> Result<crate::core::env_files::EnvFileSummary, String> {
    let path_clone = path.clone();
    let result = tokio::task::spawn_blocking(move || {
        crate::core::env_files::parse_dotenv_file(std::path::Path::new(&path_clone))
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?;

    match result {
        Ok(entries) => Ok(crate::core::env_files::EnvFileSummary {
            path,
            entries,
            error: None,
        }),
        Err(msg) => Ok(crate::core::env_files::EnvFileSummary {
            path,
            entries: vec![],
            error: Some(msg),
        }),
    }
}

/// Update (or append) a single KEY=VALUE entry in a .env file.
///
/// Line-based: finds the existing `KEY=…` line and replaces only the value
/// part; if the key is not found, appends `KEY=VALUE` at the end. Comment
/// lines and blank lines are preserved verbatim.
#[tauri::command]
pub async fn write_env_file_entry(path: String, key: String, value: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        crate::core::env_files::write_entry(std::path::Path::new(&path), &key, &value)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

/// Remove a KEY line from a .env file.
///
/// Finds the line that declares KEY and removes it. Comment lines and blank
/// lines are preserved verbatim. If the key is not found the file is
/// unchanged and `Ok(())` is returned.
#[tauri::command]
pub async fn delete_env_file_entry(path: String, key: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        crate::core::env_files::delete_entry(std::path::Path::new(&path), &key)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

/// Open a native «open file» dialog filtered to .env files and return the
/// chosen path, or `None` when the user cancels.
#[tauri::command]
pub async fn pick_env_file() -> Result<Option<String>, String> {
    let path = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .add_filter(".env files", &["env", ""])
            .pick_file()
    })
    .await
    .map_err(|e| format!("file dialog task failed: {e}"))?;

    Ok(path.map(|p| p.to_string_lossy().into_owned()))
}

// --------------------------------------------------------------------------
// "Environment" view: read-only snapshots with source detection.
//
// User snapshot is cheap (process env + reading a handful of small files) so
// it is computed on every call without caching at this layer — the frontend
// store handles UI-level memoisation. Root snapshot requires a stored admin
// password and reaches sudo, so the frontend gates the call behind
// `admin_password_status` (no surprise sudo prompts).
// --------------------------------------------------------------------------

/// Build the user-scope env snapshot: every variable in the current process
/// environment plus, for each known shell-startup file, the keys it assigns.
/// The result lets the UI render the "source" column without further IPC.
#[tauri::command]
pub async fn get_user_env_with_sources() -> Result<crate::core::env_sources::EnvSnapshot, String> {
    Ok(crate::core::env_sources::collect_user_snapshot().await)
}

/// Build the root-scope env snapshot. Requires a password stored in the OS
/// keychain (caller is expected to check `admin_password_status` first); when
/// none is stored we return an explicit `Err` so the UI can surface a "Enter
/// admin password" affordance rather than a generic IPC error.
///
/// The password is read from the keychain on this side and passed to a
/// `sudo -S env` invocation. The plaintext never leaves this function (the
/// IPC payload does NOT contain it), and the call times out so a hung sudo
/// cannot freeze the UI.
#[tauri::command]
pub async fn get_root_env_with_sources() -> Result<crate::core::env_sources::EnvSnapshot, String> {
    #[cfg(unix)]
    {
        let pw = match crate::security::admin_password::get() {
            Ok(Some(p)) => p,
            Ok(None) => return Err("ADMIN_PASSWORD_REQUIRED".to_string()),
            Err(e) => return Err(format!("keychain error: {e}")),
        };
        crate::core::env_sources::collect_root_snapshot(&pw).await
    }
    #[cfg(not(unix))]
    {
        Err("root snapshot is Unix-only".to_string())
    }
}

/// Open the Windows "System Properties → Environment Variables" dialog
/// (`SystemPropertiesAdvanced.exe`). On non-Windows this is a no-op that
/// returns `Ok(false)` so the frontend can hide the button when it would
/// have no effect.
#[tauri::command]
pub async fn open_windows_env_dialog() -> Result<bool, String> {
    #[cfg(windows)]
    {
        // We launch the system tool without arguments — it opens the
        // "System Properties" dialog, from which the user clicks
        // "Environment Variables…". A direct deep-link to the env page
        // does not exist in stable Windows APIs.
        match std::process::Command::new("SystemPropertiesAdvanced.exe").spawn() {
            Ok(_) => Ok(true),
            Err(e) => Err(format!("failed to launch SystemPropertiesAdvanced: {e}")),
        }
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

/// Open a native «open\" dialog and read the chosen JSON file into a
/// String for the frontend to parse + validate.
///
/// Returns `Ok(Some(contents))` when a file was read, `Ok(None)` when the
/// user cancelled. Read errors surface as `Err(String)`.
#[tauri::command]
pub async fn import_data() -> Result<Option<String>, String> {
    let path = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .add_filter("JSON", &["json"])
            .pick_file()
    })
    .await
    .map_err(|e| format!("file dialog task failed: {e}"))?;

    let Some(path) = path else {
        return Ok(None);
    };

    let contents = tokio::task::spawn_blocking(move || std::fs::read_to_string(&path))
        .await
        .map_err(|e| format!("read task failed: {e}"))?
        .map_err(|e| format!("read import file: {e}"))?;

    Ok(Some(contents))
}

// --------------------------------------------------------------------------
// "Environment" view → "Connections" tab: read-only SSH host inventory.
//
// Hosts are parsed read-only from their source of truth (`~/.ssh/config`, …)
// by `core::ssh`; ProcMix never writes connection parameters. The only
// ProcMix-owned state is the last reachability-check result, stored in
// `ssh_host_meta` and merged into the view here. The check spawns the system
// `ssh` in batch mode with a validated alias and a hard timeout (see
// `core::ssh::check`) — it never blocks on a prompt and is injection-safe.
// --------------------------------------------------------------------------

/// One host in the inventory view: the parsed connection plus ProcMix's
/// stored metadata (last check result). Mirrors `SshHostView` in
/// `src/types/sshHost.ts`.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostView {
    #[serde(flatten)]
    pub host: crate::core::ssh::SshHost,
    pub last_check_at: Option<String>,
    pub last_check_ok: Option<bool>,
}

/// The full inventory payload: connectable hosts (with merged metadata),
/// wildcard/pattern blocks (read-only "rules"), plus per-source status.
/// Mirrors `SshInventoryView` in `src/types/sshHost.ts`.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshInventoryView {
    pub hosts: Vec<SshHostView>,
    /// Pattern blocks (`Host *`, `*.example.com`, …) shown in a separate
    /// read-only section. Carried as `SshHostView` for a uniform wire shape;
    /// their `lastCheck*` are always null (patterns are never checked).
    pub patterns: Vec<SshHostView>,
    pub sources: Vec<crate::core::ssh::SshSourceStatus>,
}

/// Serializes all writes to `~/.ssh/config` and guards a read from observing
/// a half-applied edit. Held for the whole load→edit→commit cycle so two
/// concurrent `save`/`delete` calls cannot clobber each other, and a
/// `list_ssh_hosts` issued mid-write waits for the consistent result.
static SSH_WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Build the inventory view (parsed hosts + merged metadata + source status).
/// Shared by `list_ssh_hosts` and the write commands, which return the fresh
/// inventory after mutating so the UI updates without a second round-trip.
async fn build_inventory_view(pool: &DbPool) -> Result<SshInventoryView, String> {
    let inventory = tokio::task::spawn_blocking(crate::core::ssh::load_inventory)
        .await
        .map_err(|e| format!("ssh inventory task failed: {e}"))?;

    let meta = crate::storage::ssh_host_meta::load_all(pool).await?;

    let hosts = inventory
        .hosts
        .into_iter()
        .map(|host| {
            let m = meta.get(&host.id.key());
            SshHostView {
                last_check_at: m.and_then(|x| x.last_check_at.clone()),
                last_check_ok: m.and_then(|x| x.last_check_ok),
                host,
            }
        })
        .collect();

    // Patterns are never checked, so they carry no metadata — wrap with null
    // check fields for a uniform wire shape.
    let patterns = inventory
        .patterns
        .into_iter()
        .map(|host| SshHostView {
            last_check_at: None,
            last_check_ok: None,
            host,
        })
        .collect();

    Ok(SshInventoryView {
        hosts,
        patterns,
        sources: inventory.sources,
    })
}

/// List every SSH host discovered across all available sources, merged with
/// each host's stored last-check metadata.
///
/// The parse touches the filesystem (config + includes), so it runs on a
/// blocking pool. Metadata is read from SQLite and joined by the composite
/// host key. Always returns a definitive inventory; a per-source read failure
/// is reported inside `sources[].error`, never as a command error.
#[tauri::command]
pub async fn list_ssh_hosts(pool: State<'_, DbPool>) -> Result<SshInventoryView, String> {
    // Wait for any in-flight write so the list never reflects a half-edit.
    let _guard = SSH_WRITE_LOCK.lock().await;
    build_inventory_view(pool.inner()).await
}

/// Create or edit an editable SSH host in its source file, then return the
/// refreshed inventory.
///
/// Only writable sources (currently `open-ssh-config`) are accepted; a write
/// to a read-only source fails with a clear error. The actual file mutation
/// (validate → surgical edit → backup → atomic write → chmod) runs on a
/// blocking pool under the process-wide write lock.
#[tauri::command]
pub async fn save_ssh_host(
    pool: State<'_, DbPool>,
    watch_state: State<'_, std::sync::Arc<crate::core::ssh::SshWatchState>>,
    source: crate::core::ssh::SshSource,
    draft: crate::core::ssh::SshHostDraft,
) -> Result<SshInventoryView, String> {
    let _guard = SSH_WRITE_LOCK.lock().await;

    let writer = crate::core::ssh::writer_for(source)
        .ok_or_else(|| "this SSH source is read-only".to_string())?;

    // Capture the prior state (for the history "before" snapshot) before the
    // write. The locate alias is the previous name on a rename, else the name.
    let locate = draft
        .previous_name
        .clone()
        .filter(|p| *p != draft.name)
        .unwrap_or_else(|| draft.name.clone());
    let is_rename = draft
        .previous_name
        .as_deref()
        .is_some_and(|p| p != draft.name);
    let before = find_inventory_host(source, &locate).map(|h| ssh_history::snapshot_of(&h));

    let draft_for_write = draft.clone();
    tokio::task::spawn_blocking(move || writer.upsert_host(&draft_for_write))
        .await
        .map_err(|e| format!("ssh write task failed: {e}"))?
        .map_err(|e| e.to_string())?;

    // Record history (best-effort) from the freshly-written state.
    if let Some(after) = find_inventory_host(source, &draft.name) {
        match (is_rename, before) {
            (true, Some(before)) => ssh_history::record_rename(pool.inner(), before, &after).await,
            (_, before) => ssh_history::record_upsert(pool.inner(), before, &after).await,
        }
    }

    // Advance the watcher baseline to the post-write state so the watcher
    // doesn't re-log this same change as external (echo-suppression).
    let next = tokio::task::spawn_blocking(crate::core::ssh::current_snapshot_map)
        .await
        .map_err(|e| format!("ssh snapshot task failed: {e}"))?;
    watch_state.set_baseline(next).await;

    build_inventory_view(pool.inner()).await
}

/// Delete an editable SSH host from its source file, then return the refreshed
/// inventory. Removing a non-existent host is a success (idempotent).
#[tauri::command]
pub async fn delete_ssh_host(
    pool: State<'_, DbPool>,
    watch_state: State<'_, std::sync::Arc<crate::core::ssh::SshWatchState>>,
    source: crate::core::ssh::SshSource,
    alias: String,
) -> Result<SshInventoryView, String> {
    let _guard = SSH_WRITE_LOCK.lock().await;

    let writer = crate::core::ssh::writer_for(source)
        .ok_or_else(|| "this SSH source is read-only".to_string())?;

    // Snapshot before deleting, so history has the removed block.
    let before = find_inventory_host(source, &alias).map(|h| ssh_history::snapshot_of(&h));

    let alias_for_write = alias.clone();
    tokio::task::spawn_blocking(move || writer.delete_host(&alias_for_write))
        .await
        .map_err(|e| format!("ssh write task failed: {e}"))?
        .map_err(|e| e.to_string())?;

    // Only record if the host actually existed (deleting a ghost is a no-op).
    if let Some(before) = before {
        ssh_history::record_delete(pool.inner(), before).await;
    }

    // Echo-suppression: advance the watcher baseline to the post-delete state.
    let next = tokio::task::spawn_blocking(crate::core::ssh::current_snapshot_map)
        .await
        .map_err(|e| format!("ssh snapshot task failed: {e}"))?;
    watch_state.set_baseline(next).await;

    build_inventory_view(pool.inner()).await
}

/// Parse the current inventory and return the single host matching
/// `(source, name)`, if present. Used to snapshot a host's state for history
/// before/after a write. Runs the (blocking) parse synchronously — callers
/// already hold the write lock, and this is a one-off lookup.
fn find_inventory_host(
    source: crate::core::ssh::SshSource,
    name: &str,
) -> Option<crate::core::ssh::SshHost> {
    let inv = crate::core::ssh::load_inventory();
    inv.hosts
        .into_iter()
        .chain(inv.patterns)
        .find(|h| h.id.source == source && h.name == name)
}

/// Probe one host for reachability and persist the result.
///
/// `alias` is the `Host` name to connect to (validated and spawned safely by
/// `core::ssh::check`); `host_key` is the composite `"<source>:<name>"` key
/// under which the result is stored. Returns the check outcome for the UI to
/// render immediately. Never errors on an unreachable host — that is a
/// successful check with `reachable: false`.
#[tauri::command]
pub async fn check_ssh_host(
    pool: State<'_, DbPool>,
    alias: String,
    host_key: String,
) -> Result<crate::core::ssh::SshCheckResult, String> {
    let result = crate::core::ssh::check_alias(&alias).await;

    let at = chrono::Local::now().to_rfc3339();
    // Persisting the result is best-effort: a metadata-write failure must not
    // discard the answer the user just asked for. Surface the check result
    // regardless; the row simply stays stale.
    if let Err(e) =
        crate::storage::ssh_host_meta::record_check(pool.inner(), &host_key, result.reachable, &at)
            .await
    {
        tracing::error!("ssh: failed to persist check for {host_key}: {e}");
    }

    Ok(result)
}

// ----------------------------------------------------------------------
// Persistent SSH password commands (Phase 2).
//
// These three commands manage the OPTIONAL per-host SSH password used by
// password-authenticated remote runs, stored in the OS keychain via
// `security::ssh_password` (account `ssh-password:<alias>`). As with the
// admin-password commands, the value is NEVER echoed back to the frontend —
// only a boolean status is queryable (`has_ssh_password`). The actual `get`
// is consumed in-process by the `procmix-askpass` sidecar, never over IPC.
//
// The `alias` is user-derived (`~/.ssh/config`); `security::ssh_password`
// allow-list validates it with `core::ssh::is_safe_alias` on every call, so
// these commands stay thin and re-validation is centralized. Unix-only in
// practice (the spawn path ignores a remote password on Windows), but the
// commands compile and manage the same keychain entry everywhere.
// ----------------------------------------------------------------------

/// Returns `true` if a password is currently stored for `alias`. Used by the
/// command form's TargetSelector to toggle between "Set password" and
/// "Clear saved password" and to show the saved indicator.
#[tauri::command]
pub fn has_ssh_password(alias: String) -> Result<bool, String> {
    ssh_password::has(&alias).map_err(|e| e.to_string())
}

/// Persist `password` for `alias`. The password is trimmed because a stray
/// newline from a paste would make the askpass helper hand `ssh` a wrong
/// secret. An empty password (after trimming) is rejected with a typed error
/// rather than silently stored — `ssh` would hang on the prompt, and storing a
/// blank would create an "auth keeps failing" mystery. The alias is validated
/// inside `ssh_password::set`.
#[tauri::command]
pub fn set_ssh_password(alias: String, password: String) -> Result<(), String> {
    let trimmed = password.trim();
    if trimmed.is_empty() {
        return Err("password cannot be empty".to_string());
    }
    ssh_password::set(&alias, trimmed).map_err(|e| e.to_string())
}

/// Remove the stored password for `alias`. Idempotent — calling it when nothing
/// is stored is not an error, so the UI can call it unconditionally without
/// first checking the status.
#[tauri::command]
pub fn clear_ssh_password(alias: String) -> Result<(), String> {
    ssh_password::clear(&alias).map_err(|e| e.to_string())
}
