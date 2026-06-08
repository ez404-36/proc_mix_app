// Process Capture watcher — the background "command recorder".
//
// Observes process births on Windows (via ETW) and emits a `CaptureEvent`
// for each one onto the `capture-event` channel, so the frontend can offer
// to turn captured command lines into ProcMix commands. See
// `docs/process-capture.md` for the full cross-boundary contract.
//
// This module is a WATCHER, not an executor: it never runs anything. It
// only observes and forwards. Captured data is ephemeral on the frontend
// (`captureStore`) and is never persisted here.
//
// Platform split:
//   - Windows: ETW subscription to `Microsoft-Windows-Kernel-Process`
//     (see the `imp` module below, gated `#[cfg(windows)]`).
//   - Everything else: `start` returns the `CAPTURE_UNSUPPORTED` sentinel
//     so the frontend can hide the feature, mirroring the
//     `ERR_ADMIN_PASSWORD_REQUIRED` sentinel pattern in `executor.rs`.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::Mutex;

/// Tauri event channel carrying captured process starts to the frontend.
/// Mirrors `EXECUTION_EVENT` from `executor.rs`. The TS side subscribes via
/// `subscribeCaptureEvents` (`src/utils/processCapture.ts`).
///
/// `allow(dead_code)` off Windows: consumed only by the Windows ETW `imp`
/// module (and the frontend over IPC), but is part of the cross-boundary
/// contract and is exercised by the unit test below on every platform.
#[cfg_attr(not(windows), allow(dead_code))]
pub const CAPTURE_EVENT: &str = "capture-event";

/// Sentinel returned by [`start`] on platforms where Process Capture is not
/// implemented (everything except Windows for now). The frontend matches
/// this exact string to keep the Recorder UI hidden. Keep it a single ASCII
/// identifier so a future message-wrapping pass cannot mutate it — the same
/// discipline as `ERR_ADMIN_PASSWORD_REQUIRED`.
pub const CAPTURE_UNSUPPORTED: &str = "CAPTURE_UNSUPPORTED";

/// One captured process birth, forwarded to the frontend.
///
/// Serialised in camelCase to match the TS `CaptureEvent` interface
/// (`src/types/capture.ts`). The only field whose name changes across the
/// boundary is `command_line` -> `commandLine`.
///
/// The `command_line` here is the RAW value from the OS. Secret redaction
/// happens on the frontend (`redactSecrets`) before display — this struct
/// never reaches a log; see the privacy section of the design doc.
///
/// `allow(dead_code)` off Windows: only the Windows ETW `imp` module
/// constructs this, but the type + its camelCase wire format are pinned by
/// a unit test on every platform.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureEvent {
    /// PID of the newly-started process.
    pub pid: u32,
    /// PID of the parent (the process that spawned it).
    pub ppid: u32,
    /// Full path to the executable image.
    pub image: String,
    /// The process's command line, exactly as reported by the OS.
    pub command_line: String,
    /// Event time as an ISO-8601 (UTC) string.
    pub timestamp: String,
}

/// Shared capture state held in Tauri app state (`app.manage`), parallel to
/// `ExecutorState` / `WorkflowExecutorState`.
///
/// Holds the handle needed to stop an in-flight ETW session. `None` means
/// no capture is running. The `Mutex` serialises start/stop so two rapid
/// toggles cannot leave two sessions running or leak a handle.
pub struct WatcherState {
    inner: Mutex<Option<WatcherHandle>>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    /// `true` iff a capture session is currently running.
    pub async fn is_running(&self) -> bool {
        self.inner.lock().await.is_some()
    }
}

impl Default for WatcherState {
    fn default() -> Self {
        Self::new()
    }
}

/// Opaque, platform-specific handle to a running capture session. The
/// concrete shape differs per OS; on non-Windows it is never constructed.
struct WatcherHandle {
    stop: imp::StopHandle,
}

/// Begin observing process starts and emitting `CaptureEvent`s on
/// [`CAPTURE_EVENT`]. Idempotent: starting while already running is a no-op
/// success, so the UI can call it without tracking state precisely.
///
/// Returns `Err(CAPTURE_UNSUPPORTED)` on platforms without an
/// implementation.
pub async fn start<R: Runtime>(app: AppHandle<R>, state: Arc<WatcherState>) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    if guard.is_some() {
        return Ok(());
    }
    let stop = imp::start(app)?;
    *guard = Some(WatcherHandle { stop });
    Ok(())
}

/// Stop an in-flight capture session. Idempotent: stopping when nothing is
/// running is a no-op success.
pub async fn stop(state: Arc<WatcherState>) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    if let Some(handle) = guard.take() {
        imp::stop(handle.stop);
    }
    Ok(())
}

/// Emit a single captured event to the frontend. Best-effort: an emit
/// failure is logged via stderr and otherwise ignored (matches
/// `executor::emit_event`). The raw command line is NEVER logged here.
///
/// `allow(dead_code)` off Windows: only the Windows ETW callback calls this.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn emit_capture<R: Runtime>(app: &AppHandle<R>, event: &CaptureEvent) {
    if let Err(err) = app.emit(CAPTURE_EVENT, event) {
        eprintln!("failed to emit capture event: {err}");
    }
}

// ----------------------------------------------------------------------
// Non-Windows implementation: every operation reports unsupported. Kept in
// a private `imp` module so the public API above is platform-agnostic and
// the cfg-split lives in exactly one place (mirrors how `admin_password`
// keeps Unix specifics contained).
// ----------------------------------------------------------------------
#[cfg(not(windows))]
mod imp {
    use super::CAPTURE_UNSUPPORTED;
    use tauri::{AppHandle, Runtime};

    /// Stand-in stop handle. Never constructed on non-Windows because
    /// [`start`] always errors before producing one.
    pub(super) enum StopHandle {}

    pub(super) fn start<R: Runtime>(_app: AppHandle<R>) -> Result<StopHandle, String> {
        Err(CAPTURE_UNSUPPORTED.to_string())
    }

    pub(super) fn stop(handle: StopHandle) {
        // Uninhabited: there is no value to handle. The match proves to the
        // compiler this branch is unreachable without an `unwrap`/panic.
        match handle {}
    }
}

// ----------------------------------------------------------------------
// Windows implementation: ETW subscription to the Kernel-Process provider.
//
// The ETW trace loop is BLOCKING and must not run on the async runtime —
// it is driven on a dedicated `std::thread`, the same discipline used for
// `rfd` dialogs (`spawn_blocking` in `export_data`). Stopping flips an
// atomic flag and stops the session, which returns the blocked
// `process()` call so the thread can exit.
// ----------------------------------------------------------------------
#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;

    use ferrisetw::parser::Parser;
    use ferrisetw::provider::Provider;
    use ferrisetw::schema_locator::SchemaLocator;
    // `TraceTrait` must be in scope to call `UserTrace::process_from_handle`,
    // which is a provided method on the trait (implemented for `UserTrace`).
    use ferrisetw::trace::{stop_trace_by_name, TraceTrait, UserTrace};
    use ferrisetw::EventRecord;
    use tauri::{AppHandle, Runtime};

    use super::{emit_capture, CaptureEvent};
    use crate::core::capture_filter::CaptureFilter;

    /// ETW provider GUID for `Microsoft-Windows-Kernel-Process`.
    const KERNEL_PROCESS_PROVIDER: &str = "22fb2cd6-0e7b-422b-a0c7-2fad1fd0e716";

    /// Opcode 1 of the Kernel-Process provider is `ProcessStart`. Other
    /// opcodes (process stop, thread/image events) are ignored — we only
    /// care about births.
    const OPCODE_PROCESS_START: u8 = 1;

    /// Unique trace session name so start/stop can target it and a stale
    /// session from a crashed prior run can be torn down by name.
    const SESSION_NAME: &str = "ProcMixProcessCapture";

    /// Owns the running ETW session and its driver thread.
    ///
    /// The `trace` field keeps the `UserTrace` alive for the whole session:
    /// `start()` returns it alongside the handle, and dropping it stops the
    /// session (per ferrisetw, "to stop the session, you can drop this
    /// instance"). If we dropped it at the end of [`start`], the session would
    /// die before the worker thread's `process_from_handle` ever ran. [`stop`]
    /// ends the named session (which unblocks the thread), joins the thread,
    /// and only then drops the trace.
    pub(super) struct StopHandle {
        running: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
        trace: UserTrace,
    }

    pub(super) fn start<R: Runtime>(app: AppHandle<R>) -> Result<StopHandle, String> {
        // Tear down any session left over from a previous crashed run so
        // `start` cannot fail with "already exists".
        let _ = stop_trace_by_name(SESSION_NAME);

        let running = Arc::new(AtomicBool::new(true));
        let running_for_cb = running.clone();

        // Noise filter, keyed on ProcMix's own exe so its self-spawned
        // shells are excluded. `current_exe` should always resolve; if it
        // somehow fails, fall back to the known binary name so self-exclusion
        // still works by basename.
        let self_exe = std::env::current_exe()
            .ok()
            .and_then(|p| p.to_str().map(str::to_owned))
            .unwrap_or_else(|| "procmix.exe".to_string());
        // The ETW callback is `Fn`, but the filter needs `&mut`; a `Mutex`
        // gives interior mutability. There is exactly one callback thread,
        // so the lock is never contended.
        let filter = Mutex::new(CaptureFilter::new(&self_exe));

        let provider = Provider::by_guid(KERNEL_PROCESS_PROVIDER)
            .add_callback(move |record: &EventRecord, locator: &SchemaLocator| {
                if !running_for_cb.load(Ordering::Relaxed) {
                    return;
                }
                if record.opcode() != OPCODE_PROCESS_START {
                    return;
                }
                if let Some(event) = parse_process_start(record, locator) {
                    // Drop self / system-noise / duplicate starts before
                    // they ever reach the frontend.
                    let keep = filter
                        .lock()
                        .map(|mut f| f.should_emit(&event.image, &event.command_line))
                        .unwrap_or(true);
                    if keep {
                        emit_capture(&app, &event);
                    }
                }
            })
            .build();

        // `start()` returns `(UserTrace, TraceHandle)`. We process via the
        // HANDLE on a worker thread (`process_from_handle`), which — unlike
        // `UserTrace::process()` — does NOT consume the trace. That lets us
        // keep the `UserTrace` in the `StopHandle` so the session stays open,
        // and stop it explicitly later. The `process_from_handle` call blocks
        // until the session ends, so it must run off the main thread.
        let (trace, handle) = UserTrace::new()
            .named(SESSION_NAME.to_string())
            .enable(provider)
            .start()
            // `TraceError` implements `Debug` but not `Display`, so format
            // with `{e:?}`.
            .map_err(|e| format!("failed to start ETW capture session: {e:?}"))?;

        let thread = std::thread::Builder::new()
            .name("procmix-capture".into())
            .spawn(move || {
                // Blocks until the named session is stopped (by `stop()`),
                // triggering the provider callback for each event. Driven by
                // the handle, so the owning `UserTrace` lives in `StopHandle`.
                let _ = UserTrace::process_from_handle(handle);
            })
            .map_err(|e| format!("failed to spawn capture thread: {e}"))?;

        Ok(StopHandle {
            running,
            thread: Some(thread),
            trace,
        })
    }

    pub(super) fn stop(mut handle: StopHandle) {
        handle.running.store(false, Ordering::Relaxed);
        // Ending the named session unblocks the thread's
        // `process_from_handle`, letting it return so the thread can exit.
        let _ = stop_trace_by_name(SESSION_NAME);
        if let Some(thread) = handle.thread.take() {
            let _ = thread.join();
        }
        // Now that the worker has stopped using the trace, drop it. (This is
        // also where `UserTrace`'s own session teardown runs.) Explicit for
        // clarity even though it would drop at end of scope anyway.
        drop(handle.trace);
    }

    /// Extract a [`CaptureEvent`] from a Kernel-Process `ProcessStart`
    /// record. Returns `None` if the schema/property lookup fails so a
    /// single malformed record can never crash the trace thread.
    fn parse_process_start(record: &EventRecord, locator: &SchemaLocator) -> Option<CaptureEvent> {
        let schema = locator.event_schema(record).ok()?;
        let parser = Parser::create(record, &schema);

        let pid: u32 = parser.try_parse("ProcessID").ok()?;
        let ppid: u32 = parser.try_parse("ParentProcessID").ok()?;
        let image: String = parser.try_parse("ImageName").ok()?;
        // The CommandLine property may be absent for some processes; fall
        // back to the image path so the row is still actionable.
        let command_line: String = parser
            .try_parse("CommandLine")
            .unwrap_or_else(|_| image.clone());

        Some(CaptureEvent {
            pid,
            ppid,
            image,
            command_line,
            timestamp: iso_now(),
        })
    }

    /// Current UTC time as a minimal ISO-8601 string. ProcMix has no time
    /// crate dependency, and the frontend only displays this value, so a
    /// small hand-rolled formatter keeps the dependency surface unchanged.
    fn iso_now() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        // Seconds since epoch as a sortable, unambiguous timestamp. The UI
        // formats it for display; precision finer than a second is not
        // needed for a capture row.
        format!("{secs}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The unsupported sentinel must stay an exact ASCII identifier — the
    /// frontend matches it verbatim to hide the feature.
    #[test]
    fn capture_unsupported_sentinel_is_exact() {
        assert_eq!(CAPTURE_UNSUPPORTED, "CAPTURE_UNSUPPORTED");
    }

    /// The event channel name is part of the cross-boundary contract with
    /// `subscribeCaptureEvents` on the TS side.
    #[test]
    fn capture_event_channel_is_exact() {
        assert_eq!(CAPTURE_EVENT, "capture-event");
    }

    /// `CaptureEvent` must serialise its one renamed field as camelCase so
    /// the TS interface lines up. Guards against an accidental
    /// `rename_all` removal in a refactor.
    #[test]
    fn capture_event_serialises_command_line_as_camel_case() {
        let event = CaptureEvent {
            pid: 1234,
            ppid: 1,
            image: "C:/Windows/System32/git.exe".to_string(),
            command_line: "git status".to_string(),
            timestamp: "0".to_string(),
        };
        let json = serde_json::to_value(&event).expect("serialise CaptureEvent");
        assert!(json.get("commandLine").is_some(), "expected camelCase key");
        assert!(
            json.get("command_line").is_none(),
            "snake_case must not leak"
        );
        assert_eq!(json.get("ppid").and_then(|v| v.as_u64()), Some(1));
    }

    /// On non-Windows, `start` must report unsupported rather than silently
    /// succeeding. (On Windows this test is skipped — there `start` opens a
    /// real ETW session, which needs a runtime + privileges and belongs to
    /// manual QA.)
    #[cfg(not(windows))]
    #[tokio::test]
    async fn start_is_unsupported_off_windows() {
        // Build a mock Tauri app so we have a real `AppHandle`.
        let app = tauri::test::mock_app();
        let state = Arc::new(WatcherState::new());
        let err = start(app.handle().clone(), state.clone())
            .await
            .expect_err("capture must be unsupported off Windows");
        assert_eq!(err, CAPTURE_UNSUPPORTED);
        assert!(!state.is_running().await, "no session should be recorded");
    }

    /// `stop` is idempotent: stopping when nothing runs is a clean no-op.
    #[tokio::test]
    async fn stop_when_idle_is_ok() {
        let state = Arc::new(WatcherState::new());
        stop(state.clone()).await.expect("idle stop is ok");
        assert!(!state.is_running().await);
    }
}
