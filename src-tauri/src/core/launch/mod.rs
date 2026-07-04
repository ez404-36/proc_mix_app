//! Quick-launch: fire a saved command or workflow headlessly, out of band,
//! WITHOUT an open editor / library window.
//!
//! This is the shared backend path behind the two v0.12.0 entry points that
//! run favorites without bringing up the app:
//!   - the tray icon's "Favorites" submenu (Stage 1), and
//!   - the OS file-manager shell integration (Stage 2/3), which additionally
//!     passes the right-clicked filesystem path.
//!
//! It mirrors the scheduler's headless fire model (`core::scheduler::fire`):
//! a command runs through [`executor::spawn_execution_with_completion`] with
//! `RunOptions { silent: true, capture_output: true }`; a workflow runs through
//! [`workflow::execute_workflow_blocking`] with `silent = true`. Both record a
//! single, already-finalised `quickLaunch` history event — the source of truth
//! for a run that happened with no window observing the live event stream.
//!
//! Unlike the scheduler this module owns NO cron/schedule state; it resolves an
//! entity by id and fires it once. It deliberately does not depend on the
//! scheduler's private `FireStatus` / `CommandFire` types — it defines its own
//! small [`LaunchStatus`] / [`LaunchOutcome`] so the two headless paths stay
//! decoupled.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::Local;
use tauri::{AppHandle, Runtime};

use crate::core::executor::{
    self, ExecuteRequest, ExecutorState, NodeOutcome, RunOptions, TerminalStatus,
};
use crate::core::workflow::{self, WorkflowExecutorState};
use crate::storage::commands::{self as storage_commands, CommandRecord};
use crate::storage::history::{self as storage_history, HistoryEvent, HistoryEventPayload};
use crate::storage::workflows as storage_workflows;
use crate::storage::DbPool;

/// The kind of entity a quick-launch targets. Serialised lowercase so it
/// matches the `target_kind` string the history layer already uses for the
/// `scheduledRun` variant (`"command"` / `"workflow"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchKind {
    Command,
    Workflow,
}

impl LaunchKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LaunchKind::Command => "command",
            LaunchKind::Workflow => "workflow",
        }
    }

    /// Parse the `<kind>` segment of a `tray-fav:<kind>:<id>` menu id (and,
    /// later, the shell-integration argv). Unknown strings return `None` so a
    /// malformed id is rejected rather than mis-routed.
    ///
    /// Named `parse_kind` (not `from_str`) to avoid colliding with the
    /// `std::str::FromStr` trait — clippy::should_implement_trait flags that,
    /// and `FromStr::from_str` must return a `Result`, whereas the `Option`
    /// "None for unknown" semantics here are what callers want.
    pub fn parse_kind(s: &str) -> Option<Self> {
        match s {
            "command" => Some(LaunchKind::Command),
            "workflow" => Some(LaunchKind::Workflow),
            _ => None,
        }
    }
}

/// What triggered a quick-launch. Recorded on the history event so the History
/// view can label and badge the run by origin, and (later) so the shell path
/// can be told apart from the tray path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchSource {
    /// The tray icon's "Favorites" submenu.
    Tray,
    /// The OS file-manager context menu (Stage 2/3).
    Shell,
}

impl LaunchSource {
    pub fn as_str(self) -> &'static str {
        match self {
            LaunchSource::Tray => "tray",
            LaunchSource::Shell => "shell",
        }
    }
}

/// Final status of a quick-launch, recorded on the `quickLaunch` history event
/// and used to choose the outcome notification. Kept a small enum so the
/// firing code and the history payload agree on the exact strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchStatus {
    Success,
    Error,
    MissingVariable,
    NotFound,
}

impl LaunchStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            LaunchStatus::Success => "success",
            LaunchStatus::Error => "error",
            LaunchStatus::MissingVariable => "missingVariable",
            LaunchStatus::NotFound => "notFound",
        }
    }
}

/// Outcome of [`fire_favorite`]: the recorded status plus the resolved display
/// name of the fired entity (empty when it could not be resolved). The caller
/// uses both to show a brief native notification.
#[derive(Debug, Clone)]
pub struct LaunchOutcome {
    pub status: LaunchStatus,
    pub entity_name: String,
}

/// Fire a saved command or workflow ONCE, headlessly, and record a single
/// `quickLaunch` history event. Never panics: a missing entity, missing
/// variable, or run error all map to a recorded [`LaunchStatus`].
///
/// `selected_path`, when `Some`, is injected as the `PROCMIX_SELECTED_PATH`
/// variable value (and, for a directory, used as the working-directory
/// override). It is `None` for every tray launch; the shell-integration path
/// (Stage 3) supplies it. The value MUST already be validated by the caller —
/// this function treats it as opaque and never builds a shell string from it.
#[allow(clippy::too_many_arguments)]
pub async fn fire_favorite<R: Runtime>(
    app: &AppHandle<R>,
    pool: &DbPool,
    executor_state: &Arc<ExecutorState>,
    workflow_state: &Arc<WorkflowExecutorState>,
    kind: LaunchKind,
    id: &str,
    source: LaunchSource,
    selected_path: Option<String>,
) -> LaunchOutcome {
    match kind {
        LaunchKind::Command => {
            fire_command(app, pool, executor_state, id, source, selected_path).await
        }
        LaunchKind::Workflow => {
            fire_workflow(app, pool, executor_state, workflow_state, id, source).await
        }
    }
}

/// The decision for a COMMAND-targeted quick-launch, computed before firing:
/// whether it can run headlessly or must first collect interactive input.
/// Workflows never reach this — they always run headless.
pub enum CommandLaunchPlan {
    /// The command was not found / failed to load. A `quickLaunch` "notFound"
    /// event has already been recorded by [`resolve_command_launch`].
    Unavailable,
    /// The command can run headlessly with the bundled context (no prompts).
    Headless {
        command: CommandRecord,
        selected_path: Option<String>,
        working_dir_override: Option<String>,
    },
    /// The command needs interactive input (variables and/or admin password).
    /// The caller opens the prompt window with this context. `needs_admin` is
    /// the keychain-aware decision (true only when elevation is required AND no
    /// password is saved), so the window shows the password field only then.
    NeedsPrompt {
        command: CommandRecord,
        needs_admin: bool,
        selected_path: Option<String>,
        working_dir_override: Option<String>,
    },
}

/// Load a command target and decide whether it runs headlessly or needs the
/// interactive prompt window. Computes the shell-path context (the
/// `PROCMIX_SELECTED_PATH` provided value + a directory working-dir override)
/// once, shared by both outcomes. On a missing / unreadable command it records
/// the `quickLaunch` "notFound" / error event and returns [`Unavailable`].
///
/// [`Unavailable`]: CommandLaunchPlan::Unavailable
pub async fn resolve_command_launch(
    pool: &DbPool,
    id: &str,
    source: LaunchSource,
    selected_path: Option<String>,
) -> CommandLaunchPlan {
    let cmd = match storage_commands::find_by_id(pool, id).await {
        Ok(Some(cmd)) => cmd,
        Ok(None) => {
            tracing::warn!(command_id = %id, "quick-launch: command not found");
            record_outcome(
                pool,
                LaunchKind::Command,
                id,
                "",
                source,
                None,
                LaunchStatus::NotFound,
                &CapturedDetail::default(),
            )
            .await;
            return CommandLaunchPlan::Unavailable;
        }
        Err(e) => {
            tracing::error!(command_id = %id, "quick-launch: failed to load command: {e}");
            record_outcome(
                pool,
                LaunchKind::Command,
                id,
                "",
                source,
                None,
                LaunchStatus::Error,
                &CapturedDetail::default(),
            )
            .await;
            return CommandLaunchPlan::Unavailable;
        }
    };

    // The shell-selected path is a provided value for the reserved variable —
    // and for the command's opted-in `explorer_path_variable` (if any), so a
    // required variable that will receive the path does not force a prompt. A
    // directory also overrides the working directory.
    let mut provided = std::collections::BTreeSet::new();
    let mut working_dir_override = None;
    if let Some(ref path) = selected_path {
        provided.insert(SELECTED_PATH_VAR.to_string());
        if let Some(var) = cmd
            .explorer_path_variable
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            provided.insert(var.to_string());
        }
        if std::path::Path::new(path).is_dir() {
            working_dir_override = Some(path.clone());
        }
    }

    // The admin-password decision consults the OS keychain (async-safe here);
    // a saved password means no prompt is needed for elevation.
    let needs_admin = admin_password_needed(&cmd);

    if command_needs_interaction(&cmd, &provided) || needs_admin {
        CommandLaunchPlan::NeedsPrompt {
            command: cmd,
            needs_admin,
            selected_path,
            working_dir_override,
        }
    } else {
        CommandLaunchPlan::Headless {
            command: cmd,
            selected_path,
            working_dir_override,
        }
    }
}

/// Fire an already-resolved non-interactive command headlessly. Thin wrapper
/// that builds the path-injected variable map and delegates to
/// [`fire_command_resolved`]. Used by the [`CommandLaunchPlan::Headless`] arm so
/// the command is not loaded twice.
pub async fn fire_resolved_headless<R: Runtime>(
    app: &AppHandle<R>,
    pool: &DbPool,
    executor_state: &Arc<ExecutorState>,
    command: &CommandRecord,
    source: LaunchSource,
    selected_path: Option<String>,
    working_dir_override: Option<String>,
) -> LaunchOutcome {
    let mut variable_values = std::collections::BTreeMap::new();
    seed_selected_path_vars(command, selected_path.as_deref(), &mut variable_values);
    fire_command_resolved(
        app,
        pool,
        executor_state,
        command,
        source,
        selected_path,
        variable_values,
        working_dir_override,
        None,
    )
    .await
}

/// Resolve and run a command target headlessly, then record the outcome. This
/// is the NON-interactive path (no variables that need prompting): the only
/// caller-supplied value is the shell `selected_path`.
async fn fire_command<R: Runtime>(
    app: &AppHandle<R>,
    pool: &DbPool,
    executor_state: &Arc<ExecutorState>,
    id: &str,
    source: LaunchSource,
    selected_path: Option<String>,
) -> LaunchOutcome {
    let cmd = match storage_commands::find_by_id(pool, id).await {
        Ok(Some(cmd)) => cmd,
        Ok(None) => {
            tracing::warn!(command_id = %id, "quick-launch: command not found");
            return record_and_return(
                pool,
                LaunchKind::Command,
                id,
                "",
                source,
                None,
                LaunchStatus::NotFound,
            )
            .await;
        }
        Err(e) => {
            tracing::error!(command_id = %id, "quick-launch: failed to load command: {e}");
            return record_and_return(
                pool,
                LaunchKind::Command,
                id,
                "",
                source,
                None,
                LaunchStatus::Error,
            )
            .await;
        }
    };

    // Inject the selected filesystem path as a reserved variable value so a
    // command can reference `$PROCMIX_SELECTED_PATH` in its script. The path is
    // passed only as a variable VALUE (env binding) — never concatenated into a
    // shell string — so an untrusted OS-supplied path cannot inject a command.
    //
    // When the path is a DIRECTORY, it also becomes the run's working directory
    // (override), so a favorite launched on a folder / folder-background runs
    // "here". A file selection leaves the command's own working dir intact.
    let mut variable_values = std::collections::BTreeMap::new();
    let mut working_dir_override = None;
    seed_selected_path_vars(&cmd, selected_path.as_deref(), &mut variable_values);
    if let Some(ref path) = selected_path {
        if std::path::Path::new(path).is_dir() {
            working_dir_override = Some(path.clone());
        }
    }

    fire_command_resolved(
        app,
        pool,
        executor_state,
        &cmd,
        source,
        selected_path,
        variable_values,
        working_dir_override,
        None,
    )
    .await
}

/// Run an already-loaded command headlessly with FULLY-RESOLVED inputs, then
/// record the `quickLaunch` outcome. Shared by the non-interactive
/// [`fire_command`] path and the interactive prompt-window submit
/// (`platform::quick_prompt`), so both record history identically.
///
/// `variable_values` is the complete per-run map (path injection + any
/// prompt-collected values); `admin_password` is a one-shot sudo password
/// (`None` when not elevated / not collected) — it is never persisted.
#[allow(clippy::too_many_arguments)]
pub async fn fire_command_resolved<R: Runtime>(
    app: &AppHandle<R>,
    pool: &DbPool,
    executor_state: &Arc<ExecutorState>,
    cmd: &CommandRecord,
    source: LaunchSource,
    selected_path: Option<String>,
    variable_values: std::collections::BTreeMap<String, String>,
    working_dir_override: Option<String>,
    admin_password: Option<String>,
) -> LaunchOutcome {
    let id = cmd.id.clone();
    let entity_name = cmd.name.clone();

    let execution_id = uuid::Uuid::new_v4().to_string();
    let mut req = ExecuteRequest::for_command(
        cmd,
        RunOptions {
            execution_id,
            variable_values,
            workflow_run_id: None,
            timeout_override: None,
            working_dir_override,
            // A quick-launch always captures so the History row has viewable
            // output, and is always silent (no window is guaranteed to be open).
            capture_output: true,
            silent: true,
        },
    );
    // A one-shot admin password (collected by the prompt window) is set on the
    // request directly — `for_command` leaves it `None`. When `None`, the
    // executor falls back to the keychain as usual.
    req.admin_password = admin_password;

    let (tx, rx) = tokio::sync::oneshot::channel::<NodeOutcome>();
    if let Err(e) = executor::spawn_execution_with_completion(
        app.clone(),
        executor_state.clone(),
        req,
        Some(tx),
    )
    .await
    {
        // A deterministic missing-variable failure surfaces here before any
        // child is spawned (the reserved path variable does not satisfy a
        // command's own required variables).
        let status = if e.contains("missingVariable") {
            LaunchStatus::MissingVariable
        } else {
            tracing::error!(command_id = %id, "quick-launch: command spawn failed: {e}");
            LaunchStatus::Error
        };
        return record_and_return(
            pool,
            LaunchKind::Command,
            &id,
            &entity_name,
            source,
            selected_path,
            status,
        )
        .await;
    }

    let (status, capture) = match rx.await {
        Ok(outcome) => (classify_outcome(&outcome), capture_from_outcome(&outcome)),
        Err(_) => (LaunchStatus::Error, CapturedDetail::default()),
    };

    record_outcome(
        pool,
        LaunchKind::Command,
        &id,
        &entity_name,
        source,
        selected_path,
        status,
        &capture,
    )
    .await;

    // Play the per-command notification sound for this headless run. Only a
    // definite Success/Error maps to a sound outcome; a non-run status
    // (MissingVariable / NotFound) plays nothing. Best-effort, non-blocking.
    if let Some(outcome) = launch_status_outcome(status) {
        crate::core::sound::trigger::play_outcome(app, cmd.sound.as_ref(), outcome).await;
    }

    LaunchOutcome {
        status,
        entity_name,
    }
}

/// Map a [`LaunchStatus`] to a sound [`Outcome`], or `None` when the status is
/// not a completed run (so no cue plays).
fn launch_status_outcome(status: LaunchStatus) -> Option<crate::core::sound::resolve::Outcome> {
    match status {
        LaunchStatus::Success => Some(crate::core::sound::resolve::Outcome::Success),
        LaunchStatus::Error => Some(crate::core::sound::resolve::Outcome::Error),
        LaunchStatus::MissingVariable | LaunchStatus::NotFound => None,
    }
}

/// Resolve and run a workflow target headlessly (silent + capturing), then
/// record the outcome. Shell-supplied paths are not threaded into workflow
/// nodes in v0.12.0 (a workflow has many nodes with distinct variable scopes);
/// `selected_path` is therefore ignored for workflow targets.
async fn fire_workflow<R: Runtime>(
    app: &AppHandle<R>,
    pool: &DbPool,
    executor_state: &Arc<ExecutorState>,
    workflow_state: &Arc<WorkflowExecutorState>,
    id: &str,
    source: LaunchSource,
) -> LaunchOutcome {
    let wf = match storage_workflows::list_all(pool).await {
        Ok(list) => match list.into_iter().find(|w| w.id == id) {
            Some(wf) => wf,
            None => {
                tracing::warn!(workflow_id = %id, "quick-launch: workflow not found");
                return record_and_return(
                    pool,
                    LaunchKind::Workflow,
                    id,
                    "",
                    source,
                    None,
                    LaunchStatus::NotFound,
                )
                .await;
            }
        },
        Err(e) => {
            tracing::error!(workflow_id = %id, "quick-launch: failed to load workflows: {e}");
            return record_and_return(
                pool,
                LaunchKind::Workflow,
                id,
                "",
                source,
                None,
                LaunchStatus::Error,
            )
            .await;
        }
    };

    let entity_name = wf.name.clone();
    // Capture the per-workflow sound override before `wf` is moved into the
    // runner below, so we can play the completion cue after it finishes.
    let wf_sound = wf.sound.clone();

    let all_commands = match storage_commands::list_all(pool).await {
        Ok(list) => list,
        Err(e) => {
            tracing::error!(workflow_id = %id, "quick-launch: failed to load commands: {e}");
            return record_and_return(
                pool,
                LaunchKind::Workflow,
                id,
                &entity_name,
                source,
                None,
                LaunchStatus::Error,
            )
            .await;
        }
    };
    let commands: HashMap<String, CommandRecord> = all_commands
        .into_iter()
        .map(|c| (c.id.clone(), c))
        .collect();

    // Drive the workflow to completion in-process, silent + capturing — the
    // history record is the only observable result of a headless fire.
    let run = workflow::execute_workflow_blocking(
        app.clone(),
        executor_state.clone(),
        workflow_state.clone(),
        wf,
        commands,
        HashMap::new(),
        true,
    )
    .await;

    let status = if run.succeeded {
        LaunchStatus::Success
    } else {
        LaunchStatus::Error
    };

    let capture = CapturedDetail {
        output: run
            .output
            .as_deref()
            .map(storage_history::from_captured_lines),
        ..CapturedDetail::default()
    };

    record_outcome(
        pool,
        LaunchKind::Workflow,
        id,
        &entity_name,
        source,
        None,
        status,
        &capture,
    )
    .await;

    // Play the per-workflow notification sound (best-effort, non-blocking).
    if let Some(outcome) = launch_status_outcome(status) {
        crate::core::sound::trigger::play_outcome(app, wf_sound.as_ref(), outcome).await;
    }

    LaunchOutcome {
        status,
        entity_name,
    }
}

/// The reserved variable name a shell-launched command reads to learn the
/// right-clicked filesystem path. Documented in `docs/shell-integration.md`
/// (Stage 5) and surfaced as a form hint in the command editor.
pub const SELECTED_PATH_VAR: &str = "PROCMIX_SELECTED_PATH";

/// Seed a run's variable map with the shell-selected path. When `selected_path`
/// is present, it is bound to the reserved [`SELECTED_PATH_VAR`] (always, for
/// backwards compatibility) AND — when the command opted a variable in via its
/// `explorer_path_variable` setting — to that named variable too, so the same
/// path reaches a human-named variable the command's script references.
///
/// The path is inserted only as a variable VALUE (env binding); it is never
/// concatenated into a shell string, so an untrusted OS-supplied path cannot
/// inject a command. A blank / whitespace-only `explorer_path_variable` is
/// ignored (the UI normalises "no variable" to NULL, but guard here too).
fn seed_selected_path_vars(
    cmd: &CommandRecord,
    selected_path: Option<&str>,
    values: &mut std::collections::BTreeMap<String, String>,
) {
    let Some(path) = selected_path else {
        return;
    };
    values.insert(SELECTED_PATH_VAR.to_string(), path.to_string());
    if let Some(var) = cmd
        .explorer_path_variable
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        values.insert(var.to_string(), path.to_string());
    }
}

/// A parsed shell-integration launch request, extracted from the process argv
/// by [`parse_run_args`]. Produced when the OS file manager launches ProcMix
/// with `--run-favorite <kind>:<id> [--path <p>]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunArgs {
    pub kind: LaunchKind,
    pub id: String,
    /// The right-clicked filesystem path, present only when a valid `--path`
    /// was supplied. `None` when omitted (it is always validated, so a rejected
    /// path becomes `None` rather than an error — the favorite still runs,
    /// without a path).
    pub selected_path: Option<String>,
}

/// Parse a shell-integration launch out of an argv slice (the args AFTER the
/// program name). Returns `None` when this is NOT a `--run-favorite` invocation
/// (a normal launch / `--autostart` / etc.), so the caller falls back to its
/// default behaviour.
///
/// Recognised form: `--run-favorite <kind>:<id> [--path <selected>]`. The
/// `<kind>:<id>` token is split on the FIRST `:` so an id containing colons is
/// preserved. A malformed `--run-favorite` (missing value, empty id, unknown
/// kind) returns `None` — a launch we cannot route is ignored, not mis-fired.
///
/// The `--path` value is validated by [`is_safe_selected_path`]; an unsafe or
/// non-existent path is DROPPED (the favorite still runs without it) rather
/// than aborting, because the menu entry is trusted even if the path is not.
pub fn parse_run_args<S: AsRef<str>>(args: &[S]) -> Option<RunArgs> {
    let mut entity: Option<(LaunchKind, String)> = None;
    let mut raw_path: Option<String> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_ref() {
            "--run-favorite" => {
                let value = args.get(i + 1)?.as_ref();
                entity = parse_entity_ref(value);
                entity.as_ref()?;
                i += 2;
            }
            "--path" => {
                // A missing value for --path is tolerated (treated as no path).
                if let Some(v) = args.get(i + 1) {
                    raw_path = Some(v.as_ref().to_string());
                    i += 2;
                } else {
                    i += 1;
                }
            }
            _ => i += 1,
        }
    }

    let (kind, id) = entity?;
    let selected_path = raw_path.and_then(|p| {
        if is_safe_selected_path(&p) {
            Some(p)
        } else {
            tracing::warn!("quick-launch: dropping unsafe shell-supplied path");
            None
        }
    });
    Some(RunArgs {
        kind,
        id,
        selected_path,
    })
}

/// Split a `<kind>:<id>` entity reference into a [`LaunchKind`] and id. The
/// split is on the FIRST `:` so an id with embedded colons round-trips. Returns
/// `None` for an unknown kind or an empty id.
fn parse_entity_ref(value: &str) -> Option<(LaunchKind, String)> {
    let (kind_str, id) = value.split_once(':')?;
    if id.is_empty() {
        return None;
    }
    Some((LaunchKind::parse_kind(kind_str)?, id.to_string()))
}

/// Validate an OS-supplied filesystem path before it is used as a variable
/// value / working-directory override. This is the security boundary for the
/// ONLY untrusted value the shell integration feeds into a child process.
///
/// Rejects:
///   - an empty string,
///   - any embedded NUL or other ASCII control character (a path can never
///     legitimately contain these; they are classic argument / log-injection
///     vectors), and
///   - a path that does not exist on disk (a stale / spoofed selection).
///
/// The path is NEVER built into a shell string regardless — it is passed as a
/// distinct env-variable value and (for a directory) a working-dir override —
/// so this validation is defence in depth, not the sole barrier.
pub fn is_safe_selected_path(path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    if path.chars().any(|c| c == '\0' || c.is_control()) {
        return false;
    }
    std::path::Path::new(path).exists()
}

/// Decide whether a command's VARIABLES require interactive input (the
/// standalone prompt window). Returns `true` when a normal run would block on
/// the variable prompt. This is a pure, synchronous check — the admin-password
/// decision is separate (see [`admin_password_needed`]) because it must consult
/// the OS keychain, which is async / blocking and not available here.
///
/// `provided` is the set of variable names whose value the launch already
/// supplies WITHOUT asking the user — for a shell launch this is
/// `{PROCMIX_SELECTED_PATH}` (when a path was passed); for a tray launch it is
/// empty. A provided value satisfies a plain required variable, but it does NOT
/// suppress a `sensitive` or `prompt_at_runtime` spec (those always ask).
///
/// A command needs variable interaction when ANY spec is:
///   - `sensitive` (a secret is never baked in, so it must be entered each run),
///   - `prompt_at_runtime` (explicit "always ask"), or
///   - required (no `default_value`) and not in `provided`.
pub fn command_needs_interaction(
    cmd: &CommandRecord,
    provided: &std::collections::BTreeSet<String>,
) -> bool {
    cmd.variables.iter().any(|spec| {
        if spec.sensitive || spec.prompt_at_runtime {
            return true;
        }
        // A plain required variable (no default) needs a value; a provided
        // value (e.g. PROCMIX_SELECTED_PATH) satisfies it.
        spec.default_value.is_none() && !provided.contains(&spec.name)
    })
}

/// Whether running this command will require ProcMix to COLLECT an admin
/// password via the prompt window — i.e. it elevates on Unix AND no password is
/// already saved in the OS keychain (in which case the executor reuses the
/// saved one and no prompt is needed).
///
/// Windows elevation is handled by the OS UAC dialog at spawn time, never by the
/// quick-prompt window, so this is always `false` there. A keychain backend
/// error is treated as "not stored" (`has()` → `false`) so we fail safe by
/// prompting rather than silently assuming a password exists.
fn admin_password_needed(cmd: &CommandRecord) -> bool {
    if !cfg!(unix) || !cmd.run_as_admin {
        return false;
    }
    // A saved password means the executor can elevate without a prompt.
    !crate::security::admin_password::has().unwrap_or(false)
}

/// Everything the standalone quick-launch prompt window needs to collect input,
/// bundled by the backend so the window performs NO extra round-trip to fetch
/// command data. Built from the already-loaded [`CommandRecord`] plus the
/// launch context (selected path / working-dir override). Serialised camelCase
/// to match the TS DTO the prompt window consumes.
///
/// Only commands reach this struct — workflows never prompt (they always run
/// headless). The window reads it once via `get_quick_prompt_request`, drives
/// the variable / admin-password modals, and submits the collected values back
/// for a single headless run.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickPromptRequest {
    /// Logical id of the command to run, echoed back on submit.
    pub command_id: String,
    /// Display name, for the dialog heading.
    pub command_name: String,
    /// The command's variable specs (camelCase wire shape identical to the TS
    /// `VariableSpec`), so the prompt window asks exactly what a normal run
    /// would. Specs whose value is already `provided` are pre-filled by the
    /// window from `selected_path` and not re-asked.
    pub variables: Vec<storage_commands::VariableSpec>,
    /// Whether the window must also collect a one-shot admin password (Unix
    /// elevation). `false` on Windows (UAC) and for non-elevated commands.
    pub needs_admin: bool,
    /// The shell-selected path, injected as `PROCMIX_SELECTED_PATH` and used to
    /// pre-fill / satisfy that variable. `None` for a tray launch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_path: Option<String>,
    /// Working-directory override (the selected folder), applied to the run.
    /// `None` unless the shell selection was a directory.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working_dir_override: Option<String>,
}

impl QuickPromptRequest {
    /// Build a request from a loaded command and the launch context.
    /// `needs_admin` is decided once at launch time by [`resolve_command_launch`]
    /// (it consults the OS keychain), so the window shows the password field only
    /// when a password actually needs collecting. `selected_path` /
    /// `working_dir_override` carry the shell context.
    pub fn from_command(
        cmd: &CommandRecord,
        needs_admin: bool,
        selected_path: Option<String>,
        working_dir_override: Option<String>,
    ) -> Self {
        QuickPromptRequest {
            command_id: cmd.id.clone(),
            command_name: cmd.name.clone(),
            variables: cmd.variables.clone(),
            needs_admin,
            selected_path,
            working_dir_override,
        }
    }
}

/// Captured detail persisted on the `quickLaunch` history event — exit code,
/// duration, console output, extraction result. All optional: populated for a
/// command run that produced an outcome, `output`-only for a workflow run, and
/// empty for an entity that never ran (not found / spawn failure).
#[derive(Debug, Default)]
struct CapturedDetail {
    exit_code: Option<i32>,
    duration_ms: Option<u64>,
    output: Option<Vec<storage_history::HistoryLogLine>>,
    result: Option<storage_history::HistoryExtractedResult>,
}

/// Map a command's terminal outcome to a recorded launch status. A clean exit 0
/// is success; any non-zero exit, signal kill, or error is recorded as error.
fn classify_outcome(outcome: &NodeOutcome) -> LaunchStatus {
    match outcome.status {
        TerminalStatus::Finished if outcome.exit_code == Some(0) => LaunchStatus::Success,
        _ => LaunchStatus::Error,
    }
}

/// Pull the persisted detail (exit code, duration, output, extraction) out of a
/// command's terminal outcome.
fn capture_from_outcome(outcome: &NodeOutcome) -> CapturedDetail {
    CapturedDetail {
        exit_code: outcome.exit_code,
        duration_ms: Some(outcome.duration_ms),
        output: outcome
            .output
            .as_deref()
            .map(storage_history::from_captured_lines),
        result: outcome
            .extracted
            .as_ref()
            .map(storage_history::extracted_to_history),
    }
}

/// Record the `quickLaunch` history event for a fire that produced no capture
/// (not found / spawn failure) and return the [`LaunchOutcome`]. A thin wrapper
/// over [`record_outcome`] for the early-return paths.
async fn record_and_return(
    pool: &DbPool,
    kind: LaunchKind,
    id: &str,
    entity_name: &str,
    source: LaunchSource,
    selected_path: Option<String>,
    status: LaunchStatus,
) -> LaunchOutcome {
    record_outcome(
        pool,
        kind,
        id,
        entity_name,
        source,
        selected_path,
        status,
        &CapturedDetail::default(),
    )
    .await;
    LaunchOutcome {
        status,
        entity_name: entity_name.to_string(),
    }
}

/// Persist a single `quickLaunch` history event. History failures are logged
/// but never propagated — a quick-launch must not crash its caller (tray menu
/// handler / single-instance hook).
#[allow(clippy::too_many_arguments)]
async fn record_outcome(
    pool: &DbPool,
    kind: LaunchKind,
    id: &str,
    entity_name: &str,
    source: LaunchSource,
    selected_path: Option<String>,
    status: LaunchStatus,
    capture: &CapturedDetail,
) {
    let event = HistoryEvent {
        id: uuid::Uuid::new_v4().to_string(),
        created_at: Local::now().to_rfc3339(),
        payload: HistoryEventPayload::QuickLaunch {
            target_kind: kind.as_str().to_string(),
            target_id: id.to_string(),
            target_name: entity_name.to_string(),
            source: source.as_str().to_string(),
            selected_path,
            status: status.as_str().to_string(),
            exit_code: capture.exit_code,
            duration_ms: capture.duration_ms,
            output: capture.output.clone(),
            result: capture.result.clone(),
        },
    };
    if let Err(e) = storage_history::insert_event(pool, &event).await {
        tracing::error!(
            target_id = %id,
            "quick-launch: failed to record history: {e}"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::commands::VariableSpec;

    #[test]
    fn launch_kind_round_trips() {
        assert_eq!(LaunchKind::Command.as_str(), "command");
        assert_eq!(LaunchKind::Workflow.as_str(), "workflow");
        assert_eq!(LaunchKind::parse_kind("command"), Some(LaunchKind::Command));
        assert_eq!(
            LaunchKind::parse_kind("workflow"),
            Some(LaunchKind::Workflow)
        );
        assert_eq!(LaunchKind::parse_kind("schedule"), None);
        assert_eq!(LaunchKind::parse_kind(""), None);
    }

    #[test]
    fn launch_source_strings_are_stable() {
        assert_eq!(LaunchSource::Tray.as_str(), "tray");
        assert_eq!(LaunchSource::Shell.as_str(), "shell");
    }

    #[test]
    fn launch_status_strings_are_stable() {
        assert_eq!(LaunchStatus::Success.as_str(), "success");
        assert_eq!(LaunchStatus::Error.as_str(), "error");
        assert_eq!(LaunchStatus::MissingVariable.as_str(), "missingVariable");
        assert_eq!(LaunchStatus::NotFound.as_str(), "notFound");
    }

    #[test]
    fn parse_entity_ref_splits_on_first_colon() {
        assert_eq!(
            parse_entity_ref("command:abc"),
            Some((LaunchKind::Command, "abc".to_string()))
        );
        assert_eq!(
            parse_entity_ref("workflow:wf-1"),
            Some((LaunchKind::Workflow, "wf-1".to_string()))
        );
        // First-colon split keeps an id with embedded colons intact.
        assert_eq!(
            parse_entity_ref("command:a:b:c"),
            Some((LaunchKind::Command, "a:b:c".to_string()))
        );
        // Unknown kind / empty id / no colon are rejected.
        assert_eq!(parse_entity_ref("schedule:x"), None);
        assert_eq!(parse_entity_ref("command:"), None);
        assert_eq!(parse_entity_ref("command"), None);
    }

    #[test]
    fn parse_run_args_none_when_not_a_run_favorite() {
        assert_eq!(parse_run_args::<&str>(&[]), None);
        assert_eq!(parse_run_args(&["--autostart"]), None);
        assert_eq!(parse_run_args(&["/some/file.txt"]), None);
    }

    #[test]
    fn parse_run_args_without_path() {
        let got = parse_run_args(&["--run-favorite", "command:c1"]);
        assert_eq!(
            got,
            Some(RunArgs {
                kind: LaunchKind::Command,
                id: "c1".into(),
                selected_path: None,
            })
        );
    }

    #[test]
    fn parse_run_args_with_valid_existing_path() {
        // The temp dir always exists, so it passes `is_safe_selected_path`.
        let dir = std::env::temp_dir();
        let dir_str = dir.to_str().unwrap();
        let got =
            parse_run_args(&["--run-favorite", "workflow:w1", "--path", dir_str]).expect("parsed");
        assert_eq!(got.kind, LaunchKind::Workflow);
        assert_eq!(got.id, "w1");
        assert_eq!(got.selected_path.as_deref(), Some(dir_str));
    }

    #[test]
    fn parse_run_args_drops_nonexistent_path_but_still_runs() {
        let got = parse_run_args(&[
            "--run-favorite",
            "command:c1",
            "--path",
            "/definitely/not/a/real/path/xyzzy",
        ])
        .expect("parsed");
        // The favorite still runs; the bogus path is dropped.
        assert_eq!(got.id, "c1");
        assert_eq!(got.selected_path, None);
    }

    #[test]
    fn parse_run_args_malformed_favorite_is_none() {
        // Missing value after --run-favorite.
        assert_eq!(parse_run_args(&["--run-favorite"]), None);
        // Unknown kind.
        assert_eq!(parse_run_args(&["--run-favorite", "schedule:x"]), None);
        // Empty id.
        assert_eq!(parse_run_args(&["--run-favorite", "command:"]), None);
    }

    #[test]
    fn is_safe_selected_path_rejects_injection_vectors() {
        // Empty.
        assert!(!is_safe_selected_path(""));
        // Embedded NUL.
        assert!(!is_safe_selected_path("/tmp/evil\0/etc/passwd"));
        // Other control characters (newline / carriage return / tab).
        assert!(!is_safe_selected_path("/tmp/a\nb"));
        assert!(!is_safe_selected_path("/tmp/a\rb"));
        assert!(!is_safe_selected_path("/tmp/a\tb"));
        // Non-existent path.
        assert!(!is_safe_selected_path("/no/such/path/zzzz"));
    }

    #[test]
    fn is_safe_selected_path_accepts_existing_path() {
        let dir = std::env::temp_dir();
        assert!(is_safe_selected_path(dir.to_str().unwrap()));
    }

    fn var(name: &str, default: Option<&str>, sensitive: bool, prompt: bool) -> VariableSpec {
        VariableSpec {
            name: name.into(),
            default_value: default.map(Into::into),
            prompt_at_runtime: prompt,
            description: None,
            sensitive,
        }
    }

    fn cmd_with(vars: Vec<VariableSpec>, run_as_admin: bool) -> CommandRecord {
        CommandRecord {
            id: "cmd-1".into(),
            name: "Build".into(),
            name_key: None,
            description: None,
            description_key: None,
            icon: None,
            script: "echo hi".into(),
            shell: None,
            args: None,
            working_dir: None,
            env: None,
            tags: vec![],
            category_id: None,
            favorite: true,
            created_at: "2026-06-30T00:00:00Z".into(),
            updated_at: "2026-06-30T00:00:00Z".into(),
            last_run_at: None,
            run_count: 0,
            run_as_admin,
            variables: vars,
            timeout_seconds: None,
            output_schema: None,
            scope: None,
            workflow_id: None,
            target: None,
            api_slug: None,
            api_enabled: false,
            explorer_enabled: false,
            explorer_path_variable: None,
            sound: None,
        }
    }

    fn no_provided() -> std::collections::BTreeSet<String> {
        std::collections::BTreeSet::new()
    }

    #[test]
    fn needs_interaction_false_for_no_variables_no_admin() {
        let cmd = cmd_with(vec![], false);
        assert!(!command_needs_interaction(&cmd, &no_provided()));
    }

    #[test]
    fn needs_interaction_false_when_all_variables_have_defaults() {
        let cmd = cmd_with(
            vec![
                var("host", Some("localhost"), false, false),
                var("port", Some("8080"), false, false),
            ],
            false,
        );
        assert!(!command_needs_interaction(&cmd, &no_provided()));
    }

    #[test]
    fn needs_interaction_true_for_required_variable_without_default() {
        let cmd = cmd_with(vec![var("target", None, false, false)], false);
        assert!(command_needs_interaction(&cmd, &no_provided()));
    }

    #[test]
    fn needs_interaction_true_for_sensitive_even_with_default() {
        // A sensitive spec always asks, even if a (stripped) default existed.
        let cmd = cmd_with(vec![var("token", Some("x"), true, false)], false);
        assert!(command_needs_interaction(&cmd, &no_provided()));
    }

    #[test]
    fn needs_interaction_true_for_prompt_at_runtime_even_with_default() {
        let cmd = cmd_with(vec![var("env", Some("dev"), false, true)], false);
        assert!(command_needs_interaction(&cmd, &no_provided()));
    }

    #[test]
    fn provided_value_satisfies_a_required_variable() {
        // The shell launch supplies PROCMIX_SELECTED_PATH, satisfying a
        // required variable of that name — no prompt needed.
        let cmd = cmd_with(vec![var(SELECTED_PATH_VAR, None, false, false)], false);
        let mut provided = std::collections::BTreeSet::new();
        provided.insert(SELECTED_PATH_VAR.to_string());
        assert!(!command_needs_interaction(&cmd, &provided));
        // …but with nothing provided, the same command must prompt.
        assert!(command_needs_interaction(&cmd, &no_provided()));
    }

    #[test]
    fn provided_value_does_not_suppress_sensitive() {
        // Even if a sensitive var shares the provided name, it still asks.
        let cmd = cmd_with(vec![var(SELECTED_PATH_VAR, None, true, false)], false);
        let mut provided = std::collections::BTreeSet::new();
        provided.insert(SELECTED_PATH_VAR.to_string());
        assert!(command_needs_interaction(&cmd, &provided));
    }

    #[test]
    fn command_needs_interaction_ignores_admin_flag() {
        // `command_needs_interaction` is now variables-only; an elevated
        // command with no variables does NOT need variable interaction. The
        // admin-password decision is keychain-aware and lives separately in
        // `admin_password_needed` / `resolve_command_launch`.
        let cmd = cmd_with(vec![], true);
        assert!(!command_needs_interaction(&cmd, &no_provided()));
    }

    #[test]
    fn admin_password_needed_false_for_non_elevated_command() {
        let cmd = cmd_with(vec![], false);
        assert!(!admin_password_needed(&cmd));
    }

    #[test]
    fn admin_password_needed_false_on_windows() {
        // On Windows, elevation is UAC — never a ProcMix-collected password.
        let cmd = cmd_with(vec![], true);
        if cfg!(windows) {
            assert!(!admin_password_needed(&cmd));
        }
    }

    #[test]
    fn quick_prompt_request_bundles_command_data() {
        let cmd = cmd_with(vec![var("target", None, false, false)], false);
        let req = QuickPromptRequest::from_command(
            &cmd,
            false,
            Some("/home/user/project".into()),
            Some("/home/user/project".into()),
        );
        assert_eq!(req.command_id, "cmd-1");
        assert_eq!(req.command_name, "Build");
        assert_eq!(req.variables.len(), 1);
        assert_eq!(req.variables[0].name, "target");
        assert!(!req.needs_admin);
        assert_eq!(req.selected_path.as_deref(), Some("/home/user/project"));
        assert_eq!(
            req.working_dir_override.as_deref(),
            Some("/home/user/project")
        );
    }

    #[test]
    fn quick_prompt_request_needs_admin_is_passed_through() {
        let cmd = cmd_with(vec![], false);
        let req = QuickPromptRequest::from_command(&cmd, true, None, None);
        assert!(req.needs_admin);
    }

    #[test]
    fn quick_prompt_request_serialises_camel_case_and_omits_none() {
        let cmd = cmd_with(vec![], false);
        let req = QuickPromptRequest::from_command(&cmd, false, None, None);
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["commandId"], "cmd-1");
        assert_eq!(json["commandName"], "Build");
        assert_eq!(json["needsAdmin"], false);
        assert!(json.get("selectedPath").is_none());
        assert!(json.get("workingDirOverride").is_none());
        // snake_case must never leak.
        assert!(json.get("command_id").is_none());
    }

    async fn make_pool() -> DbPool {
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../../storage/schema.sql"))
            .execute(&pool)
            .await
            .unwrap();
        std::sync::Arc::new(pool)
    }

    #[tokio::test]
    async fn resolve_command_launch_unavailable_for_missing_command() {
        let pool = make_pool().await;
        let plan = resolve_command_launch(&pool, "nope", LaunchSource::Tray, None).await;
        assert!(matches!(plan, CommandLaunchPlan::Unavailable));
    }

    #[tokio::test]
    async fn resolve_command_launch_headless_for_simple_command() {
        let pool = make_pool().await;
        storage_commands::upsert(&pool, &cmd_with(vec![], false))
            .await
            .unwrap();
        let plan = resolve_command_launch(&pool, "cmd-1", LaunchSource::Tray, None).await;
        assert!(matches!(plan, CommandLaunchPlan::Headless { .. }));
    }

    #[tokio::test]
    async fn resolve_command_launch_needs_prompt_for_required_variable() {
        let pool = make_pool().await;
        storage_commands::upsert(
            &pool,
            &cmd_with(vec![var("target", None, false, false)], false),
        )
        .await
        .unwrap();
        let plan = resolve_command_launch(&pool, "cmd-1", LaunchSource::Tray, None).await;
        assert!(matches!(plan, CommandLaunchPlan::NeedsPrompt { .. }));
    }

    #[tokio::test]
    async fn resolve_command_launch_path_satisfies_required_var_headless() {
        let pool = make_pool().await;
        storage_commands::upsert(
            &pool,
            &cmd_with(vec![var(SELECTED_PATH_VAR, None, false, false)], false),
        )
        .await
        .unwrap();
        // A shell launch supplying the path satisfies the only required var.
        let dir = std::env::temp_dir();
        let plan = resolve_command_launch(
            &pool,
            "cmd-1",
            LaunchSource::Shell,
            Some(dir.to_str().unwrap().to_string()),
        )
        .await;
        match plan {
            CommandLaunchPlan::Headless {
                working_dir_override,
                ..
            } => {
                // The temp dir is a directory, so it also becomes the working dir.
                assert_eq!(working_dir_override.as_deref(), Some(dir.to_str().unwrap()));
            }
            _ => panic!("expected headless plan"),
        }
    }
}
