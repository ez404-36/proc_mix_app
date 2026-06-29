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

// Shared with `core::sftp`, which spawns the system `sftp` binary using the
// same `procmix-askpass` password transport and Unix process-group setup as a
// remote `ssh` run. Re-exported (rather than duplicated) so the askpass-helper
// resolution and the `setsid` shim stay single-sourced.
#[cfg(unix)]
pub(crate) use command_build::{askpass_helper_path, libc_setsid};

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
        tracing::error!("failed to emit execution event: {err}");
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

/// Compute the effective working directory shown in the `Started` event,
/// mirroring the cwd the executor actually applies in
/// [`command_build::build_command`]: the command's resolved `working_dir`,
/// or the user's home directory when none is set. Returns `None` for a
/// remote (SSH) target — the local cwd does not apply to a run on another
/// host — and when neither a `working_dir` nor a home directory can be
/// resolved (the rare case where the child inherits this process's cwd).
fn effective_working_dir(
    resolved: &ResolvedScript,
    target: &ExecutionTarget,
) -> Option<String> {
    if matches!(target, ExecutionTarget::Remote { .. } | ExecutionTarget::RemotePrompt) {
        return None;
    }
    match resolved.working_dir.as_ref() {
        Some(dir) => Some(dir.clone()),
        None => dirs::home_dir().map(|h| h.to_string_lossy().into_owned()),
    }
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
    mut req: ExecuteRequest,
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
    // Canonicalise the id ON the request so `build_command` uses the SAME id
    // we use everywhere else — the remote password path keys its throwaway
    // keychain entry (and the askpass env var) on it, and the finalizer below
    // clears that entry by the same id.
    req.execution_id = Some(execution_id.clone());
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

    // Resolve where the bundled `procmix-askpass` helper lives so the remote
    // password-auth path can point `ssh` at it. `bundle.resources` ships it
    // into the platform resource dir (NOT next to the executable), so we ask
    // the Tauri `PathResolver`. A failure here is non-fatal — the resolver
    // inside `build_command` falls back to the `current_exe()`-sibling layout
    // (dev / co-located packaging). Only the password path consults it.
    #[cfg(unix)]
    let askpass_resource_path: Option<std::path::PathBuf> = {
        use tauri::Manager;
        app.path()
            .resolve("procmix-askpass", tauri::path::BaseDirectory::Resource)
            .ok()
    };
    #[cfg(not(unix))]
    let askpass_resource_path: Option<std::path::PathBuf> = None;

    // Build the Command (working-dir validation, env, stdio, pre_exec).
    let mut cmd = command_build::build_command(
        program,
        prefix_args,
        &resolved,
        &req,
        &global_env,
        askpass_resource_path.as_deref(),
    )?;

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
    // genuine ISOLATION (not just leadership) before storing — if setsid()
    // failed with EPERM the child inherited ProcMix's own login/session
    // group, and a killpg against that would kill the whole desktop. The
    // resolver rejects any group equal to our own pgid/session, so we fall
    // back to single-process kill, never to a killpg against the session.
    // This guard protects every group-kill site (cancel, timeout, the
    // elevated `sudo kill -<pgid>`, and the shutdown hook) since they all
    // consume this one stored `pgid`.
    #[cfg(unix)]
    let pgid: Option<i32> = pid.and_then(|p| command_build::resolve_isolated_pgid(p as i32));

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Resolved (sensitive-masked) variables for the console, so a run the
    // frontend did NOT initiate (scheduler / workflow node) shows them just
    // like a direct library run. Empty for commands without variables, so
    // the field is omitted from the wire (legacy payloads unchanged).
    let started_variables = build_execution_variables(&req.variables, &req.variable_values);

    // Effective cwd the child was launched in, so the console can show WHERE
    // the command runs. Mirrors the executor's own resolution in
    // `command_build` (resolved dir → home fallback); `None` for remote runs.
    let started_working_dir = effective_working_dir(&resolved, &req.target);

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
                working_dir: started_working_dir,
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
                // Stored so the shutdown hook can group-kill synchronously when
                // the runtime is torn down before the waiter can react.
                #[cfg(unix)]
                pgid,
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
        // True iff the remote password path parked a one-shot keychain entry
        // for this run (Unix + remote target + a non-blank ssh_password). The
        // waiter clears it on the terminal outcome; a local / key-auth run
        // leaves this false and never touches the keychain.
        #[cfg(unix)]
        clear_ssh_oneshot: matches!(req.target, ExecutionTarget::Remote { .. })
            && req
                .ssh_password
                .as_deref()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false),
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

/// Synchronously tear down every in-flight run. Called from the Tauri exit
/// hook (`RunEvent::ExitRequested`) where the async runtime is winding down,
/// so this must NOT be async and must not depend on waiter tasks getting
/// scheduled.
///
/// For each running entry it:
///   - (Unix) sends `SIGTERM` to the child's process group, which includes a
///     remote run's local `ssh` — without this, `ssh` is detached (`setsid`)
///     and would linger as an orphan after the app exits;
///   - (Unix) clears the run's throwaway one-shot SSH-password keychain entry
///     (idempotent: a local / key-auth run has none, so it's a cheap no-op).
///
/// Best-effort: errors are ignored (we're exiting) and a `kill -9` of ProcMix
/// itself can't be intercepted here. The registry is emptied at the end.
pub fn shutdown_all_sync(state: &ExecutorState) {
    // `blocking_lock` is correct here: we are on the main thread during exit,
    // not inside an async task, and we want the kills to complete before the
    // process goes away. The waiter tasks that also hold this lock briefly are
    // about to be dropped with the runtime.
    let mut running = state.running.blocking_lock();
    for (_execution_id, _entry) in running.iter() {
        #[cfg(unix)]
        {
            // SIGTERM the whole group (best-effort). The group leader is the
            // spawned child (setsid made it a session/group leader); for a
            // remote run that's the local `ssh`. Re-check isolation so app
            // exit can never SIGTERM ProcMix's own login/session group.
            if let Some(g) = _entry
                .pgid
                .filter(|&g| command_build::pgid_is_safe_target(g))
            {
                let _ = command_build::libc_killpg(g, command_build::SIGTERM);
            }
            // Clear any one-shot SSH password parked under this run id.
            // Idempotent; the value is never in the error.
            let _ = crate::security::ssh_oneshot::clear(_execution_id);
        }
    }
    running.clear();
}

#[cfg(all(test, unix))]
mod shutdown_tests {
    use super::*;
    use crate::core::executor::command_build::{libc_getpgid, libc_setsid};
    use std::os::unix::process::CommandExt;
    use std::process::{Command as StdCommand, Stdio};

    /// Spawn a `setsid` `sleep` child (its own process group, pgid == pid),
    /// mirroring the production spawn. Returns the std `Child` + its pgid.
    fn spawn_setsid_sleep() -> (std::process::Child, i32) {
        let mut cmd = StdCommand::new("sleep");
        cmd.arg("60");
        cmd.stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null());
        unsafe {
            cmd.pre_exec(|| {
                let _ = libc_setsid();
                Ok(())
            });
        }
        let child = cmd.spawn().expect("sleep must be installed");
        let pid = child.id() as i32;
        let g = libc_getpgid(pid);
        let pgid = if g == pid { Some(g) } else { None };
        (child, pgid.expect("setsid child must lead its own group"))
    }

    /// `kill(pid, 0)` probes liveness without sending a signal: 0 → alive,
    /// -1/ESRCH → gone.
    fn is_alive(pid: i32) -> bool {
        extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        unsafe { kill(pid, 0) == 0 }
    }

    /// `shutdown_all_sync` SIGTERMs every running entry's group and empties the
    /// registry. Built on real processes, like the waiter kill-path tests.
    ///
    /// `blocking_lock` panics inside an async context, so the shutdown call is
    /// hopped onto a plain OS thread (no runtime), while the child spawn +
    /// registry insert happen on the multi-thread runtime.
    #[test]
    fn shutdown_all_sync_kills_groups_and_clears_registry() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();

        let state = Arc::new(ExecutorState::new());
        let (mut child, pgid) = spawn_setsid_sleep();
        let pid = child.id() as i32;

        // Register a synthetic running entry for this child.
        rt.block_on(async {
            state.running.lock().await.insert(
                "shutdown-test".to_string(),
                RunningEntry {
                    cancel_tx: None,
                    pgid: Some(pgid),
                },
            );
        });
        assert!(is_alive(pid), "child should be alive before shutdown");

        // Call the sync shutdown OUTSIDE any async context.
        let state_for_thread = state.clone();
        std::thread::spawn(move || {
            shutdown_all_sync(&state_for_thread);
        })
        .join()
        .unwrap();

        // The registry is emptied.
        rt.block_on(async {
            assert!(state.running.lock().await.is_empty());
        });

        // The child receives SIGTERM and exits. Reap it (with a short bound)
        // so we don't leak a zombie, and confirm it's gone.
        for _ in 0..50 {
            if let Ok(Some(_)) = child.try_wait() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let _ = child.try_wait();
        assert!(!is_alive(pid), "child must be dead after shutdown SIGTERM");
    }
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
