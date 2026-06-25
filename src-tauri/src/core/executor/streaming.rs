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
//
// # Encoding
//
// Child output is NOT guaranteed to be UTF-8. Windows `powershell` / `cmd`
// emit their native/formatted output in the console OEM code page (e.g.
// cp866 on a Russian Windows) when stdout is a redirected pipe, and assorted
// CLIs emit Latin-1 or other legacy encodings. We therefore read RAW BYTES up
// to each `\n` and decode with `String::from_utf8_lossy` (undecodable bytes
// become U+FFFD `\u{fffd}`) — matching every other child-output reader in the
// codebase. A strict UTF-8 line reader (`AsyncBufReadExt::lines`) would error
// on the first non-UTF-8 byte and abort the WHOLE stream, surfacing as
// *empty* stdout for a perfectly successful command.

use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Runtime};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, BufReader};
use tokio::process::{ChildStderr, ChildStdout};
use tokio::task::JoinHandle;

use super::emit_event;
use super::types::{CaptureBuffer, CapturedStream, ExecutionEvent, MAX_EXTRACTION_BUFFER_BYTES};

/// Read one line from `reader` as bytes (up to and including the next `\n`)
/// and lossily decode it to a `String`, stripping the trailing line
/// terminator. Mirrors the splitting semantics of
/// [`tokio::io::AsyncBufReadExt::lines`] EXACTLY so existing Linux (`\n`) and
/// Windows (`\r\n`) behaviour is byte-for-byte unchanged:
///
///   - splits on `\n`; a trailing `\r` (the `\r` of a `\r\n` pair) is stripped;
///   - the final chunk before EOF is returned even without a trailing newline;
///   - returns `Ok(None)` at EOF when no bytes remain (clean stream end).
///
/// The ONLY behavioural difference from `lines()` is decoding: non-UTF-8 bytes
/// become `U+FFFD` instead of aborting the stream with an `InvalidData` error.
/// An `Err` here is a genuine I/O failure (broken pipe), not an encoding issue.
async fn next_line_lossy<R: AsyncBufRead + Unpin>(
    reader: &mut R,
) -> std::io::Result<Option<String>> {
    let mut buf: Vec<u8> = Vec::new();
    let n = reader.read_until(b'\n', &mut buf).await?;
    if n == 0 {
        // EOF with nothing buffered -> the stream is done.
        return Ok(None);
    }
    // Strip the line terminator the same way `lines()` does: drop a trailing
    // `\n`, then a trailing `\r` if present (the CR of a CRLF pair). A lone
    // final line without a newline (EOF) keeps all its bytes.
    if buf.last() == Some(&b'\n') {
        buf.pop();
        if buf.last() == Some(&b'\r') {
            buf.pop();
        }
    }
    Ok(Some(String::from_utf8_lossy(&buf).into_owned()))
}

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
            let mut reader = BufReader::new(out);
            let mut buffer: Option<String> = if capture { Some(String::new()) } else { None };
            loop {
                match next_line_lossy(&mut reader).await {
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
            let mut reader = BufReader::new(err_stream);
            loop {
                match next_line_lossy(&mut reader).await {
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

#[cfg(test)]
mod tests {
    use super::next_line_lossy;
    use tokio::io::BufReader;

    /// Drive `next_line_lossy` over an in-memory byte slice. A `&[u8]`
    /// implements `tokio::io::AsyncRead`, so wrapping it in `BufReader` gives
    /// the `AsyncBufRead` the helper needs — the same shape as a real pipe.
    async fn collect(bytes: &[u8]) -> Vec<Option<String>> {
        let mut reader = BufReader::new(bytes);
        let mut out = Vec::new();
        loop {
            match next_line_lossy(&mut reader).await.expect("no I/O error") {
                Some(line) => out.push(Some(line)),
                None => {
                    out.push(None);
                    break;
                }
            }
        }
        out
    }

    #[tokio::test]
    async fn lf_line_is_decoded_and_terminator_stripped() {
        let got = collect(b"hello\n").await;
        assert_eq!(got, vec![Some("hello".to_string()), None]);
    }

    /// Windows parity: a `\r\n` pair must be stripped of BOTH bytes, exactly
    /// like tokio's `lines()` did — so CRLF output is unchanged from before.
    #[tokio::test]
    async fn crlf_line_strips_both_cr_and_lf() {
        let got = collect(b"hello\r\n").await;
        assert_eq!(got, vec![Some("hello".to_string()), None]);
    }

    /// Core regression guard: a non-UTF-8 byte (here a lone `0xFF`, invalid in
    /// UTF-8 — stands in for OEM cp866 output from Windows PowerShell) must be
    /// decoded LOSSILY to U+FFFD and the line still surfaced, NOT silently
    /// dropped by aborting the stream. The old `lines()` reader returned an
    /// `Err` on this byte and `break`-ed, yielding empty stdout.
    #[tokio::test]
    async fn non_utf8_byte_is_replaced_not_dropped() {
        let got = collect(&[0xFF, b'i', b'\n']).await;
        assert_eq!(got.len(), 2);
        let line = got[0].as_ref().expect("first line present");
        assert!(
            line.contains('\u{fffd}'),
            "invalid byte should become the replacement char, got {line:?}"
        );
        assert!(line.ends_with('i'), "trailing valid byte preserved: {line:?}");
        assert_eq!(got[1], None);
    }

    /// Output downstream of the bad byte must keep flowing — a poisoned byte
    /// must not poison the rest of the run (the real-world `Get-ChildItem`
    /// case: ASCII header, then Cyrillic rows, then more ASCII).
    #[tokio::test]
    async fn stream_continues_after_a_bad_byte() {
        let mut input = Vec::new();
        input.extend_from_slice(b"Mode\n"); // ASCII header
        input.extend_from_slice(&[0x8A, 0x20, b'\n']); // invalid-UTF-8 (cp866-ish)
        input.extend_from_slice(b"yarn.lock\n"); // ASCII tail
        let got = collect(&input).await;
        assert_eq!(got.len(), 4);
        assert_eq!(got[0], Some("Mode".to_string()));
        assert!(got[1].as_ref().unwrap().contains('\u{fffd}'));
        assert_eq!(got[2], Some("yarn.lock".to_string()));
        assert_eq!(got[3], None);
    }

    /// A final chunk with no trailing newline before EOF is still returned —
    /// same as `lines()`.
    #[tokio::test]
    async fn final_line_without_newline_is_returned() {
        let got = collect(b"last line, no newline").await;
        assert_eq!(
            got,
            vec![Some("last line, no newline".to_string()), None]
        );
    }

    /// An empty stream yields exactly one `None` (clean EOF, no spurious line).
    #[tokio::test]
    async fn empty_stream_is_clean_eof() {
        let got = collect(b"").await;
        assert_eq!(got, vec![None]);
    }
}
