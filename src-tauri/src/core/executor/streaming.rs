// Output streaming tasks for the execution engine.
//
// Spawns the stdout/stderr reader tasks that read the child's piped
// output line-by-line, redact every `sensitive` variable value before it
// leaves the process (M1 security invariant), emit a `Stdout`/`Stderr`
// event per line, and — for stdout only, and only when the command
// declared an output schema — buffer the (already redacted) output up to
// `MAX_EXTRACTION_BUFFER_BYTES` for post-run extraction.
//
// The `JoinHandle`s are returned so the waiter can drain them to EOF
// before emitting any terminal event, guaranteeing output never appears
// after the terminal status in the UI.

use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Runtime};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{ChildStderr, ChildStdout};
use tokio::task::JoinHandle;

use super::emit_event;
use super::types::{CaptureBuffer, CapturedStream, ExecutionEvent, MAX_EXTRACTION_BUFFER_BYTES};

/// Spawn the stdout reader task.
///
/// We KEEP the returned `JoinHandle` so the waiter task can await it
/// before emitting the terminal event — see the drain step in the waiter.
/// Without that join, a `Finished` (or timeout `Finished`) event could
/// race ahead of the last buffered stdout lines, so the UI would show
/// the terminal status FIRST and then have output appear underneath it
/// a moment later. That out-of-order trailing output is exactly the
/// "command keeps running after the timeout error" symptom users see.
///
/// Buffer stdout for post-run extraction ONLY when `capture` is true (the
/// command has a schema) — every other run does zero extra work and the
/// task returns `None`. The buffer is capped at `MAX_EXTRACTION_BUFFER_BYTES`;
/// once full, further lines still stream as events but are not retained.
/// `capture` enables the (separate) stdout-only extraction buffer returned
/// via the JoinHandle. `capture_buffer`, when `Some`, is the SHARED bounded
/// interleaved buffer that both readers push into for the scheduler's history
/// capture (see [`CaptureBuffer`]). `silent` suppresses the live `Stdout`
/// event emit (planned cron fires) while STILL reading the stream so the pipe
/// drains, the extraction buffer fills, and the capture buffer records.
#[allow(clippy::too_many_arguments)]
pub(super) fn spawn_stdout_reader<R: Runtime>(
    stdout: Option<ChildStdout>,
    app: AppHandle<R>,
    execution_id: String,
    workflow_run_id: Option<String>,
    sensitive_values: Arc<Vec<String>>,
    capture: bool,
    capture_buffer: Option<Arc<Mutex<CaptureBuffer>>>,
    silent: bool,
) -> Option<JoinHandle<Option<String>>> {
    stdout.map(|out| {
        let app_cloned = app;
        let id_cloned = execution_id;
        let wf_run_id = workflow_run_id;
        let secrets = sensitive_values;
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            let mut buffer: Option<String> = if capture { Some(String::new()) } else { None };
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        // M1: redact sensitive values before they leave the
                        // process. The extraction buffer keeps the REDACTED
                        // form too — a schema must never be the back door that
                        // re-exposes a secret in a `Result` event/history.
                        let line = crate::core::redact::redact_secrets(&line, &secrets);
                        if let Some(buf) = buffer.as_mut() {
                            // Reconstruct the line + newline the reader
                            // stripped, staying under the byte cap so a
                            // runaway stream can't exhaust memory.
                            if buf.len() + line.len() < MAX_EXTRACTION_BUFFER_BYTES {
                                buf.push_str(&line);
                                buf.push('\n');
                            }
                        }
                        // Push the redacted line into the shared history
                        // capture buffer (bounded). The lock is held only for
                        // the push — never across an await.
                        if let Some(cap) = capture_buffer.as_ref() {
                            if let Ok(mut guard) = cap.lock() {
                                guard.push(CapturedStream::Stdout, line.clone());
                            }
                        }
                        // Suppress the live console emit for silent (planned)
                        // fires; the stream is still drained and captured.
                        if !silent {
                            emit_event(
                                &app_cloned,
                                &ExecutionEvent::Stdout {
                                    execution_id: id_cloned.clone(),
                                    line,
                                    workflow_run_id: wf_run_id.clone(),
                                },
                            );
                        }
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
            buffer
        })
    })
}

/// Spawn the stderr reader task. Same join rationale as the stdout reader.
/// stderr is never buffered for extraction; it only streams `Stderr`
/// events, each redacted of sensitive values before emission.
/// `capture_buffer`, when `Some`, is the SHARED bounded interleaved buffer the
/// stdout reader also pushes into (history capture). `silent` suppresses the
/// live `Stderr` emit (planned cron fires) while still draining and capturing.
pub(super) fn spawn_stderr_reader<R: Runtime>(
    stderr: Option<ChildStderr>,
    app: AppHandle<R>,
    execution_id: String,
    workflow_run_id: Option<String>,
    sensitive_values: Arc<Vec<String>>,
    capture_buffer: Option<Arc<Mutex<CaptureBuffer>>>,
    silent: bool,
) -> Option<JoinHandle<()>> {
    stderr.map(|err_stream| {
        let app_cloned = app;
        let id_cloned = execution_id;
        let wf_run_id = workflow_run_id;
        let secrets = sensitive_values;
        tokio::spawn(async move {
            let mut lines = BufReader::new(err_stream).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        // M1: redact sensitive values before emitting.
                        let line = crate::core::redact::redact_secrets(&line, &secrets);
                        if let Some(cap) = capture_buffer.as_ref() {
                            if let Ok(mut guard) = cap.lock() {
                                guard.push(CapturedStream::Stderr, line.clone());
                            }
                        }
                        if !silent {
                            emit_event(
                                &app_cloned,
                                &ExecutionEvent::Stderr {
                                    execution_id: id_cloned.clone(),
                                    line,
                                    workflow_run_id: wf_run_id.clone(),
                                },
                            );
                        }
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
        })
    })
}
