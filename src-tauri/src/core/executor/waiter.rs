// Waiter task for the execution engine.
//
// Owns the spawned `Child` for its entire lifetime, races `child.wait()`
// against the cancel signal and the optional timeout, performs the
// OS-level kill itself on cancel/timeout (group-wide on Unix, re-elevated
// via `sudo` for root-owned trees), drains the output readers, runs
// output extraction, removes the registry entry, and emits exactly one
// terminal `execution-event` plus the optional internal `NodeOutcome`.
//
// The `biased` select ordering and the strict "drain stdout → Result
// event → terminal event" sequence are load-bearing — see the inline
// comments and the kill-path tests at the bottom of this module.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Instant;

use tauri::{AppHandle, Runtime};
use tokio::process::Child;
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;

use crate::core::extractor::{self, ExtractedOutput};
use crate::storage::commands::OutputSchemaRecord;

use super::emit_event;
use super::types::{
    CaptureBuffer, CapturedLine, ExecutionEvent, NodeOutcome, RunningEntry, TerminalStatus,
    MAX_STDOUT_TAIL_BYTES,
};

/// Take the trailing slice of `text` no larger than [`MAX_STDOUT_TAIL_BYTES`],
/// snapped FORWARD to the next UTF-8 char boundary so the result is always
/// valid UTF-8 (never splits a multi-byte character). Returns `None` for an
/// empty string so a node that produced no stdout carries `stdout_tail: None`
/// rather than an empty `Some`.
fn stdout_tail(text: &str) -> Option<String> {
    if text.is_empty() {
        return None;
    }
    if text.len() <= MAX_STDOUT_TAIL_BYTES {
        return Some(text.to_string());
    }
    let mut start = text.len() - MAX_STDOUT_TAIL_BYTES;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    Some(text[start..].to_string())
}

#[cfg(unix)]
use super::command_build::{libc_killpg, SIGKILL, SIGTERM};

/// All state moved into the waiter task. Aggregating it into one struct
/// keeps `spawn_waiter`'s signature manageable while preserving every
/// field the original inline task captured.
pub(super) struct WaiterCtx<R: Runtime> {
    pub child: Child,
    pub cancel_rx: oneshot::Receiver<()>,
    pub app: AppHandle<R>,
    pub execution_id: String,
    pub command_id: Option<String>,
    pub workflow_run_id: Option<String>,
    pub timeout_seconds: Option<u64>,
    pub output_schema: Option<OutputSchemaRecord>,
    pub stdout_task: Option<JoinHandle<Option<String>>>,
    pub stderr_task: Option<JoinHandle<()>>,
    pub running: Arc<Mutex<HashMap<String, RunningEntry>>>,
    pub start: Instant,
    pub completion_tx: Option<oneshot::Sender<NodeOutcome>>,
    /// When `true` (planned cron fire), suppress every `execution-event` emit
    /// — `Result` and the terminal event — while still building and sending
    /// the `NodeOutcome`. The reader tasks already honour this for the
    /// per-line `Stdout`/`Stderr` events.
    pub silent: bool,
    /// Shared interleaved capture buffer (`Some` only when the request set
    /// `capture_output`). Drained into `NodeOutcome.output` after the reader
    /// tasks have finished pushing.
    pub capture_buffer: Option<Arc<StdMutex<CaptureBuffer>>>,
    /// Captured at spawn time; used for the group kill. Unix only.
    #[cfg(unix)]
    pub pgid: Option<i32>,
    /// The spawned child's pid (the outer `sudo` on elevated runs). Used by
    /// the elevated kill path to sweep the descendant tree, because `sudo`
    /// may put the command in a new session/pgrp that a killpg against the
    /// outer sudo's group would miss. Unix only.
    #[cfg(unix)]
    pub root_pid: Option<i32>,
    /// Used to re-elevate the kill when the child tree is root-owned.
    /// Unix only.
    #[cfg(unix)]
    pub kill_password: Option<String>,
    /// `true` when this run used the remote SSH password path, so a throwaway
    /// one-shot keychain entry was parked under `execution_id`. On the terminal
    /// outcome the waiter clears it (idempotent), guaranteeing the entry never
    /// outlives the run even if `ssh` exited before the askpass helper read it
    /// (key auth ultimately succeeded, or the connection failed early). Unix
    /// only — the password path doesn't exist elsewhere.
    #[cfg(unix)]
    pub clear_ssh_oneshot: bool,
}

/// Best-effort send of the terminal [`NodeOutcome`] on the optional
/// completion channel. A `None` channel (every non-workflow caller) is
/// a no-op; a dropped receiver (runner torn down) is ignored because
/// the public `execution-event` was already emitted and remains the
/// UI's source of truth.
fn send_completion(tx: Option<oneshot::Sender<NodeOutcome>>, outcome: NodeOutcome) {
    if let Some(tx) = tx {
        let _ = tx.send(outcome);
    }
}

/// Spawn the waiter task. Owns the `Child` for its entire lifetime, races
/// child.wait() against the cancel signal and timeout, performs the
/// OS-level kill itself on cancel/timeout, and finally removes the
/// registry entry and emits the terminal event.
///
/// The per-fire `tokio::spawn` here is correct: this runs inside an
/// already-running async command context (the runtime exists), so a bare
/// `tokio::spawn` is the right primitive — NOT `tauri::async_runtime`.
pub(super) fn spawn_waiter<R: Runtime>(ctx: WaiterCtx<R>) {
    let WaiterCtx {
        child,
        cancel_rx,
        app: app_for_wait,
        execution_id: id_for_wait,
        command_id: cmd_id_for_wait,
        workflow_run_id: wf_run_id_for_wait,
        timeout_seconds,
        output_schema: output_schema_for_wait,
        stdout_task,
        stderr_task,
        running: running_arc,
        start,
        completion_tx,
        silent,
        capture_buffer,
        #[cfg(unix)]
            pgid: pgid_for_wait,
        #[cfg(unix)]
            root_pid: root_pid_for_wait,
        #[cfg(unix)]
            kill_password: kill_password_for_wait,
        #[cfg(unix)]
        clear_ssh_oneshot,
    } = ctx;

    tokio::spawn(async move {
        let mut child = child;
        let mut cancel_rx = cancel_rx;
        // Moved into the task so we can await the output drain before
        // emitting the terminal event (see the join below).
        let stdout_task = stdout_task;
        let stderr_task = stderr_task;
        // Moved into the task so the terminal branches below can report
        // the outcome on it. `None` for every caller that went through
        // `spawn_execution` — see this fn's doc comment.
        let completion_tx = completion_tx;
        // `cancelled_by_user` lets us distinguish a user-initiated kill
        // (emit `Cancelled`) from a process that exited on its own with
        // a signal exit status (still `Cancelled`, historically — kept
        // for compatibility) versus a clean exit (`Finished`).
        let mut cancelled_by_user = false;
        let mut timed_out = false;

        // Build the timeout future. When `timeout_seconds` is `None`,
        // the future never completes (pending forever) so the select!
        // only races cancel vs child.wait — zero overhead for the
        // common no-timeout case.
        let timeout_duration = timeout_seconds.map(std::time::Duration::from_secs);
        let timeout_fut = async {
            match timeout_duration {
                Some(d) => tokio::time::sleep(d).await,
                None => std::future::pending().await,
            }
        };
        tokio::pin!(timeout_fut);

        let wait_result = tokio::select! {
            biased;
            // The cancel signal wins ties with a finishing child — that's
            // intentional so a click landing in the same poll tick as the
            // natural exit still flips the UI to Cancelled.
            _ = &mut cancel_rx => {
                cancelled_by_user = true;
                // A deliberate user cancel must stop the run NOW — send
                // SIGKILL straight away (group-wide) instead of the
                // SIGTERM→grace→SIGKILL sequence. The grace let a command
                // that ignores/handles SIGTERM (or finishes its work within
                // the 250ms window) run to completion, so the user saw the
                // command keep going and the status flip to "cancelled" only
                // after it had already finished. `immediate` skips the grace.
                kill_child_tree(
                    &mut child,
                    true, // immediate: user-initiated cancel
                    #[cfg(unix)] pgid_for_wait,
                    #[cfg(unix)] root_pid_for_wait,
                    #[cfg(unix)] kill_password_for_wait.as_deref(),
                ).await;
                child.wait().await
            }
            _ = &mut timeout_fut => {
                timed_out = true;
                // A timeout uses the graceful SIGTERM→grace→SIGKILL so the
                // process gets a chance to clean up before the hard kill.
                kill_child_tree(
                    &mut child,
                    false, // graceful: timeout
                    #[cfg(unix)] pgid_for_wait,
                    #[cfg(unix)] root_pid_for_wait,
                    #[cfg(unix)] kill_password_for_wait.as_deref(),
                ).await;
                child.wait().await
            }
            r = child.wait() => r,
        };

        // Drain the output streams to completion BEFORE emitting any
        // terminal event. The child has exited (naturally, by cancel, or
        // by timeout-kill), which closes its stdout/stderr pipes; the
        // reader tasks then hit EOF and finish. Awaiting them here
        // guarantees every buffered line has been emitted as a
        // `Stdout`/`Stderr` event ahead of `Finished`/`Cancelled`, so the
        // frontend never appends output AFTER it has shown the terminal
        // status. This is the fix for "the command keeps printing after
        // the timeout error appears".
        // Capture the buffered stdout (Some when a schema OR a workflow node
        // requested it) so extraction can run on the complete output below.
        let captured_stdout: Option<String> = match stdout_task {
            Some(task) => task.await.unwrap_or(None),
            None => None,
        };

        // Derive the bounded stdout tail the workflow runner uses for
        // `Stdout`-subject condition evaluation — but ONLY for workflow nodes,
        // so a direct run never retains it. Computed here, before the schema
        // branch below moves `captured_stdout`. The buffered text is already
        // sensitive-redacted (the streaming reader redacts each line first).
        let node_stdout_tail: Option<String> = if wf_run_id_for_wait.is_some() {
            captured_stdout.as_deref().and_then(stdout_tail)
        } else {
            None
        };
        if let Some(task) = stderr_task {
            let _ = task.await;
        }

        // Both reader tasks have finished pushing, so the shared capture buffer
        // is now complete and uncontended. Drain it into the owned Vec the
        // NodeOutcome carries. A truncation marker is appended so the consumer
        // (the scheduler) knows output was dropped at the in-memory cap. `None`
        // for every run that did not request capture.
        let captured_output: Option<Vec<CapturedLine>> = capture_buffer.map(|buf| {
            match Arc::try_unwrap(buf) {
                // Both reader tasks were awaited, so we normally own the only
                // remaining reference — take the buffer by value.
                Ok(mutex) => mutex
                    .into_inner()
                    .map(CaptureBuffer::into_lines)
                    .unwrap_or_default(),
                // A reader still holds a clone (shouldn't happen). Snapshot
                // under the lock as a fallback.
                Err(arc) => arc
                    .lock()
                    .map(|guard| guard.lines_snapshot())
                    .unwrap_or_default(),
            }
        });

        // Drop the registry entry now that the child has exited. Doing
        // this BEFORE emitting the terminal event means a follow-up
        // `list_running_executions()` from the JS side after observing
        // the event will not still see the id.
        {
            let mut map = running_arc.lock().await;
            map.remove(&id_for_wait);
        }

        // Clear the throwaway one-shot SSH password entry for this run, if the
        // remote password path parked one. Idempotent (a missing entry is not
        // an error) and runs on EVERY terminal outcome — finished, error,
        // cancelled, or timed out — so the secret never outlives its run, even
        // when key auth ultimately succeeded and the askpass helper never read
        // it. Only the password path sets the flag, so a local / key-auth run
        // skips the keychain entirely.
        #[cfg(unix)]
        if clear_ssh_oneshot {
            if let Err(e) = crate::security::ssh_oneshot::clear(&id_for_wait) {
                // The value is never in the error; log the failure so an
                // orphaned entry is at least diagnosable. `eprintln!` matches
                // the executor's existing logging (this crate has no `tracing`).
                eprintln!("failed to clear one-shot ssh password for {id_for_wait}: {e}");
            }
        }

        // Run output extraction (when a schema was declared) on the FULL
        // captured stdout, emit the `Result` event, and keep the
        // structured fields for the NodeOutcome so the workflow runner can
        // feed them into the next node. This happens AFTER the stdout/stderr
        // drain above and BEFORE any terminal event below — a deterministic
        // ordering the frontend relies on to attach the result to the
        // execution before it is marked done. Extraction is non-fatal: a
        // failure emits a `Result` carrying an `error` and leaves the run's
        // own status untouched.
        let extracted: Option<ExtractedOutput> =
            if let Some(schema) = output_schema_for_wait.as_ref() {
                let stdout_text = captured_stdout.unwrap_or_default();
                match extractor::extract(schema, &stdout_text) {
                    Ok(out) => {
                        // Suppress the live `Result` emit for a silent run; the
                        // structured fields still travel on the NodeOutcome.
                        if !silent {
                            emit_event(
                                &app_for_wait,
                                &ExecutionEvent::Result {
                                    execution_id: id_for_wait.clone(),
                                    command_id: cmd_id_for_wait.clone(),
                                    fields: serde_json::to_value(&out.fields)
                                        .unwrap_or(serde_json::Value::Null),
                                    return_value: out.return_value.clone(),
                                    error: None,
                                    workflow_run_id: wf_run_id_for_wait.clone(),
                                },
                            );
                        }
                        Some(out)
                    }
                    Err(e) => {
                        if !silent {
                            emit_event(
                                &app_for_wait,
                                &ExecutionEvent::Result {
                                    execution_id: id_for_wait.clone(),
                                    command_id: cmd_id_for_wait.clone(),
                                    fields: serde_json::json!({}),
                                    return_value: serde_json::Value::Null,
                                    error: Some(e.to_string()),
                                    workflow_run_id: wf_run_id_for_wait.clone(),
                                },
                            );
                        }
                        None
                    }
                }
            } else {
                None
            };

        // Timed once for both the terminal event and the NodeOutcome so a
        // backend caller (the scheduler) records the same duration the UI sees.
        let duration_ms = start.elapsed().as_millis() as u64;

        match wait_result {
            Ok(status) => {
                // On Unix a kill via signal yields a None exit code; treat
                // that as Cancelled rather than Finished with no code.
                #[cfg(unix)]
                let was_signal = {
                    use std::os::unix::process::ExitStatusExt;
                    status.code().is_none() && status.signal().is_some()
                };
                #[cfg(not(unix))]
                let was_signal = false;

                if cancelled_by_user || (!timed_out && was_signal) {
                    if !silent {
                        emit_event(
                            &app_for_wait,
                            &ExecutionEvent::Cancelled {
                                execution_id: id_for_wait.clone(),
                                command_id: cmd_id_for_wait.clone(),
                                workflow_run_id: wf_run_id_for_wait.clone(),
                            },
                        );
                    }
                    send_completion(
                        completion_tx,
                        NodeOutcome {
                            status: TerminalStatus::Cancelled,
                            exit_code: None,
                            extracted: None,
                            duration_ms,
                            output: captured_output,
                            stdout_tail: node_stdout_tail,
                        },
                    );
                    return;
                }
                let timed_out_flag = if timed_out { Some(true) } else { None };
                if !silent {
                    emit_event(
                        &app_for_wait,
                        &ExecutionEvent::Finished {
                            execution_id: id_for_wait.clone(),
                            exit_code: status.code(),
                            duration_ms,
                            command_id: cmd_id_for_wait.clone(),
                            workflow_run_id: wf_run_id_for_wait.clone(),
                            timed_out: timed_out_flag,
                        },
                    );
                }
                send_completion(
                    completion_tx,
                    NodeOutcome {
                        status: TerminalStatus::Finished,
                        exit_code: status.code(),
                        extracted,
                        duration_ms,
                        output: captured_output,
                        stdout_tail: node_stdout_tail,
                    },
                );
            }
            Err(err) => {
                if !silent {
                    emit_event(
                        &app_for_wait,
                        &ExecutionEvent::Error {
                            execution_id: id_for_wait.clone(),
                            message: format!("wait failed: {err}"),
                            command_id: cmd_id_for_wait.clone(),
                            workflow_run_id: wf_run_id_for_wait.clone(),
                        },
                    );
                }
                send_completion(
                    completion_tx,
                    NodeOutcome {
                        status: TerminalStatus::Error,
                        exit_code: None,
                        extracted: None,
                        duration_ms,
                        output: captured_output,
                        stdout_tail: node_stdout_tail,
                    },
                );
            }
        }
    });
}

/// Kill the process (and on Unix, its entire process group) for a
/// spawned `Child`. On Unix we send SIGTERM to the pgid first to give
/// the tree a moment to clean up, then SIGKILL after a short grace
/// period — this is what makes `sudo find / …` cancellation actually
/// stop the `find` and not just leave it reparented to PID 1 after
/// SIGKILL'ing sudo.
///
/// `elevated_password`: when `Some`, the child tree runs as root (the
/// run was elevated via `sudo`). A `killpg` from this non-root process
/// would fail with `EPERM` and leave the privileged descendants running
/// — so we re-elevate the signal via `sudo -S kill -<sig> -<pgid>`,
/// feeding the password on stdin. The negative pgid tells `kill(1)` to
/// target the whole process group. When `None`, the ordinary in-process
/// `killpg` is sufficient (the children share our uid).
///
/// When `pgid` is `None` (setsid failed at spawn) we fall back to
/// `start_kill`, which signals only the direct child.
///
/// On non-Unix platforms we just `start_kill` — Windows process groups
/// are managed differently and the elevated path's wrapper PowerShell
/// is documented as best-effort cancel (see build_elevated_windows_argv).
pub(super) async fn kill_child_tree(
    child: &mut Child,
    immediate: bool,
    #[cfg(unix)] pgid: Option<i32>,
    #[cfg(unix)] root_pid: Option<i32>,
    #[cfg(unix)] elevated_password: Option<&str>,
) {
    #[cfg(unix)]
    {
        if let Some(pw) = elevated_password {
            // Root-owned tree. A killpg against the OUTER sudo's group is
            // not enough: modern `sudo` runs the command in a NEW session /
            // process group (pty mode), so the root-owned descendants
            // (`sh`, `find`, `xargs`, …) live in a different group and would
            // survive — the classic "cancel didn't stop the elevated
            // command". So we sweep the WHOLE descendant tree by pid (walked
            // from `/proc` ppid links) and re-elevate a single `sudo kill`.
            // We also signal the captured group as a belt-and-braces.
            let mut targets: Vec<i32> = root_pid.map(collect_descendants).unwrap_or_default();
            if let Some(p) = root_pid {
                targets.push(p);
            }
            if immediate {
                if let Some(g) = pgid {
                    elevated_killpg(g, SIGKILL, pw).await;
                }
                elevated_kill_pids(&targets, SIGKILL, pw).await;
                return;
            }
            if let Some(g) = pgid {
                elevated_killpg(g, SIGTERM, pw).await;
            }
            elevated_kill_pids(&targets, SIGTERM, pw).await;
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            // Re-collect: the tree may have changed during the grace.
            let mut targets2: Vec<i32> = root_pid.map(collect_descendants).unwrap_or_default();
            if let Some(p) = root_pid {
                targets2.push(p);
            }
            if let Some(g) = pgid {
                elevated_killpg(g, SIGKILL, pw).await;
            }
            elevated_kill_pids(&targets2, SIGKILL, pw).await;
            return;
        }
        if let Some(g) = pgid {
            if immediate {
                // User cancel: hard-kill the whole group at once so a
                // command that ignores SIGTERM can't keep running.
                let _ = libc_killpg(g, SIGKILL);
                return;
            }
            // Timeout: SIGTERM the group, then SIGKILL after a brief grace.
            // killpg(-1) returns -1 with errno set — we don't surface
            // errors here because the followup wait() will reap the
            // actual outcome.
            let _ = libc_killpg(g, SIGTERM);
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            let _ = libc_killpg(g, SIGKILL);
            return;
        }
        // No pgid available — fall back to direct-child kill (SIGKILL on
        // Unix via start_kill, for both cancel and timeout).
        let _ = child.start_kill();
    }
    #[cfg(not(unix))]
    {
        let _ = immediate;
        // Kill the entire process tree so child processes spawned by the
        // shell (e.g. python.exe, npm.exe) don't survive the cancel/timeout.
        // /F forces termination, /T recurses into all descendants.
        if let Some(pid) = child.id() {
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .output();
        }
        // Safety net: if taskkill wasn't available or the PID already exited,
        // this ensures the direct child is signalled too.
        let _ = child.start_kill();
    }
}

/// Walk `/proc` and return every transitive descendant pid of `root`
/// (children, grandchildren, …), NOT including `root` itself. Reads only
/// the publicly-visible `ppid` field of each `/proc/<pid>/stat`, so it
/// needs no elevation even when the descendants are root-owned. Used by the
/// elevated kill path to find processes that `sudo` placed in a different
/// session/process-group than the one we captured at spawn.
///
/// Best-effort: any unreadable entry is skipped. Returns an empty vec on a
/// platform without `/proc` (the caller then relies on the killpg fallback).
#[cfg(unix)]
fn collect_descendants(root: i32) -> Vec<i32> {
    use std::collections::HashMap;

    // Build pid -> ppid for every process, then BFS from `root`.
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Ok(pid) = name.parse::<i32>() else {
            continue;
        };
        if let Some(ppid) = read_ppid(pid) {
            children.entry(ppid).or_default().push(pid);
        }
    }

    let mut out = Vec::new();
    let mut stack = vec![root];
    while let Some(p) = stack.pop() {
        if let Some(kids) = children.get(&p) {
            for &k in kids {
                // Guard against a pid==ppid cycle (shouldn't happen, but a
                // malformed /proc read must not loop forever).
                if k != p && !out.contains(&k) {
                    out.push(k);
                    stack.push(k);
                }
            }
        }
    }
    out
}

/// Read the parent pid (4th field of `/proc/<pid>/stat`). The 2nd field is
/// `comm` wrapped in parentheses and may itself contain spaces or `)`, so
/// we split AFTER the last `)` to reach the stable `state ppid …` tail.
#[cfg(unix)]
fn read_ppid(pid: i32) -> Option<i32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let close = stat.rfind(')')?;
    // After ") ": fields are `state ppid pgrp …`.
    let rest = stat.get(close + 1..)?.trim_start();
    let mut it = rest.split_whitespace();
    let _state = it.next()?;
    it.next()?.parse::<i32>().ok()
}

/// Signal an entire process group as root via `sudo -S -p '' kill
/// -<sig> -<pgid>`. Used by [`kill_child_tree`] for elevated runs whose
/// children we cannot signal directly. Best-effort: any spawn/auth/exit
/// failure is swallowed because the waiter's follow-up `child.wait()`
/// reports the authoritative outcome, and a failed kill simply means the
/// process group outlives us (no worse than the pre-fix behaviour).
///
/// Security: `pgid` and `sig` are integers we computed ourselves (never
/// user text), and the command is spawned directly with a fixed arg
/// array — never through a shell — so nothing here is injectable. The
/// password is written to stdin and never appears in the argv.
#[cfg(unix)]
async fn elevated_killpg(pgid: i32, sig: i32, password: &str) {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    use tokio::process::Command;

    // `kill -<sig> -<pgid>`: a NEGATIVE pid argument signals the whole
    // process group. `-p ''` silences sudo's prompt; `-S` reads the
    // password from stdin; `--` ends sudo's options so the leading `-`
    // of the signal number can't be misparsed as a sudo flag.
    let mut command = Command::new("sudo");
    command
        .arg("-S")
        .arg("-p")
        .arg("")
        .arg("--")
        .arg("kill")
        .arg(format!("-{sig}"))
        .arg(format!("-{pgid}"))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(_) => return,
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(password.as_bytes()).await;
        let _ = stdin.write_all(b"\n").await;
        let _ = stdin.shutdown().await;
    }
    // Bound the wait so a hung `sudo` (e.g. waiting on a TTY) can't stall
    // the kill path; on timeout we just move on.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await;
}

/// Signal a set of pids as root via a single `sudo -S -p '' kill -<sig>
/// <pid…>`. Used by [`kill_child_tree`] for elevated runs to reach the
/// root-owned descendant tree that `sudo` may have moved into a different
/// session/process-group than the one we captured at spawn. Best-effort:
/// any spawn/auth failure is swallowed because the waiter's follow-up
/// `child.wait()` reports the authoritative outcome.
///
/// Security: every pid is an integer WE computed by walking `/proc` ppid
/// links (never user text), POSITIVE so `kill(1)` targets the process and
/// not a group, and the command is spawned directly with a fixed arg array
/// — never through a shell — so nothing here is injectable. The password is
/// written to stdin and never appears in the argv. A `None`/empty pid list
/// is a no-op.
#[cfg(unix)]
async fn elevated_kill_pids(pids: &[i32], sig: i32, password: &str) {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    use tokio::process::Command;

    if pids.is_empty() {
        return;
    }

    let mut command = Command::new("sudo");
    command
        .arg("-S")
        .arg("-p")
        .arg("")
        .arg("--")
        .arg("kill")
        .arg(format!("-{sig}"));
    for &pid in pids {
        // Defensive: only signal real, positive pids. A negative value
        // here would target a process GROUP — never what this fn intends.
        if pid > 1 {
            command.arg(pid.to_string());
        }
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(_) => return,
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(password.as_bytes()).await;
        let _ = stdin.write_all(b"\n").await;
        let _ = stdin.shutdown().await;
    }
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await;
}

#[cfg(all(test, unix))]
mod kill_tree_tests {
    //! Regression tests for the cancel-kills-the-whole-tree behaviour.
    //!
    //! These tests cross the real OS boundary: they spawn `bash` with
    //! `pre_exec` calling `setsid()` (exactly as `spawn_execution` does),
    //! then verify that `kill_child_tree` with the captured pgid
    //! actually terminates the child. The prior implementation called
    //! `Child::start_kill()` which sends SIGKILL only to the direct
    //! child; for a `sudo`-wrapped invocation that left the descendants
    //! orphaned. We can't run real `sudo` in CI, but a `bash -c
    //! 'sleep 60'` reproduces the same kill semantics — the test fails
    //! if a future refactor reverts to single-process kill.
    use super::*;
    use crate::core::executor::command_build::{libc_getpgid, libc_setsid, SIGKILL, SIGTERM};
    use crate::core::executor::{
        cancel_execution, spawn_execution_with_completion, ExecuteRequest, ExecutionTarget,
        ExecutorState,
    };
    use std::collections::BTreeMap;
    use std::os::unix::process::ExitStatusExt;
    use std::process::Stdio;
    use std::time::Duration;
    use tokio::process::Command as TokioCommand;
    use tokio::time::timeout;

    fn spawn_setsid_sleep() -> Child {
        let mut cmd = TokioCommand::new("bash");
        cmd.arg("-c").arg("sleep 60");
        cmd.stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null());
        // Mirror the production setsid()-in-pre_exec setup so the spawned
        // child becomes a session leader and pgid == pid.
        unsafe {
            cmd.pre_exec(|| {
                let _ = libc_setsid();
                Ok(())
            });
        }
        cmd.spawn().expect("bash must be installed")
    }

    /// With a valid pgid, `kill_child_tree` must terminate the child
    /// within the SIGTERM-then-SIGKILL window (the implementation
    /// sleeps 250ms between signals; allow generous slack).
    #[tokio::test]
    async fn kill_child_tree_terminates_setsid_child_via_pgid() {
        let mut child = spawn_setsid_sleep();
        let pid = child.id().expect("child must have a pid") as i32;
        // setsid() ran in the child; getpgid(pid) must equal pid.
        let g = libc_getpgid(pid);
        assert_eq!(g, pid, "setsid must have promoted child to session leader");

        // Graceful (timeout) path: SIGTERM → grace → SIGKILL.
        kill_child_tree(&mut child, false, Some(g), None, None).await;

        let status = timeout(Duration::from_secs(3), child.wait())
            .await
            .expect("child must exit within the timeout")
            .expect("wait should not error");
        // SIGTERM => signal 15 OR SIGKILL => signal 9; either is fine.
        let sig = status.signal();
        assert!(
            matches!(sig, Some(SIGTERM) | Some(SIGKILL)),
            "child must exit via SIGTERM/SIGKILL, got {:?} (code={:?})",
            sig,
            status.code()
        );
    }

    /// `collect_descendants` must find the whole transitive child tree of a
    /// process by walking `/proc` ppid links — this is what lets the
    /// elevated kill path reach root-owned `find`/`xargs` that `sudo` put in
    /// a different session/pgrp than the one captured at spawn. We build a
    /// real 3-deep tree (bash → bash → sleep) and assert every descendant is
    /// returned (and the root itself is NOT).
    #[tokio::test]
    async fn collect_descendants_finds_transitive_children_via_proc() {
        // A shell that spawns a child shell that spawns a grandchild sleep,
        // all kept alive by `wait`. Own session so it's isolated.
        let mut cmd = TokioCommand::new("bash");
        cmd.arg("-c").arg("bash -c 'sleep 40 & wait' & wait");
        cmd.stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null());
        unsafe {
            cmd.pre_exec(|| {
                let _ = libc_setsid();
                Ok(())
            });
        }
        let mut child = cmd.spawn().expect("bash must be installed");
        let root = child.id().expect("child must have a pid") as i32;

        // Give the tree a moment to fully spawn.
        tokio::time::sleep(Duration::from_millis(400)).await;

        let descendants = collect_descendants(root);
        assert!(
            !descendants.contains(&root),
            "root itself must not be in the descendant set"
        );
        assert!(
            descendants.len() >= 2,
            "expected at least the child shell + grandchild sleep, got {descendants:?}"
        );
        // read_ppid of each descendant must chain back toward root.
        for &d in &descendants {
            assert!(read_ppid(d).is_some(), "ppid must be readable for {d}");
        }

        // Cleanup: kill the whole group.
        let g = libc_getpgid(root);
        kill_child_tree(&mut child, true, Some(g), None, None).await;
        let _ = timeout(Duration::from_secs(3), child.wait()).await;
    }

    /// The `immediate` (user-cancel) path must SIGKILL the group at once,
    /// with no SIGTERM grace — so a command that traps/ignores SIGTERM is
    /// still stopped right away. This is the regression guard for "I
    /// clicked Cancel but the command kept running".
    #[tokio::test]
    async fn kill_child_tree_immediate_sigkills_group_without_grace() {
        // bash that IGNORES SIGTERM (`trap '' TERM`) and then sleeps. The
        // graceful path would have to wait the full 250ms grace and rely
        // on SIGKILL; the immediate path SIGKILLs the group right away.
        let mut cmd = TokioCommand::new("bash");
        cmd.arg("-c").arg("trap '' TERM; sleep 60");
        cmd.stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null());
        unsafe {
            cmd.pre_exec(|| {
                let _ = libc_setsid();
                Ok(())
            });
        }
        let mut child = cmd.spawn().expect("bash must be installed");
        let pid = child.id().expect("child must have a pid") as i32;
        let g = libc_getpgid(pid);
        assert_eq!(g, pid, "setsid must have promoted child to session leader");

        kill_child_tree(&mut child, true, Some(g), None, None).await;

        let status = timeout(Duration::from_secs(3), child.wait())
            .await
            .expect("child must exit within the timeout")
            .expect("wait should not error");
        // Immediate cancel uses SIGKILL, which cannot be trapped.
        assert_eq!(
            status.signal(),
            Some(SIGKILL),
            "immediate cancel must SIGKILL the group, got {:?} (code={:?})",
            status.signal(),
            status.code()
        );
    }

    /// Without a pgid (`None`), `kill_child_tree` falls back to
    /// `Child::start_kill`, which still kills the direct child. This
    /// locks the fallback in so the no-pgid branch isn't silently
    /// broken by a future change.
    #[tokio::test]
    async fn kill_child_tree_falls_back_to_start_kill_when_no_pgid() {
        let mut child = spawn_setsid_sleep();

        kill_child_tree(&mut child, false, None, None, None).await;

        let status = timeout(Duration::from_secs(3), child.wait())
            .await
            .expect("child must exit within the timeout")
            .expect("wait should not error");
        // start_kill sends SIGKILL on Unix.
        assert_eq!(
            status.signal(),
            Some(SIGKILL),
            "fallback path must SIGKILL the direct child"
        );
    }

    /// End-to-end via `spawn_execution` + `cancel_execution`: spawn a
    /// long-running shell command, signal cancellation, and confirm
    /// the entry is removed from `state.running` (waiter reaped). This
    /// is the regression for the original bug — pre-fix this test
    /// would hang on the wait because the waiter had already
    /// `remove`d the child and the cancel call became a silent no-op.
    #[tokio::test]
    async fn cancel_execution_removes_running_entry_for_real_spawn() {
        let state = Arc::new(ExecutorState::new());
        // We can't build a real AppHandle in a unit test; bypass
        // `spawn_execution` and exercise the cancel path directly with
        // a synthetic RunningEntry whose receiver drives a real Child.
        let mut child = spawn_setsid_sleep();
        let pid = child.id().expect("child must have a pid") as i32;
        let g = libc_getpgid(pid);
        let pgid = if g == pid { Some(g) } else { None };

        let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
        let id = "test-exec".to_string();
        state.running.lock().await.insert(
            id.clone(),
            RunningEntry {
                cancel_tx: Some(cancel_tx),
                #[cfg(unix)]
                pgid,
            },
        );

        // Spawn a mini-waiter that mirrors the production select.
        let running_arc = state.running.clone();
        let id_clone = id.clone();
        let waiter = tokio::spawn(async move {
            tokio::select! {
                biased;
                _ = &mut cancel_rx => {
                    kill_child_tree(&mut child, true, pgid, None, None).await;
                    let _ = child.wait().await;
                }
                _ = child.wait() => {}
            }
            running_arc.lock().await.remove(&id_clone);
        });

        // Drive the public cancel API.
        cancel_execution(state.clone(), id.clone())
            .await
            .expect("cancel must not error");

        timeout(Duration::from_secs(3), waiter)
            .await
            .expect("waiter must finish within timeout")
            .expect("waiter task must not panic");

        let map = state.running.lock().await;
        assert!(
            !map.contains_key(&id),
            "running entry must be removed once the waiter exits"
        );
    }

    /// End-to-end CANCEL test through the REAL production path
    /// (`spawn_execution_with_completion` + the public `cancel_execution`).
    /// Spawns `sleep 30`, cancels it, and asserts the run terminates
    /// PROMPTLY with a `Cancelled` outcome — i.e. the cancel actually
    /// killed the process group rather than waiting for natural completion.
    /// This is the regression guard for "I clicked Cancel but the command
    /// kept running and only flipped to Cancelled when it finished".
    #[tokio::test]
    async fn cancel_kills_long_running_command_via_real_spawn() {
        let app = tauri::test::mock_app();
        let state = Arc::new(ExecutorState::new());
        let (tx, rx) = oneshot::channel::<NodeOutcome>();

        let req = ExecuteRequest {
            script: "sleep 30".to_string(),
            shell: Some("bash".to_string()),
            args: None,
            working_dir: None,
            env: None,
            command_id: None,
            execution_id: Some("cancel-e2e".to_string()),
            elevated: false,
            admin_password: None,
            variables: Vec::new(),
            variable_values: BTreeMap::new(),
            workflow_run_id: None,
            timeout_seconds: None,
            output_schema: None,
            capture_output: false,
            silent: false,
            target: ExecutionTarget::Local,
            ssh_password: None,
        };

        let started = std::time::Instant::now();
        spawn_execution_with_completion(app.handle().clone(), state.clone(), req, Some(tx))
            .await
            .expect("spawn must succeed");

        // Give the child a moment to actually start, then cancel through
        // the SAME public API the UI calls.
        tokio::time::sleep(Duration::from_millis(200)).await;
        cancel_execution(state.clone(), "cancel-e2e".to_string())
            .await
            .expect("cancel must not error");

        let outcome = tokio::time::timeout(Duration::from_secs(8), rx)
            .await
            .expect("run must reach a terminal state well before the 30s sleep")
            .expect("completion sender must not be dropped");

        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_secs(8),
            "cancel must stop the command promptly, took {elapsed:?}"
        );
        assert_eq!(
            outcome.status,
            TerminalStatus::Cancelled,
            "a user cancel should report Cancelled, got {outcome:?}"
        );
        assert!(
            !state.running.lock().await.contains_key("cancel-e2e"),
            "running entry must be removed after a cancel kill"
        );
    }

    /// End-to-end timeout test through the REAL production path
    /// (`spawn_execution_with_completion`). Spawns `sleep 30` with a
    /// 1-second timeout and asserts the run terminates PROMPTLY (well
    /// under the sleep duration) and reports a `Finished` outcome — i.e.
    /// the timeout actually killed the process group rather than letting
    /// the command run to completion. This is the regression guard for
    /// "I set a timeout but the command ran to the end anyway".
    #[tokio::test]
    async fn timeout_kills_long_running_command_via_real_spawn() {
        let app = tauri::test::mock_app();
        let state = Arc::new(ExecutorState::new());
        let (tx, rx) = oneshot::channel::<NodeOutcome>();

        let req = ExecuteRequest {
            script: "sleep 30".to_string(),
            shell: Some("bash".to_string()),
            args: None,
            working_dir: None,
            env: None,
            command_id: None,
            execution_id: Some("timeout-e2e".to_string()),
            elevated: false,
            admin_password: None,
            variables: Vec::new(),
            variable_values: BTreeMap::new(),
            workflow_run_id: None,
            timeout_seconds: Some(1),
            output_schema: None,
            capture_output: false,
            silent: false,
            target: ExecutionTarget::Local,
            ssh_password: None,
        };

        let started = std::time::Instant::now();
        spawn_execution_with_completion(app.handle().clone(), state.clone(), req, Some(tx))
            .await
            .expect("spawn must succeed");

        // The command sleeps 30s; with a 1s timeout it must finish far
        // sooner. Allow generous slack for the SIGTERM→SIGKILL grace
        // (250ms) plus scheduling, but FAR below 30s.
        let outcome = tokio::time::timeout(Duration::from_secs(8), rx)
            .await
            .expect("run must reach a terminal state well before the 30s sleep")
            .expect("completion sender must not be dropped");

        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_secs(8),
            "timeout must stop the command promptly, took {elapsed:?}"
        );
        // The timeout path kills the process group and reaps it; the
        // terminal status is Finished (a timeout is not a user cancel).
        assert_eq!(
            outcome.status,
            TerminalStatus::Finished,
            "timed-out run should report Finished (with no exit code), got {outcome:?}"
        );
        // Signal-killed → no exit code.
        assert_eq!(outcome.exit_code, None);

        // The registry entry must have been reaped by the waiter.
        assert!(
            !state.running.lock().await.contains_key("timeout-e2e"),
            "running entry must be removed after a timeout kill"
        );
    }
}
