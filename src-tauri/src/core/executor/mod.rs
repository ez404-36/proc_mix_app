// Command execution engine.
//
// Responsible for spawning shell commands asynchronously and streaming
// their stdout/stderr to the frontend via Tauri events.
//
// This is a thin orchestrator over the focused submodules:
//   - `types`         — IPC DTOs, events, constants (re-exported below).
//   - `privilege`     — Unix sudo-password resolution.
//   - `command_build` — shell mapping, elevated argv, `Command` assembly,
//                        and the `libc` shim for process-group control.
//   - `streaming`     — stdout/stderr reader tasks (redaction + buffer).
//   - `waiter`        — the wait/kill/extract/terminal-event task.
//
// The public surface (`spawn_execution`, `spawn_execution_with_completion`,
// `cancel_execution`, and all re-exported types) is byte-identical to the
// pre-refactor single-file module, so `commands/mod.rs` and
// `core/workflow.rs` keep their existing `crate::core::executor::*` imports.

mod command_build;
mod privilege;
mod streaming;
mod types;
mod waiter;

// Re-export the IPC-boundary types so callers keep importing them from
// `crate::core::executor::*` unchanged.
pub use types::*;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Instant;

use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::core::parser::{self, CommandTemplate, ResolvedScript};

use waiter::WaiterCtx;

/// Emit an `execution-event` to the frontend, logging (but not failing
/// on) a transport error. Shared by the streaming readers and the waiter.
pub(crate) fn emit_event<R: Runtime>(app: &AppHandle<R>, event: &ExecutionEvent) {
    if let Err(err) = app.emit(EXECUTION_EVENT, event) {
        eprintln!("failed to emit execution event: {}", err);
    }
}

/// Build the display-ready, sensitive-masked variable list for the
/// `Started` event. Mirrors the TS `buildExecutionVariables`
/// (`src/utils/runCommand.ts`): one entry per declared spec, in declaration
/// order, carrying the value the run resolved to (the per-run value, or the
/// spec default when the run map has no entry). Specs with no resolved value
/// are skipped (nothing meaningful to show); a `sensitive` spec's value is
/// masked to `REDACTED` so the raw secret never crosses the IPC boundary.
fn build_execution_variables(
    variables: &[crate::storage::commands::VariableSpec],
    values: &BTreeMap<String, String>,
) -> Vec<ExecutionVariableDto> {
    let mut out = Vec::new();
    for spec in variables {
        let resolved = values
            .get(&spec.name)
            .cloned()
            .or_else(|| spec.default_value.clone());
        let Some(value) = resolved else { continue };
        out.push(ExecutionVariableDto {
            name: spec.name.clone(),
            value: if spec.sensitive {
                crate::core::redact::REDACTED.to_string()
            } else {
                value
            },
            sensitive: spec.sensitive,
        });
    }
    out
}

/// Spawn a command execution, streaming output via `execution-event`.
///
/// This is the historical public entry point. It delegates to
/// [`spawn_execution_with_completion`] with no internal completion
/// channel, so its behavior is byte-identical to before that channel
/// existed — every existing caller and test keeps working unchanged.
pub async fn spawn_execution<R: Runtime>(
    app: AppHandle<R>,
    state: Arc<ExecutorState>,
    req: ExecuteRequest,
) -> Result<String, String> {
    spawn_execution_with_completion(app, state, req, None).await
}

/// Spawn a command execution with an optional internal completion
/// channel.
///
/// When `completion_tx` is `Some`, the waiter task sends exactly one
/// [`NodeOutcome`] on it when the run reaches any terminal state
/// (finished / cancelled / error), IN ADDITION to emitting the public
/// `execution-event`. When `None` (every pre-existing caller, via
/// [`spawn_execution`]), the behavior is exactly today's — no extra
/// work is done.
///
/// The channel is a `oneshot`, so the runner that owns the receiver
/// learns the node's exit code without subscribing to the Tauri event
/// bus. The send is best-effort: if the receiver was dropped (runner
/// cancelled, workflow torn down) the error is ignored — the public
/// event has already been emitted and remains the source of truth for
/// the UI.
pub async fn spawn_execution_with_completion<R: Runtime>(
    app: AppHandle<R>,
    state: Arc<ExecutorState>,
    req: ExecuteRequest,
    completion_tx: Option<oneshot::Sender<NodeOutcome>>,
) -> Result<String, String> {
    // Prefer the caller-supplied id so the JS side can pre-register state
    // (e.g. transient marks, refs) keyed on it before invoking. Fall back
    // to a fresh UUID for normal runs that don't need pre-registration.
    let execution_id = req
        .execution_id
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let command_id = req.command_id.clone();
    // Tag every event from this run with the workflow run id (when this
    // execution is a workflow node) so the frontend can fold its output
    // into the single aggregated workflow process. `None` for direct
    // runs — the field is then omitted from the wire entirely.
    let workflow_run_id = req.workflow_run_id.clone();

    // Part 4: a SILENT run (planned cron fire) still spawns the process,
    // still buffers capture, and still returns a NodeOutcome — but emits NO
    // `execution-event`s to the live console. The history record is the
    // source of truth for such runs. Threaded into the streaming readers and
    // the waiter so every emit site can honour it.
    let silent = req.silent;

    // Part 3C: when capture is requested, allocate the shared bounded buffer
    // both reader tasks push into (interleaved stdout+stderr). `None` for every
    // run that did not ask for capture — zero extra work and `NodeOutcome.output`
    // stays `None`. `std::sync::Mutex` (not tokio) because the readers only ever
    // lock it briefly to push a line — never across an await.
    let capture_buffer: Option<Arc<std::sync::Mutex<CaptureBuffer>>> = if req.capture_output {
        Some(Arc::new(std::sync::Mutex::new(CaptureBuffer::default())))
    } else {
        None
    };

    // M1: the set of secret values to scrub from streamed stdout/stderr and
    // any persisted history snapshot — the resolved value of every variable
    // marked `sensitive`. Computed once here and shared (Arc) into the reader
    // tasks. Empty for every command without a sensitive variable, so the
    // common path does zero extra work. See `core::redact`.
    let sensitive_values = Arc::new(crate::core::redact::collect_sensitive_values(
        &req.variables,
        &req.variable_values,
    ));

    let shell_name = req
        .shell
        .clone()
        .unwrap_or_else(|| command_build::default_shell().to_string());
    let (program, prefix_args) = command_build::shell_invocation(&shell_name);
    let raw_extra_args: Vec<String> = req.args.clone().unwrap_or_default();
    let raw_env: BTreeMap<String, String> = req
        .env
        .as_ref()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    let raw_working_dir: Option<String> = req
        .working_dir
        .as_ref()
        .and_then(|p| p.to_str().map(|s| s.to_string()));

    // ------------------------------------------------------------------
    // Variable substitution.
    //
    // Resolve `${name}` / `${name:default}` / `$$` BEFORE building the
    // Command so the child process never sees the raw template. On
    // failure (missing variable, malformed reference) we bail with a
    // typed `ExecutorError` serialised to a `{ code, message }` JSON
    // shape — the JS bridge dispatches on `code`. Doing this before
    // the elevated-path keychain read is intentional: a malformed
    // template should fail fast without prompting the user for a sudo
    // password they then can't use.
    //
    // SECURITY: substitution is purely textual (see parser.rs module
    // docs). Sensitive values are NOT redacted in the resolved struct
    // — the child must receive the real value. Redaction applies only
    // to log lines and event previews; build them via
    // `parser::resolve` with sensitive vars overridden to "***" when
    // adding such a code path. Currently no log line interpolates a
    // resolved value.
    // ------------------------------------------------------------------
    let template = CommandTemplate {
        script: &req.script,
        args: &raw_extra_args,
        working_dir: raw_working_dir.as_deref(),
        env: &raw_env,
        variables: &req.variables,
    };
    let resolved: ResolvedScript = match parser::resolve(&template, &req.variable_values) {
        Ok(r) => r,
        Err(e) => return Err(ExecutorError::from_parse(&e).to_wire_string()),
    };

    // ------------------------------------------------------------------
    // Elevated-path preconditions.
    //
    // On Unix we must have a password in the OS keychain (or a one-shot
    // value on the request) before we even build the Command — otherwise
    // sudo would wait forever on stdin and we'd have to kill it from
    // outside. `resolve_admin_password` returns the sentinel string
    // verbatim so the JS bridge can detect it via equality and open the
    // admin-password prompt without parsing free-form text.
    //
    // On Windows the elevated branch is reached via `Start-Process
    // -Verb RunAs` which triggers UAC; no password is read here, so
    // there is nothing to precondition. The binding is gated to Unix.
    // ------------------------------------------------------------------
    #[cfg(unix)]
    let admin_password: Option<String> = privilege::resolve_admin_password(&req)?;

    // Keep a copy of the elevation context for the KILL path. When the
    // run is elevated, the child tree runs as root; a `killpg` issued by
    // this (non-root) process fails with EPERM and the privileged
    // children (e.g. a root-owned `find`) keep running to completion —
    // which is exactly the "timeout fired but the command didn't stop"
    // bug. To actually stop them we must re-elevate the kill via `sudo`,
    // so the waiter needs the password too. `None` for non-elevated runs
    // (the ordinary `killpg` works there).
    #[cfg(unix)]
    let kill_password: Option<String> = if req.elevated {
        admin_password.clone()
    } else {
        None
    };

    // Load the registered global .env files and merge them into a single map.
    // These are injected with LOWER precedence than the per-command env (see
    // `build_command`), so `Command.env` always wins. Loading the path list
    // is cheap (a small JSON file); parsing each .env happens on a blocking
    // thread. A failure to read the config list is non-fatal — we fall back
    // to an empty map so a missing/corrupt config never blocks a run.
    let global_env: BTreeMap<String, String> = {
        let paths = crate::storage::env_config::load_env_file_paths(&app)
            .await
            .unwrap_or_default();
        if paths.is_empty() {
            BTreeMap::new()
        } else {
            tokio::task::spawn_blocking(move || {
                crate::core::env_files::load_merged_env_files(&paths)
            })
            .await
            .unwrap_or_default()
        }
    };

    // Build the Command (working-dir validation, env, stdio, pre_exec).
    let mut cmd = command_build::build_command(program, prefix_args, &resolved, &req, &global_env)?;

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn process: {e}"))?;

    // Hand the password to sudo. Done immediately after spawn so the
    // waiting `sudo -S` reads it without timing out. We close stdin
    // afterwards (the `_` drop) so sudo's read loop terminates and the
    // child script — which only sees the post-sudo stdin — gets EOF.
    //
    // Unwrapping is safe inside this branch: `build_command` set
    // `Stdio::piped()` for stdin on the elevated Unix path. The whole
    // block is `#[cfg(unix)]` because Windows doesn't have a sudo path
    // here.
    #[cfg(unix)]
    if req.elevated {
        if let (Some(pw), Some(mut stdin)) = (admin_password, child.stdin.take()) {
            use tokio::io::AsyncWriteExt;
            // This is async stdin so a tokio task is correct. Writing
            // happens in the background so we don't block the executor's
            // caller while sudo is still authenticating.
            tokio::spawn(async move {
                let _ = stdin.write_all(pw.as_bytes()).await;
                let _ = stdin.write_all(b"\n").await;
                // Drop closes stdin. Belt-and-suspenders shutdown.
                let _ = stdin.shutdown().await;
            });
        }
    }

    let pid = child.id();

    // Resolve the child's process group. setsid() ran in pre_exec; if it
    // succeeded the child IS a session leader and pgid == pid. We confirm
    // via getpgid before storing — if the call fails (or returns a value
    // != pid), we fall back to single-process kill, never to a killpg
    // against an unrelated group.
    #[cfg(unix)]
    let pgid: Option<i32> = pid.and_then(|p| {
        let p_i = p as i32;
        let g = command_build::libc_getpgid(p_i);
        if g == p_i && g > 0 {
            Some(g)
        } else {
            None
        }
    });

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Resolved (sensitive-masked) variables for the console, so a run the
    // frontend did NOT initiate (scheduler / workflow node) shows them just
    // like a direct library run. Empty for commands without variables, so
    // the field is omitted from the wire (legacy payloads unchanged).
    let started_variables = build_execution_variables(&req.variables, &req.variable_values);

    // Suppress the live console emit for a silent (planned) fire; the run
    // still proceeds and is recorded in history.
    if !silent {
        emit_event(
            &app,
            &ExecutionEvent::Started {
                execution_id: execution_id.clone(),
                pid,
                command_id: command_id.clone(),
                variables: started_variables,
                workflow_run_id: workflow_run_id.clone(),
            },
        );
    }

    // Stream stdout/stderr. We KEEP the JoinHandles so the waiter task
    // can drain them before emitting the terminal event — see the
    // streaming module and the waiter drain step for the ordering
    // rationale. Buffer stdout when a schema is set (for extraction) OR when
    // this is a workflow node (for the `stdout_tail` a `Stdout`-subject
    // condition matches on). Direct library runs set neither, so they pay no
    // buffering cost and stay byte-identical to before.
    let capture_stdout = req.output_schema.is_some() || req.workflow_run_id.is_some();
    let stdout_task = streaming::spawn_stdout_reader(
        stdout,
        app.clone(),
        execution_id.clone(),
        workflow_run_id.clone(),
        sensitive_values.clone(),
        capture_stdout,
        capture_buffer.clone(),
        silent,
    );
    let stderr_task = streaming::spawn_stderr_reader(
        stderr,
        app.clone(),
        execution_id.clone(),
        workflow_run_id.clone(),
        sensitive_values.clone(),
        capture_buffer.clone(),
        silent,
    );

    // Build the cancel signal. The Sender lives in `state.running` and
    // is consumed by `cancel_execution`; the Receiver moves into the
    // waiter task, which `tokio::select!`s it against `child.wait()`.
    // This decouples cancellation from owning the `Child` — the waiter
    // remains the only owner from spawn to reap, so there is no race
    // with `start_kill` running on a `Child` that the waiter is also
    // about to drop.
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();

    // Register the cancellation handle. We deliberately do NOT store
    // the `Child` in the map any more — see RunningEntry's doc comment
    // for the rationale. `pgid` is captured above (Unix only).
    {
        let mut running = state.running.lock().await;
        running.insert(
            execution_id.clone(),
            RunningEntry {
                cancel_tx: Some(cancel_tx),
            },
        );
    }

    // Hand everything to the waiter task: it owns the `Child` for its
    // entire lifetime, races wait() vs cancel/timeout, drains the
    // readers, runs extraction, removes the registry entry, and emits
    // the terminal event + optional completion outcome.
    waiter::spawn_waiter(WaiterCtx {
        child,
        cancel_rx,
        app: app.clone(),
        execution_id: execution_id.clone(),
        command_id: command_id.clone(),
        workflow_run_id: workflow_run_id.clone(),
        timeout_seconds: req.timeout_seconds,
        output_schema: req.output_schema.clone(),
        stdout_task,
        stderr_task,
        running: state.running.clone(),
        start: Instant::now(),
        completion_tx,
        silent,
        capture_buffer,
        #[cfg(unix)]
        pgid,
        // The spawned child's pid (the outer `sudo`). Only used by the
        // elevated kill path: modern `sudo` may run the command in a NEW
        // session/process-group (pty mode), so a killpg against the outer
        // sudo's group misses the root-owned descendants. The tree sweep
        // walks `/proc` ppid links from this pid to catch them all.
        #[cfg(unix)]
        root_pid: pid.map(|p| p as i32),
        #[cfg(unix)]
        kill_password,
    });

    Ok(execution_id)
}

pub async fn cancel_execution(
    state: Arc<ExecutorState>,
    execution_id: String,
) -> Result<(), String> {
    // Take the sender out of the entry without removing the entry
    // itself — the waiter task removes it once `wait()` returns, which
    // is the only point at which the id is truly gone. This avoids the
    // race where a second cancel click between `take` and waiter
    // removal would find the entry missing and silently no-op even
    // though the first signal was already delivered.
    let mut map = state.running.lock().await;
    if let Some(entry) = map.get_mut(&execution_id) {
        if let Some(tx) = entry.cancel_tx.take() {
            // Receiver dropped means the waiter already exited (race
            // with natural completion). That's still a successful
            // cancel-from-the-user's-perspective: the run is over.
            let _ = tx.send(());
        }
    }
    // Not found: already reaped — treat as success so the UI can stay
    // idempotent across rapid clicks.
    Ok(())
}

#[cfg(test)]
mod build_variables_tests {
    use super::*;
    use crate::storage::commands::VariableSpec;

    fn spec(name: &str, default: Option<&str>, sensitive: bool) -> VariableSpec {
        VariableSpec {
            name: name.to_string(),
            default_value: default.map(|s| s.to_string()),
            prompt_at_runtime: false,
            description: None,
            sensitive,
        }
    }

    #[test]
    fn uses_per_run_value_and_preserves_declaration_order() {
        let specs = vec![spec("host", None, false), spec("port", Some("80"), false)];
        let mut values = BTreeMap::new();
        values.insert("host".to_string(), "example.com".to_string());
        // `port` has no run value → falls back to the spec default.
        let out = build_execution_variables(&specs, &values);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name, "host");
        assert_eq!(out[0].value, "example.com");
        assert_eq!(out[1].name, "port");
        assert_eq!(out[1].value, "80");
    }

    #[test]
    fn masks_sensitive_values() {
        let specs = vec![spec("token", None, true)];
        let mut values = BTreeMap::new();
        values.insert("token".to_string(), "s3cr3t".to_string());
        let out = build_execution_variables(&specs, &values);
        assert_eq!(out.len(), 1);
        assert!(out[0].sensitive);
        // Raw secret must NOT cross the boundary.
        assert_eq!(out[0].value, crate::core::redact::REDACTED);
        assert_ne!(out[0].value, "s3cr3t");
    }

    #[test]
    fn skips_specs_with_no_resolved_value() {
        // No run value and no default → nothing meaningful to show.
        let specs = vec![spec("optional", None, false)];
        let out = build_execution_variables(&specs, &BTreeMap::new());
        assert!(out.is_empty());
    }
}
