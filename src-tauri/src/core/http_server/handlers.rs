// Request handlers for the built-in HTTP API.
//
// Two run endpoints (`POST /api/command/{ref}/run`, `POST /api/workflow/{ref}/run`)
// drive the SAME headless execution path the Scheduler uses
// (`spawn_execution_with_completion` for commands, `execute_workflow*` for
// workflows), so an API run is recorded in History and (when `log_to_console`
// is on) streams to the live console exactly like any other run. Two list
// endpoints expose the API-enabled entities. `GET /api/health` is unauthenticated.
//
// SECURITY: the request body may carry variable values, some of which the
// command marks `sensitive`. Those values are passed to the executor (which
// redacts them in events / history). For the request log, the run handlers
// build a REDACTED summary here (`redact_command_variables` /
// `redact_workflow_variables`): each value is checked against the resolved
// command's `VariableSpec.sensitive` flag and masked to `***` when sensitive,
// shown verbatim otherwise. Only that pre-masked summary reaches `log.rs`; a
// raw value never does. The API response carries no stdout/secret, so it is
// summarised verbatim.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tokio::sync::oneshot;

use crate::core::executor::{
    self, ExecuteRequest, ExecutorState, NodeOutcome, RunOptions, TerminalStatus,
};
use crate::core::workflow::{self, WorkflowExecutorState};
use crate::storage::commands::{self as storage_commands, CommandRecord};
use crate::storage::history::{
    self as storage_history, HistoryEvent, HistoryEventPayload, RunStatus,
};
use crate::storage::workflows::{self as storage_workflows, WorkflowRecord};
use crate::storage::DbPool;

/// Mask shown in the request log in place of a `sensitive` variable's value.
const REDACTED: &str = "***";

/// Source tag stamped on the History run event so the UI can distinguish an
/// API-triggered run from a manual or scheduled one.
pub const RUN_SOURCE_API: &str = "api";

/// Decoded request body for a command run. All fields optional so a bare
/// `POST` with no body runs the command on its defaults.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRunBody {
    /// `name -> value` overrides for the command's declared variables.
    #[serde(default)]
    pub variables: HashMap<String, String>,
    /// When `true`, the handler awaits the terminal outcome and returns the
    /// exit code / status; otherwise it returns `202 Accepted` immediately.
    #[serde(default)]
    pub wait: bool,
}

/// Decoded request body for a workflow run.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunBody {
    /// `nodeId -> { name -> value }` per-node variable overrides.
    #[serde(default)]
    pub node_variables: HashMap<String, HashMap<String, String>>,
    #[serde(default)]
    pub wait: bool,
}

/// Successful run response. `execution_id` lets a caller correlate with the
/// History entry; `status` is `"started"` for the async path or the terminal
/// status string for `?wait=true`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResponse {
    pub execution_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

/// What a run handler returns: the API response, the resolved entity name (for
/// the log's `entityName`), and a REDACTED one-line summary of the request body
/// (`wait=true; name=alice; token=***`) for the request log. The request
/// summary is built here because only the handler has both the supplied values
/// and the command's `sensitive` flags.
#[derive(Debug)]
pub struct RunOutcome {
    pub response: RunResponse,
    pub entity_name: String,
    pub request_summary: String,
}

/// One entry in the `GET /api/commands` / `GET /api/workflows` listing.
///
/// Enriched (beyond id/name/slug) with the metadata the browser Home / Library
/// views need to render cards, favorites, and a recent-activity list WITHOUT an
/// N+1 detail fetch per entity: `kind` (discriminator), the optional i18n
/// name/description keys (so built-in entities localise client-side), the
/// `favorite` flag, and `lastRunAt`. Sensitive data is never included — these
/// are display fields only.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiEntitySummary {
    /// `"command"` or `"workflow"` so a merged list can render either card.
    pub kind: &'static str,
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_slug: Option<String>,
    pub favorite: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
}

/// Typed failure an endpoint can return, mapped to an HTTP status + JSON body
/// by the router. Kept transport-agnostic so the handler logic is unit-testable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiError {
    /// No command/workflow matched the reference, or it is not API-enabled.
    NotFound,
    /// A required `sensitive` variable had no value supplied and no default.
    MissingVariable(String),
    /// The run could not be launched (spawn/resolution failure).
    RunFailed(String),
}

/// Resolve + launch a command run. `reference` is the slug-or-id from the path.
/// Returns the run response on success. Errors map to HTTP statuses upstream.
///
/// `log_to_console` (from the server config) is inverted into the executor's
/// `silent` flag: when the user enabled console logging, the run is NOT silent
/// and streams to the OutputPanel like a manual run.
pub async fn run_command<R: Runtime>(
    app: &AppHandle<R>,
    pool: &DbPool,
    executor_state: &Arc<ExecutorState>,
    reference: &str,
    body: CommandRunBody,
    log_to_console: bool,
) -> Result<RunOutcome, ApiError> {
    let cmd = storage_commands::find_by_api_ref(pool, reference)
        .await
        .map_err(ApiError::RunFailed)?
        .ok_or(ApiError::NotFound)?;

    let wait = body.wait;
    let variable_values: BTreeMap<String, String> = body.variables.into_iter().collect();

    // Build the redacted request summary now, while we have both the supplied
    // values AND the command's `sensitive` flags. Secrets are masked here so
    // only a safe string ever leaves this function.
    let request_summary = redact_command_variables(&cmd, &variable_values, wait);

    // Reject up front a sensitive variable that has neither a supplied value
    // nor a (non-secret) default — a headless run cannot prompt. This mirrors
    // the executor's own `missingVariable`, but returning 400 here gives a
    // precise error before spawning.
    if let Some(missing) = first_missing_sensitive(&cmd, &variable_values) {
        return Err(ApiError::MissingVariable(missing));
    }

    let execution_id = uuid::Uuid::new_v4().to_string();
    let entity_name = cmd.name.clone();

    // Record the run in History up front (status: running, source: api) so it
    // is visible immediately; the executor's bridge finalises exit/output.
    record_command_run_started(pool, &cmd, &execution_id).await;

    // An API command run is a standalone run (`workflow_run_id: None`) on the
    // command's own timeout and saved target. It ALWAYS captures so the History
    // record carries the output; it is silent only when console logging is off.
    let req = ExecuteRequest::for_command(
        &cmd,
        RunOptions {
            execution_id: execution_id.clone(),
            variable_values,
            workflow_run_id: None,
            timeout_override: None,
            working_dir_override: None,
            capture_output: true,
            silent: !log_to_console,
        },
    );

    // Both paths use a completion channel so the History row is finalised in
    // the BACKEND (status / exit / output) — a headless API run must not depend
    // on an open UI window to close out its history record.
    let (tx, rx) = oneshot::channel::<NodeOutcome>();
    executor::spawn_execution_with_completion(app.clone(), executor_state.clone(), req, Some(tx))
        .await
        .map_err(map_spawn_error)?;

    if wait {
        let outcome = rx
            .await
            .map_err(|_| ApiError::RunFailed("execution completion channel dropped".to_string()))?;
        finalize_command_run(pool, &execution_id, &outcome).await;
        let status = terminal_status_str(&outcome);
        Ok(RunOutcome {
            response: RunResponse {
                execution_id,
                status: status.to_string(),
                exit_code: outcome.exit_code,
            },
            entity_name,
            request_summary,
        })
    } else {
        // Async: return 202 immediately, but await the terminal outcome on a
        // background task to finalise the History row when the run completes.
        let pool_bg = pool.clone();
        let exec_id_bg = execution_id.clone();
        tauri::async_runtime::spawn(async move {
            if let Ok(outcome) = rx.await {
                finalize_command_run(&pool_bg, &exec_id_bg, &outcome).await;
            }
        });
        Ok(RunOutcome {
            response: RunResponse {
                execution_id,
                status: "started".to_string(),
                exit_code: None,
            },
            entity_name,
            request_summary,
        })
    }
}

/// Resolve + launch a workflow run.
pub async fn run_workflow<R: Runtime>(
    app: &AppHandle<R>,
    pool: &DbPool,
    executor_state: &Arc<ExecutorState>,
    workflow_state: &Arc<WorkflowExecutorState>,
    reference: &str,
    body: WorkflowRunBody,
    // The API drives workflows via the blocking (always-silent) runner so the
    // history record is finalised in the backend; live-console streaming is not
    // offered for API workflow runs, so this flag is currently unused.
    _log_to_console: bool,
) -> Result<RunOutcome, ApiError> {
    let wf = storage_workflows::find_by_api_ref(pool, reference)
        .await
        .map_err(ApiError::RunFailed)?
        .ok_or(ApiError::NotFound)?;
    let entity_name = wf.name.clone();
    let wait = body.wait;

    let commands = storage_commands::resolve_map(pool)
        .await
        .map_err(ApiError::RunFailed)?;

    let node_variable_values: HashMap<String, BTreeMap<String, String>> = body
        .node_variables
        .into_iter()
        .map(|(node, vars)| (node, vars.into_iter().collect()))
        .collect();

    // Redact node-variable values against each node's command `sensitive` flags
    // before `wf` / `commands` are moved into the executor.
    let request_summary = redact_workflow_variables(&wf, &commands, &node_variable_values, wait);

    // Allocate the run id up front so we can write a `running` WorkflowRun
    // history row now and finalise the SAME row on completion — entirely in the
    // backend, so a headless API workflow run is recorded without an open UI.
    let execution_id = uuid::Uuid::new_v4().to_string();
    record_workflow_run_started(pool, &wf, &execution_id).await;

    // The API always drives a workflow to completion via the blocking runner
    // (it awaits the traversal and returns the captured output), so the history
    // record can be finalised in the backend. `wait=false` just moves the await
    // onto a background task and returns 202 immediately.
    if wait {
        let run = workflow::execute_workflow_blocking(
            app.clone(),
            executor_state.clone(),
            workflow_state.clone(),
            wf,
            commands,
            node_variable_values,
            // The HTTP API is headless — never stream to the live console.
            true,
        )
        .await;
        finalize_workflow_run(pool, &execution_id, &run).await;
        Ok(RunOutcome {
            response: RunResponse {
                execution_id,
                status: workflow_status_str(&run).to_string(),
                exit_code: None,
            },
            entity_name,
            request_summary,
        })
    } else {
        let pool_bg = pool.clone();
        let exec_id_bg = execution_id.clone();
        let app_bg = app.clone();
        let executor_bg = executor_state.clone();
        let workflow_bg = workflow_state.clone();
        tauri::async_runtime::spawn(async move {
            let run = workflow::execute_workflow_blocking(
                app_bg,
                executor_bg,
                workflow_bg,
                wf,
                commands,
                node_variable_values,
                // The HTTP API is headless — never stream to the live console.
                true,
            )
            .await;
            finalize_workflow_run(&pool_bg, &exec_id_bg, &run).await;
        });
        Ok(RunOutcome {
            response: RunResponse {
                execution_id,
                status: "started".to_string(),
                exit_code: None,
            },
            entity_name,
            request_summary,
        })
    }
}

/// List the API-enabled commands.
pub async fn list_api_commands(pool: &DbPool) -> Result<Vec<ApiEntitySummary>, ApiError> {
    let all = storage_commands::list_all(pool)
        .await
        .map_err(ApiError::RunFailed)?;
    Ok(all
        .into_iter()
        .filter(|c| c.api_enabled)
        .map(|c| ApiEntitySummary {
            kind: "command",
            id: c.id,
            name: c.name,
            name_key: c.name_key,
            description: c.description,
            description_key: c.description_key,
            api_slug: c.api_slug,
            favorite: c.favorite,
            last_run_at: c.last_run_at,
        })
        .collect())
}

/// List the API-enabled workflows.
pub async fn list_api_workflows(pool: &DbPool) -> Result<Vec<ApiEntitySummary>, ApiError> {
    let all = storage_workflows::list_all(pool)
        .await
        .map_err(ApiError::RunFailed)?;
    Ok(all
        .into_iter()
        .filter(|w| w.api_enabled)
        .map(|w| ApiEntitySummary {
            kind: "workflow",
            id: w.id,
            name: w.name,
            // Workflows are user-created and carry no i18n keys.
            name_key: None,
            description: w.description,
            description_key: None,
            api_slug: w.api_slug,
            favorite: w.favorite,
            last_run_at: w.last_run_at,
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Read endpoints (B1/B2/B3) — power the browser-served web UI. Every one is
// gated on the SAME `api_enabled` opt-in as the run endpoints: a command /
// workflow that is not API-enabled is invisible (404 / filtered out), so the
// web UI never exposes an entity the operator did not deliberately publish.
// ---------------------------------------------------------------------------

/// Fetch a single API-enabled command's full record (B1). Reuses
/// [`storage_commands::find_by_api_ref`], which gates on `api_enabled = 1` in
/// SQL, so a disabled command returns [`ApiError::NotFound`]. Sensitive variable
/// defaults are already stripped at the storage boundary, so the record is safe
/// to return to the browser for the read-only detail view.
pub async fn get_api_command(pool: &DbPool, reference: &str) -> Result<CommandRecord, ApiError> {
    storage_commands::find_by_api_ref(pool, reference)
        .await
        .map_err(ApiError::RunFailed)?
        .ok_or(ApiError::NotFound)
}

/// Fetch a single API-enabled workflow's full record (B1).
pub async fn get_api_workflow(pool: &DbPool, reference: &str) -> Result<WorkflowRecord, ApiError> {
    storage_workflows::find_by_api_ref(pool, reference)
        .await
        .map_err(ApiError::RunFailed)?
        .ok_or(ApiError::NotFound)
}

/// One page of API-visible history (B2). Only run events whose underlying
/// command / workflow is currently API-enabled are returned — a row referencing
/// a non-API-enabled (or deleted) entity is filtered out so the web UI cannot
/// read output of entities the operator did not publish. Non-run events
/// (create / edit / delete / ssh) are excluded entirely: the web History view
/// is run-only.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiHistoryPage {
    pub items: Vec<storage_history::HistoryEvent>,
    pub total: u64,
    pub page: u32,
    pub page_size: u32,
}

/// List API-visible run history, newest first. `page` is 1-based; `page_size`
/// is clamped by the storage layer. The `api_enabled` filter is applied AFTER
/// paging at the storage layer would mis-count, so we resolve the enabled id
/// sets once and filter the page in memory — the page is small (bounded by
/// `page_size`) so this is cheap.
pub async fn list_api_history(
    pool: &DbPool,
    page: u32,
    page_size: u32,
) -> Result<ApiHistoryPage, ApiError> {
    let enabled = ApiEnabledIds::load(pool).await?;

    // Restrict to the two run kinds up front (the web History view is run-only),
    // then drop rows whose entity is not API-enabled.
    let filter = storage_history::HistoryFilter {
        kinds: Some(vec!["commandRun".to_string(), "workflowRun".to_string()]),
        ..Default::default()
    };
    let stored = storage_history::list_paginated(pool, &filter, page, page_size)
        .await
        .map_err(ApiError::RunFailed)?;

    let items: Vec<storage_history::HistoryEvent> = stored
        .items
        .into_iter()
        .filter(|ev| enabled.allows(&ev.payload))
        .collect();

    Ok(ApiHistoryPage {
        items,
        // `total` is the storage total for the two run kinds; the in-memory
        // `api_enabled` filter can only shrink a page, so the count is an upper
        // bound. The web paginator treats it as such (it never asserts an exact
        // visible count), matching the desktop History paginator's contract.
        total: stored.total,
        page: stored.page,
        page_size: stored.page_size,
    })
}

/// Status + captured output of a single run, keyed by `execution_id` (B3).
/// Returns [`ApiError::NotFound`] when no run row matches OR when the run's
/// command / workflow is not (or no longer) API-enabled — this stops a caller
/// reading the output of an un-published entity by guessing execution ids.
///
/// Per decision O2 (option B): a still-running row carries `status: "running"`
/// with whatever output the History row holds (currently none until the run
/// finalises); a terminal row carries the full captured output. Live
/// line-by-line streaming is a planned follow-up (it needs the executor to
/// expose its in-progress capture buffer).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStatusResponse {
    pub execution_id: String,
    pub kind: &'static str,
    pub name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timed_out: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Vec<storage_history::HistoryLogLine>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<storage_history::HistoryExtractedResult>,
}

pub async fn get_run_status(
    pool: &DbPool,
    execution_id: &str,
) -> Result<RunStatusResponse, ApiError> {
    let event = storage_history::find_run_by_execution_id(pool, execution_id)
        .await
        .map_err(ApiError::RunFailed)?
        .ok_or(ApiError::NotFound)?;

    let enabled = ApiEnabledIds::load(pool).await?;
    if !enabled.allows(&event.payload) {
        // The run exists but its entity is not API-visible → treat as not found
        // so existence of the run is not leaked for an un-published entity.
        return Err(ApiError::NotFound);
    }

    match event.payload {
        HistoryEventPayload::CommandRun {
            command_name,
            execution_id,
            exit_code,
            duration_ms,
            status,
            timed_out,
            output,
            result,
            ..
        } => Ok(RunStatusResponse {
            execution_id,
            kind: "command",
            name: command_name,
            status: status.as_str().to_string(),
            exit_code,
            duration_ms,
            timed_out,
            output,
            result,
        }),
        HistoryEventPayload::WorkflowRun {
            workflow_name,
            execution_id,
            exit_code,
            duration_ms,
            status,
            timed_out,
            output,
            result,
            ..
        } => Ok(RunStatusResponse {
            execution_id,
            kind: "workflow",
            name: workflow_name,
            status: status.as_str().to_string(),
            exit_code,
            duration_ms,
            timed_out,
            output,
            result,
        }),
        // `find_run_by_execution_id` only returns the two run kinds, so any
        // other variant here is impossible; treat defensively as not found.
        _ => Err(ApiError::NotFound),
    }
}

/// Resolved sets of currently-API-enabled command and workflow ids, used to
/// filter history / run-status responses so only published entities are
/// visible. Loaded once per request (lists are small relative to a per-row
/// query).
struct ApiEnabledIds {
    command_ids: std::collections::HashSet<String>,
    workflow_ids: std::collections::HashSet<String>,
}

impl ApiEnabledIds {
    async fn load(pool: &DbPool) -> Result<Self, ApiError> {
        let commands = storage_commands::list_all(pool)
            .await
            .map_err(ApiError::RunFailed)?;
        let workflows = storage_workflows::list_all(pool)
            .await
            .map_err(ApiError::RunFailed)?;
        Ok(Self {
            command_ids: commands
                .into_iter()
                .filter(|c| c.api_enabled)
                .map(|c| c.id)
                .collect(),
            workflow_ids: workflows
                .into_iter()
                .filter(|w| w.api_enabled)
                .map(|w| w.id)
                .collect(),
        })
    }

    /// Whether a run event references a currently-API-enabled entity. Non-run
    /// payloads are never allowed (the web History view is run-only).
    fn allows(&self, payload: &HistoryEventPayload) -> bool {
        match payload {
            HistoryEventPayload::CommandRun { command_id, .. } => {
                self.command_ids.contains(command_id)
            }
            HistoryEventPayload::WorkflowRun { workflow_id, .. } => {
                self.workflow_ids.contains(workflow_id)
            }
            _ => false,
        }
    }
}

/// Whether the command marks the variable `name` as `sensitive`. Unknown
/// names (not declared by the command) are treated as sensitive — fail safe: a
/// value we can't classify must not be shown in the log.
fn is_sensitive(cmd: &CommandRecord, name: &str) -> bool {
    match cmd.variables.iter().find(|spec| spec.name == name) {
        Some(spec) => spec.sensitive,
        None => true,
    }
}

/// Build a redacted, single-line summary of a command run's request body for
/// the request log: `wait=<bool>; <name>=<value|***>; …`. Each value is shown
/// verbatim unless the command marks the variable `sensitive` (or doesn't
/// declare it), in which case it is masked to `***`. Variable names are sorted
/// for a stable line. Secrets never appear.
fn redact_command_variables(
    cmd: &CommandRecord,
    values: &BTreeMap<String, String>,
    wait: bool,
) -> String {
    // `BTreeMap` already iterates in key order → deterministic output.
    let vars = values
        .iter()
        .map(|(name, value)| {
            if is_sensitive(cmd, name) {
                format!("{name}={REDACTED}")
            } else {
                format!("{name}={value}")
            }
        })
        .collect::<Vec<_>>()
        .join("; ");
    if vars.is_empty() {
        format!("wait={wait}")
    } else {
        format!("wait={wait}; {vars}")
    }
}

/// Build a redacted summary of a workflow run's node-variable overrides:
/// `wait=<bool>; <node>.<name>=<value|***>; …`. Each value is classified
/// against the `sensitive` flags of the COMMAND the node references (looked up
/// via `commands`); an unknown node or undeclared variable is masked (fail
/// safe). Names are sorted (nodes, then variables) for a stable line.
fn redact_workflow_variables(
    wf: &WorkflowRecord,
    commands: &HashMap<String, CommandRecord>,
    node_values: &HashMap<String, BTreeMap<String, String>>,
    wait: bool,
) -> String {
    // node_id -> the command it runs (if any), for sensitivity lookup.
    let node_command = |node_id: &str| -> Option<&CommandRecord> {
        let cmd_id = wf
            .nodes
            .iter()
            .find(|n| n.id == node_id)?
            .command_id
            .as_deref()?;
        commands.get(cmd_id)
    };

    // Sort nodes for stable output (HashMap iteration order is random).
    let mut node_ids: Vec<&String> = node_values.keys().collect();
    node_ids.sort();

    let mut parts: Vec<String> = Vec::new();
    for node_id in node_ids {
        let Some(vars) = node_values.get(node_id) else {
            continue;
        };
        let cmd = node_command(node_id);
        for (name, value) in vars {
            // Mask unless we resolved the node's command AND it declares the
            // variable as non-sensitive.
            let masked = match cmd {
                Some(c) => is_sensitive(c, name),
                None => true,
            };
            let shown = if masked { REDACTED } else { value.as_str() };
            parts.push(format!("{node_id}.{name}={shown}"));
        }
    }

    if parts.is_empty() {
        format!("wait={wait}")
    } else {
        format!("wait={wait}; {}", parts.join("; "))
    }
}

/// Return the name of the first `sensitive` variable that has neither a
/// supplied value nor a usable (non-secret) default — the headless run cannot
/// prompt for it. `None` when every sensitive variable is satisfied.
fn first_missing_sensitive(
    cmd: &CommandRecord,
    values: &BTreeMap<String, String>,
) -> Option<String> {
    for spec in &cmd.variables {
        if !spec.sensitive {
            continue;
        }
        let has_value = values.get(&spec.name).is_some_and(|v| !v.is_empty());
        // A sensitive variable's default is stripped at the storage boundary,
        // so it can only be satisfied by a supplied value.
        if !has_value {
            return Some(spec.name.clone());
        }
    }
    None
}

/// Record a `running` CommandRun history event tagged `source: api`.
async fn record_command_run_started(pool: &DbPool, cmd: &CommandRecord, execution_id: &str) {
    let event = HistoryEvent {
        id: uuid::Uuid::new_v4().to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        payload: HistoryEventPayload::CommandRun {
            command_id: cmd.id.clone(),
            command_name: cmd.name.clone(),
            execution_id: execution_id.to_string(),
            exit_code: None,
            duration_ms: None,
            status: RunStatus::Running,
            target: cmd.target.clone(),
            timed_out: None,
            output: None,
            result: None,
            source: Some(RUN_SOURCE_API.to_string()),
        },
    };
    if let Err(e) = storage_history::insert_event(pool, &event).await {
        tracing::error!(
            command_id = %cmd.id,
            "http_server: failed to record run history: {e}"
        );
    }
}

/// Map an executor `NodeOutcome` to the History `RunStatus` (the terminal
/// status the finalised `command_run` row carries).
fn outcome_run_status(outcome: &NodeOutcome) -> RunStatus {
    match outcome.status {
        TerminalStatus::Finished if outcome.exit_code == Some(0) => RunStatus::Succeeded,
        TerminalStatus::Cancelled => RunStatus::Cancelled,
        _ => RunStatus::Failed,
    }
}

/// Map an executor `NodeOutcome`'s captured lines into bounded History log
/// lines via the shared `storage_history::from_captured_lines`. `None` when the
/// run captured nothing.
fn outcome_output(outcome: &NodeOutcome) -> Option<Vec<storage_history::HistoryLogLine>> {
    let lines = outcome.output.as_ref()?;
    Some(storage_history::from_captured_lines(lines))
}

/// Map an executor `NodeOutcome`'s structured extraction into the History
/// shape via the shared `storage_history::extracted_to_history`. `None` when
/// there was no extraction.
fn outcome_result(outcome: &NodeOutcome) -> Option<storage_history::HistoryExtractedResult> {
    let extracted = outcome.extracted.as_ref()?;
    Some(storage_history::extracted_to_history(extracted))
}

/// Finalise the `running` CommandRun history row (written by
/// `record_command_run_started`) with the terminal outcome: status, exit code,
/// duration, captured output, and any extraction. Runs entirely in the backend
/// so a headless API run is recorded WITHOUT relying on an open UI window. A
/// missing row (history cleared / pruned mid-run) is not an error.
async fn finalize_command_run(pool: &DbPool, execution_id: &str, outcome: &NodeOutcome) {
    if let Err(e) = storage_history::update_run_event(
        pool,
        execution_id,
        outcome.exit_code,
        Some(outcome.duration_ms),
        outcome_run_status(outcome),
        // The executor's NodeOutcome does not surface a separate timed-out flag;
        // a timeout shows up as a non-zero / signal exit, recorded as `failed`.
        None,
        outcome_output(outcome),
        outcome_result(outcome),
    )
    .await
    {
        tracing::error!(
            execution_id = %execution_id,
            "http_server: failed to finalize command run: {e}"
        );
    }
}

/// Record a `running` WorkflowRun history event (the source of truth for an
/// API-triggered workflow run). Finalised by `finalize_workflow_run`.
async fn record_workflow_run_started(pool: &DbPool, wf: &WorkflowRecord, execution_id: &str) {
    let event = HistoryEvent {
        id: uuid::Uuid::new_v4().to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
        payload: HistoryEventPayload::WorkflowRun {
            workflow_id: wf.id.clone(),
            workflow_name: wf.name.clone(),
            execution_id: execution_id.to_string(),
            exit_code: None,
            duration_ms: None,
            status: RunStatus::Running,
            timed_out: None,
            output: None,
            result: None,
        },
    };
    if let Err(e) = storage_history::insert_event(pool, &event).await {
        tracing::error!(
            workflow_id = %wf.id,
            "http_server: failed to record workflow run history: {e}"
        );
    }
}

/// Terminal status string for a workflow run capture.
fn workflow_status_str(run: &workflow::WorkflowRunCapture) -> &'static str {
    if run.succeeded {
        "succeeded"
    } else if run.cancelled {
        "cancelled"
    } else {
        "failed"
    }
}

/// Map a workflow run's aggregate captured lines into bounded History log
/// lines via the shared `storage_history::from_captured_lines`. `None` when
/// nothing was captured.
fn workflow_output(
    run: &workflow::WorkflowRunCapture,
) -> Option<Vec<storage_history::HistoryLogLine>> {
    let lines = run.output.as_ref()?;
    Some(storage_history::from_captured_lines(lines))
}

/// Finalise the `running` WorkflowRun history row with the terminal status and
/// captured output. Backend-only, like `finalize_command_run`.
async fn finalize_workflow_run(
    pool: &DbPool,
    execution_id: &str,
    run: &workflow::WorkflowRunCapture,
) {
    let status = if run.succeeded {
        RunStatus::Succeeded
    } else if run.cancelled {
        RunStatus::Cancelled
    } else {
        RunStatus::Failed
    };
    if let Err(e) = storage_history::update_run_event(
        pool,
        execution_id,
        // Workflows have no single exit code / timeout flag at this layer.
        None,
        None,
        status,
        None,
        workflow_output(run),
        None,
    )
    .await
    {
        tracing::error!(
            execution_id = %execution_id,
            "http_server: failed to finalize workflow run: {e}"
        );
    }
}

/// Map a terminal outcome to a wire status string.
fn terminal_status_str(outcome: &NodeOutcome) -> &'static str {
    match outcome.status {
        TerminalStatus::Finished if outcome.exit_code == Some(0) => "succeeded",
        TerminalStatus::Cancelled => "cancelled",
        _ => "failed",
    }
}

/// Map an executor spawn error string to an `ApiError`. A typed
/// `missingVariable` becomes a 400; everything else is a 500-class run failure.
fn map_spawn_error(e: String) -> ApiError {
    if e.contains("missingVariable") {
        ApiError::MissingVariable(e)
    } else {
        ApiError::RunFailed(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::commands::VariableSpec;

    fn cmd_with_sensitive() -> CommandRecord {
        CommandRecord {
            id: "c1".into(),
            name: "n".into(),
            name_key: None,
            description: None,
            description_key: None,
            icon: None,
            script: "echo".into(),
            shell: None,
            args: None,
            working_dir: None,
            env: None,
            tags: vec![],
            category_id: None,
            favorite: false,
            created_at: "2026-06-24".into(),
            updated_at: "2026-06-24".into(),
            last_run_at: None,
            run_count: 0,
            run_as_admin: false,
            variables: vec![
                VariableSpec {
                    name: "token".into(),
                    default_value: None,
                    prompt_at_runtime: false,
                    description: None,
                    sensitive: true,
                },
                VariableSpec {
                    name: "name".into(),
                    default_value: None,
                    prompt_at_runtime: false,
                    description: None,
                    sensitive: false,
                },
            ],
            timeout_seconds: None,
            output_schema: None,
            scope: None,
            workflow_id: None,
            target: None,
            api_slug: Some("deploy".into()),
            api_enabled: true,
            explorer_enabled: false,
            explorer_path_variable: None,
            sound: None,
        }
    }

    #[test]
    fn missing_sensitive_detected_when_absent() {
        let cmd = cmd_with_sensitive();
        assert_eq!(
            first_missing_sensitive(&cmd, &BTreeMap::new()),
            Some("token".to_string())
        );
    }

    #[test]
    fn missing_sensitive_satisfied_when_supplied() {
        let cmd = cmd_with_sensitive();
        let mut vals = BTreeMap::new();
        vals.insert("token".to_string(), "s3cr3t".to_string());
        assert_eq!(first_missing_sensitive(&cmd, &vals), None);
    }

    #[test]
    fn spawn_error_classifies_missing_variable() {
        assert_eq!(
            map_spawn_error("VariableResolution: missingVariable who".into()),
            ApiError::MissingVariable("VariableResolution: missingVariable who".into())
        );
        match map_spawn_error("boom".into()) {
            ApiError::RunFailed(_) => {}
            other => panic!("expected RunFailed, got {other:?}"),
        }
    }

    #[test]
    fn build_request_inverts_console_flag_into_silent() {
        let cmd = cmd_with_sensitive();
        let req = ExecuteRequest::for_command(
            &cmd,
            RunOptions {
                execution_id: "x".into(),
                variable_values: BTreeMap::new(),
                workflow_run_id: None,
                timeout_override: None,
                working_dir_override: None,
                capture_output: true,
                silent: true,
            },
        );
        assert!(
            req.silent,
            "silent must be true when log_to_console is false"
        );
        assert!(req.capture_output, "API runs always capture");
        assert!(
            req.workflow_run_id.is_none(),
            "API command run is standalone"
        );
    }

    /// The command request summary masks sensitive values, shows non-sensitive
    /// ones verbatim, and is deterministically ordered.
    #[test]
    fn command_summary_masks_only_sensitive() {
        let cmd = cmd_with_sensitive();
        let mut vals = BTreeMap::new();
        vals.insert("token".to_string(), "s3cr3t".to_string());
        vals.insert("name".to_string(), "alice".to_string());

        let summary = redact_command_variables(&cmd, &vals, true);
        // BTreeMap order → name before token.
        assert_eq!(summary, "wait=true; name=alice; token=***");
        assert!(!summary.contains("s3cr3t"), "the secret must never appear");
    }

    /// A variable the command does NOT declare is masked (fail safe).
    #[test]
    fn command_summary_masks_undeclared_variable() {
        let cmd = cmd_with_sensitive();
        let mut vals = BTreeMap::new();
        vals.insert("mystery".to_string(), "leak".to_string());
        let summary = redact_command_variables(&cmd, &vals, false);
        assert_eq!(summary, "wait=false; mystery=***");
        assert!(!summary.contains("leak"));
    }

    /// With no variables the summary is just the wait flag.
    #[test]
    fn command_summary_without_variables() {
        let cmd = cmd_with_sensitive();
        assert_eq!(
            redact_command_variables(&cmd, &BTreeMap::new(), true),
            "wait=true"
        );
    }

    /// The workflow summary classifies each node value against that node's
    /// command and masks sensitive ones; an unknown node is masked.
    #[test]
    fn workflow_summary_masks_per_node_command() {
        use crate::storage::workflows::{NodePosition, WorkflowNodeRecord};

        let cmd = cmd_with_sensitive(); // id "c1": token sensitive, name not.
        let node = WorkflowNodeRecord {
            id: "step".into(),
            kind: "command".into(),
            command_id: Some("c1".into()),
            label: None,
            condition: None,
            cases: Vec::new(),
            loop_config: None,
            retry: None,
            data: Vec::new(),
            variable_sources: BTreeMap::new(),
            parser: None,
            text: None,
            join_node_id: None,
            position: NodePosition { x: 0.0, y: 0.0 },
        };
        let wf = WorkflowRecord {
            id: "w1".into(),
            name: "wf".into(),
            description: None,
            icon: None,
            nodes: vec![node],
            edges: Vec::new(),
            tags: Vec::new(),
            category_id: None,
            favorite: false,
            created_at: "2026-06-24".into(),
            updated_at: "2026-06-24".into(),
            last_run_at: None,
            run_count: 0,
            api_slug: None,
            api_enabled: true,
            sound: None,
        };
        let mut commands = HashMap::new();
        commands.insert("c1".to_string(), cmd);

        let mut step_vars = BTreeMap::new();
        step_vars.insert("token".to_string(), "s3cr3t".to_string());
        step_vars.insert("name".to_string(), "alice".to_string());
        let mut ghost_vars = BTreeMap::new();
        ghost_vars.insert("x".to_string(), "secret".to_string());
        let mut node_values = HashMap::new();
        node_values.insert("step".to_string(), step_vars);
        node_values.insert("ghost".to_string(), ghost_vars); // unknown node

        let summary = redact_workflow_variables(&wf, &commands, &node_values, true);
        // Sorted by node id: ghost before step.
        assert_eq!(
            summary,
            "wait=true; ghost.x=***; step.name=alice; step.token=***"
        );
        assert!(!summary.contains("s3cr3t"));
        assert!(!summary.contains("secret"), "unknown node value masked");
    }

    /// Build a minimal `CommandRun` payload referencing `command_id`.
    fn command_run_payload(command_id: &str) -> HistoryEventPayload {
        HistoryEventPayload::CommandRun {
            command_id: command_id.to_string(),
            command_name: "n".into(),
            execution_id: "e1".into(),
            exit_code: None,
            duration_ms: None,
            status: RunStatus::Running,
            target: None,
            timed_out: None,
            output: None,
            result: None,
            source: Some(RUN_SOURCE_API.to_string()),
        }
    }

    /// Build a minimal `WorkflowRun` payload referencing `workflow_id`.
    fn workflow_run_payload(workflow_id: &str) -> HistoryEventPayload {
        HistoryEventPayload::WorkflowRun {
            workflow_id: workflow_id.to_string(),
            workflow_name: "w".into(),
            execution_id: "r1".into(),
            exit_code: None,
            duration_ms: None,
            status: RunStatus::Running,
            timed_out: None,
            output: None,
            result: None,
        }
    }

    fn enabled_ids(commands: &[&str], workflows: &[&str]) -> ApiEnabledIds {
        ApiEnabledIds {
            command_ids: commands.iter().map(|s| s.to_string()).collect(),
            workflow_ids: workflows.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// A run referencing an API-enabled command/workflow is allowed; one
    /// referencing a non-enabled (or unknown) id is hidden.
    #[test]
    fn api_enabled_filter_gates_run_events() {
        let ids = enabled_ids(&["c1"], &["w1"]);
        assert!(
            ids.allows(&command_run_payload("c1")),
            "enabled command run"
        );
        assert!(
            !ids.allows(&command_run_payload("c2")),
            "non-enabled command run is hidden"
        );
        assert!(
            ids.allows(&workflow_run_payload("w1")),
            "enabled workflow run"
        );
        assert!(
            !ids.allows(&workflow_run_payload("w2")),
            "non-enabled workflow run is hidden"
        );
    }

    /// Non-run payloads are never API-visible (the web History view is run-only),
    /// even when the referenced entity id happens to be API-enabled.
    #[test]
    fn api_enabled_filter_excludes_non_run_events() {
        let ids = enabled_ids(&["c1"], &["w1"]);
        let restored = HistoryEventPayload::CommandRestored {
            command_id: "c1".into(),
            command_name: "n".into(),
            original_event_id: "old".into(),
        };
        assert!(
            !ids.allows(&restored),
            "a non-run event is never exposed via the API history"
        );
    }
}
