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
//   - Windows: an ETW kernel-logger subscription to the Process provider
//     (NT Kernel Logger), which reports each launch WITH its command line.
//     See the `imp` module below, gated `#[cfg(windows)]`.
//   - Everything else: `start` returns the `CAPTURE_UNSUPPORTED` sentinel
//     so the frontend can hide the feature, mirroring the
//     `ERR_ADMIN_PASSWORD_REQUIRED` sentinel pattern in `executor.rs`.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::Mutex;

use crate::core::scope_tracker::CaptureScope;

/// Tauri event channel carrying captured process starts to the frontend.
/// Mirrors `EXECUTION_EVENT` from `executor.rs`. The TS side subscribes via
/// `subscribeCaptureEvents` (`src/utils/processCapture.ts`).
///
/// `allow(dead_code)` on platforms with no capture backend (macOS/other):
/// consumed by the Windows ETW and Linux cn_proc `imp` modules (and the
/// frontend over IPC), but is part of the cross-boundary contract and is
/// exercised by the unit test below on every platform.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
pub const CAPTURE_EVENT: &str = "capture-event";

/// Sentinel returned by [`start`] on platforms where Process Capture is not
/// implemented (everything except Windows for now). The frontend matches
/// this exact string to keep the Recorder UI hidden. Keep it a single ASCII
/// identifier so a future message-wrapping pass cannot mutate it — the same
/// discipline as `ERR_ADMIN_PASSWORD_REQUIRED`.
///
/// `allow(dead_code)` on platforms WITH a capture backend (Windows ETW,
/// Linux cn_proc): there `imp::start` never returns this sentinel, so only
/// the fallback `imp` on other OSes (and the cross-platform unit test)
/// reference it.
#[cfg_attr(any(windows, target_os = "linux"), allow(dead_code))]
pub const CAPTURE_UNSUPPORTED: &str = "CAPTURE_UNSUPPORTED";

/// Sentinel returned by [`start`] when the feature IS supported but the OS
/// denied the capture backend for lack of privilege — currently only Linux,
/// where binding the `cn_proc` netlink multicast group needs `CAP_NET_ADMIN`.
/// The frontend matches this exact string (`isCaptureRequiresPrivilegeError`)
/// to show a tailored "grant CAP_NET_ADMIN" hint instead of the generic
/// "unsupported" notice. A single ASCII identifier, same discipline as
/// [`CAPTURE_UNSUPPORTED`].
///
/// `allow(dead_code)` off Linux: only the Linux cn_proc `imp` can produce
/// this, but the constant is part of the cross-boundary contract and pinned
/// by a unit test on every platform.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const CAPTURE_REQUIRES_PRIVILEGE: &str = "CAPTURE_REQUIRES_PRIVILEGE";

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
/// `allow(dead_code)` on platforms with no capture backend (macOS/other):
/// only the Windows ETW and Linux cn_proc `imp` modules construct this, but
/// the type + its camelCase wire format are pinned by a unit test on every
/// platform.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
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
/// [`CAPTURE_EVENT`], constrained to `scope` (the chosen app's subtree, all
/// processes, or everything-except-a-subtree). Idempotent: starting while
/// already running is a no-op success, so the UI can call it without tracking
/// state precisely.
///
/// Returns `Err(CAPTURE_UNSUPPORTED)` on platforms without an
/// implementation.
pub async fn start<R: Runtime>(
    app: AppHandle<R>,
    state: Arc<WatcherState>,
    scope: CaptureScope,
) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    if guard.is_some() {
        return Ok(());
    }
    let stop = imp::start(app, scope)?;
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

/// A process the user can pick as the capture-scope root in the Recorder
/// ("record this app and its children"). Serialised camelCase to match the TS
/// `CaptureTarget` interface (`src/types/capture.ts`).
///
/// `allow(dead_code)` on platforms with no capture backend (macOS/other):
/// there `list_targets` returns an empty list, but the type + its wire format
/// are part of the cross-boundary contract.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTarget {
    /// PID to use as the `Subtree` root.
    pub pid: u32,
    /// Human-readable process name (`/proc/<pid>/comm` on Linux).
    pub name: String,
}

/// Enumerate processes the user can scope capture to. First version: ALL
/// processes (filtering to "has a visible window" is deferred — hard on
/// Wayland; see the scoping plan §4.1). Returns an empty list on platforms
/// without a capture backend.
pub fn list_targets() -> Vec<CaptureTarget> {
    imp::list_targets()
}

/// Emit a single captured event to the frontend. Best-effort: an emit
/// failure is logged via `tracing` and otherwise ignored (matches
/// `executor::emit_event`). The raw command line is NEVER logged here.
///
/// `allow(dead_code)` off Windows: only the Windows ETW callback calls this.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
pub(crate) fn emit_capture<R: Runtime>(app: &AppHandle<R>, event: &CaptureEvent) {
    if let Err(err) = app.emit(CAPTURE_EVENT, event) {
        tracing::error!("failed to emit capture event: {err}");
    }
}

/// Current UTC time as a minimal ISO-8601-ish string (seconds since epoch).
/// ProcMix has no time-crate dependency, and the frontend only displays this
/// value, so a small hand-rolled formatter keeps the dependency surface
/// unchanged. Shared by every platform `imp` that builds a [`CaptureEvent`].
///
/// `allow(dead_code)` on platforms with no capture backend (macOS/other):
/// only the Windows ETW and Linux cn_proc impls construct `CaptureEvent`s.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
pub(crate) fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Seconds since epoch as a sortable, unambiguous timestamp. The UI
    // formats it for display; precision finer than a second is not needed
    // for a capture row.
    format!("{secs}")
}

// ----------------------------------------------------------------------
// Fallback implementation (macOS and any other non-Windows, non-Linux OS):
// every operation reports unsupported. Kept in a private `imp` module so the
// public API above is platform-agnostic and the cfg-split lives in exactly
// one place (mirrors how `admin_password` keeps Unix specifics contained).
// ----------------------------------------------------------------------
#[cfg(not(any(windows, target_os = "linux")))]
mod imp {
    use super::CAPTURE_UNSUPPORTED;
    use tauri::{AppHandle, Runtime};

    /// Stand-in stop handle. Never constructed on this platform because
    /// [`start`] always errors before producing one.
    pub(super) enum StopHandle {}

    pub(super) fn start<R: Runtime>(
        _app: AppHandle<R>,
        _scope: crate::core::scope_tracker::CaptureScope,
    ) -> Result<StopHandle, String> {
        Err(CAPTURE_UNSUPPORTED.to_string())
    }

    pub(super) fn stop(handle: StopHandle) {
        // Uninhabited: there is no value to handle. The match proves to the
        // compiler this branch is unreachable without an `unwrap`/panic.
        match handle {}
    }

    pub(super) fn list_targets() -> Vec<super::CaptureTarget> {
        // No capture backend on this platform → nothing to scope to.
        Vec::new()
    }
}

// ----------------------------------------------------------------------
// Linux implementation: a netlink subscription to the kernel proc connector
// (`cn_proc`), reading `/proc/<pid>` for each exec to reconstruct the
// command line. The socket/parse/`/proc` machinery lives in the sibling
// `cn_proc` module; this `imp` is just the thin contract binding.
//
// Like the Windows ETW loop, the blocking `recv()` runs on a dedicated
// `std::thread` (named `procmix-capture`), NOT on the async runtime; `stop`
// flips an atomic and wakes the blocked `poll()` via a self-pipe so the
// thread exits promptly. See `docs/process-capture.md`.
// ----------------------------------------------------------------------
#[cfg(target_os = "linux")]
mod imp {
    use tauri::{AppHandle, Runtime};

    use super::super::cn_proc::{self, StartError};
    use super::CAPTURE_REQUIRES_PRIVILEGE;
    use crate::core::scope_tracker::CaptureScope;

    /// Owns the running cn_proc listener (worker thread + stop plumbing).
    pub(super) struct StopHandle {
        listener: cn_proc::Listener,
    }

    pub(super) fn start<R: Runtime>(
        app: AppHandle<R>,
        scope: CaptureScope,
    ) -> Result<StopHandle, String> {
        // Noise filter key: ProcMix's own exe basename, so its self-spawned
        // shells are excluded. `current_exe` should always resolve; fall
        // back to the known binary name so self-exclusion still works by
        // basename if it somehow fails.
        let self_exe = std::env::current_exe()
            .ok()
            .and_then(|p| p.to_str().map(str::to_owned))
            .unwrap_or_else(|| "procmix".to_string());

        match cn_proc::start(app, self_exe, scope) {
            Ok(listener) => Ok(StopHandle { listener }),
            // Missing CAP_NET_ADMIN: the feature is supported but the socket
            // could not be bound. Return the dedicated sentinel so the UI
            // shows a "grant the privilege" hint, NOT the generic
            // "unsupported" notice.
            Err(StartError::Privilege) => Err(CAPTURE_REQUIRES_PRIVILEGE.to_string()),
            Err(StartError::Other(msg)) => Err(msg),
        }
    }

    pub(super) fn stop(handle: StopHandle) {
        cn_proc::stop(handle.listener);
    }

    pub(super) fn list_targets() -> Vec<super::CaptureTarget> {
        cn_proc::list_targets()
    }
}

// ----------------------------------------------------------------------
// Windows implementation: an ETW kernel-logger subscription to the Process
// provider, whose Start event includes the launch command line.
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
    use ferrisetw::provider::kernel_providers::PROCESS_PROVIDER;
    use ferrisetw::provider::Provider;
    use ferrisetw::schema_locator::SchemaLocator;
    // `TraceTrait` must be in scope to call `KernelTrace::process_from_handle`,
    // which is a provided method on the trait (implemented for `KernelTrace`).
    use ferrisetw::trace::{stop_trace_by_name, KernelTrace, TraceTrait};
    use ferrisetw::EventRecord;
    use tauri::{AppHandle, Runtime};

    use super::{emit_capture, iso_now, CaptureEvent};
    use crate::core::capture_filter::CaptureFilter;
    use crate::core::scope_tracker::CaptureScope;

    /// Opcode 1 of the kernel Process provider is `Start` — a freshly created
    /// process, the only thing we surface. Opcode 3 (`DCStart`) enumerates the
    /// processes that were ALREADY running when the session opened, and 4 is
    /// rundown; we ignore those.
    const OPCODE_PROCESS_START: u8 = 1;

    /// Opcode 2 is `End` — a process exit. We do NOT surface it, but we feed
    /// its PID to the filter's `on_exit` so the scope tree is pruned (bounds
    /// PID reuse and clears `sh -c` wrapper state). See the scoping plan §3.1.
    const OPCODE_PROCESS_END: u8 = 2;

    /// Unique trace session name so start/stop can target it and a stale
    /// session from a crashed prior run can be torn down by name.
    const SESSION_NAME: &str = "ProcMixProcessCapture";

    /// Owns the running ETW session and its driver thread.
    ///
    /// The `trace` field keeps the `KernelTrace` alive for the whole session:
    /// `start()` returns it alongside the handle, and dropping it stops the
    /// session (per ferrisetw, "to stop the session, you can drop this
    /// instance"). If we dropped it at the end of [`start`], the session would
    /// die before the worker thread's `process_from_handle` ever ran. [`stop`]
    /// ends the named session (which unblocks the thread), joins the thread,
    /// and only then drops the trace.
    pub(super) struct StopHandle {
        running: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
        trace: KernelTrace,
    }

    pub(super) fn start<R: Runtime>(
        app: AppHandle<R>,
        scope: CaptureScope,
    ) -> Result<StopHandle, String> {
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
        //
        // Mandatory self-exclusion: exclude ProcMix's own subtree via our PID.
        //
        // TODO: Windows snapshot-seeding (Toolhelp `CreateToolhelp32Snapshot`)
        // for `Subtree`/self-exclusion is not yet implemented — an
        // already-running target app only picks up children launched after
        // recording starts.
        let self_roots: std::collections::HashSet<u32> =
            std::iter::once(std::process::id()).collect();
        let filter = Mutex::new(CaptureFilter::with_scope_and_self_subtree(
            &self_exe, scope, self_roots,
        ));

        // The kernel Process provider (NT Kernel Logger) carries the full
        // `CommandLine` of each launch — unlike the manifest
        // `Microsoft-Windows-Kernel-Process` provider, whose `ProcessStart`
        // event has no command-line field. Capturing command lines is the
        // whole point of the recorder, so this is the right provider.
        let provider = Provider::kernel(&PROCESS_PROVIDER)
            .add_callback(move |record: &EventRecord, locator: &SchemaLocator| {
                if !running_for_cb.load(Ordering::Relaxed) {
                    return;
                }
                match record.opcode() {
                    OPCODE_PROCESS_START => {
                        if let Some(event) = parse_process_start(record, locator) {
                            // Drop out-of-scope / self / system-noise / wrapper
                            // / duplicate starts before they reach the frontend.
                            let keep = filter
                                .lock()
                                .map(|mut f| {
                                    f.should_emit(
                                        event.pid,
                                        event.ppid,
                                        &event.image,
                                        &event.command_line,
                                    )
                                })
                                .unwrap_or(true);
                            if keep {
                                emit_capture(&app, &event);
                            }
                        }
                    }
                    OPCODE_PROCESS_END => {
                        // Prune the dead PID from the filter's tree/wrapper
                        // state. Never surfaced.
                        if let Some(pid) = parse_process_end(record, locator) {
                            if let Ok(mut f) = filter.lock() {
                                f.on_exit(pid);
                            }
                        }
                    }
                    _ => {}
                }
            })
            .build();

        // `start()` returns `(KernelTrace, TraceHandle)`. We process via the
        // HANDLE on a worker thread (`process_from_handle`), which — unlike
        // `KernelTrace::process()` — does NOT consume the trace. That lets us
        // keep the `KernelTrace` in the `StopHandle` so the session stays open,
        // and stop it explicitly later. The `process_from_handle` call blocks
        // until the session ends, so it must run off the main thread.
        //
        // On Windows 8+ a `KernelTrace` is a private system logger with its
        // own name, so our `SESSION_NAME` works and multiple system loggers
        // can coexist (we are not contending for the single legacy
        // "NT Kernel Logger").
        let (trace, handle) = KernelTrace::new()
            .named(SESSION_NAME.to_string())
            .enable(provider)
            .start()
            // `TraceError` implements `Debug` but not `Display`, so format
            // with `{e:?}`.
            .map_err(|e| format!("failed to start ETW kernel capture session: {e:?}"))?;

        let thread = std::thread::Builder::new()
            .name("procmix-capture".into())
            .spawn(move || {
                // Blocks until the named session is stopped (by `stop()`),
                // triggering the provider callback for each event. Driven by
                // the handle, so the owning `KernelTrace` lives in `StopHandle`.
                let _ = KernelTrace::process_from_handle(handle);
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

    /// Extract a [`CaptureEvent`] from a kernel Process `Start` record.
    /// Returns `None` if the schema lookup or the (required) PID parse fails,
    /// so a single malformed record can never crash the trace thread.
    ///
    /// Property names differ from the manifest provider: the classic kernel
    /// Process MOF event uses `ProcessId` / `ParentId` / `ImageFileName` /
    /// `CommandLine`. We try the manifest spellings (`ProcessID`,
    /// `ParentProcessID`, `ImageName`) as fallbacks so a schema-naming
    /// difference across Windows builds degrades gracefully instead of
    /// dropping the row.
    fn parse_process_start(record: &EventRecord, locator: &SchemaLocator) -> Option<CaptureEvent> {
        let schema = locator.event_schema(record).ok()?;
        let parser = Parser::create(record, &schema);

        // PID is required: without it the row cannot be deduped or trusted.
        let pid: u32 = parser
            .try_parse("ProcessId")
            .or_else(|_| parser.try_parse("ProcessID"))
            .ok()?;
        // PPID is informational; default to 0 if the schema omits it.
        let ppid: u32 = parser
            .try_parse("ParentId")
            .or_else(|_| parser.try_parse("ParentProcessID"))
            .unwrap_or(0);
        // `ImageFileName` is the executable's base name (it may be truncated
        // to ~15 chars by the kernel). Used as a label and for noise/self
        // filtering.
        let image: String = parser
            .try_parse::<String>("ImageFileName")
            .or_else(|_| parser.try_parse::<String>("ImageName"))
            .unwrap_or_default();
        // The real prize: the full command line as passed to CreateProcess
        // (normal `C:\…` paths, with arguments). Some processes start with
        // no command line — fall back to the image name so the row is still
        // actionable rather than empty.
        let command_line: String = parser
            .try_parse::<String>("CommandLine")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| image.clone());

        // A record with neither an image nor a command line carries nothing
        // worth showing.
        if image.is_empty() && command_line.is_empty() {
            return None;
        }

        Some(CaptureEvent {
            pid,
            ppid,
            image,
            command_line,
            timestamp: iso_now(),
        })
    }

    /// Extract just the exiting PID from a kernel Process `End` record (used
    /// only to prune the filter's scope tree — never surfaced). Returns
    /// `None` if the schema/PID parse fails.
    fn parse_process_end(record: &EventRecord, locator: &SchemaLocator) -> Option<u32> {
        let schema = locator.event_schema(record).ok()?;
        let parser = Parser::create(record, &schema);
        parser
            .try_parse("ProcessId")
            .or_else(|_| parser.try_parse("ProcessID"))
            .ok()
    }

    pub(super) fn list_targets() -> Vec<super::CaptureTarget> {
        // Enumerate every running process via the Toolhelp snapshot — the
        // Windows analogue of the Linux `/proc` walk (scoping plan §4.1).
        // First version: ALL processes; "has a visible window" filtering is
        // deferred (matches the Linux side). Best-effort: any Win32 failure
        // yields an empty list rather than erroring the IPC call.
        list_targets_toolhelp().unwrap_or_default()
    }

    /// Walk the Toolhelp process snapshot into `(pid, name)` capture targets,
    /// sorted by name (case-insensitive, PID tiebreak) for a stable picker —
    /// mirroring the Linux `cn_proc::list_targets` contract.
    ///
    /// Returns `None` only if the snapshot itself can't be taken; a snapshot
    /// with zero usable entries returns `Some(empty)`.
    fn list_targets_toolhelp() -> Option<Vec<super::CaptureTarget>> {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };

        // SAFETY: every call below follows the documented Toolhelp contract:
        // `CreateToolhelp32Snapshot` returns a handle we own and always close;
        // `PROCESSENTRY32W::dwSize` is set before the first iteration as the
        // API requires; the `*W` entry-name buffer is a fixed-size UTF-16
        // array we read up to its first NUL. No raw pointer outlives the loop.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.ok()?;

        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        let mut targets = Vec::new();
        // `Process32FirstW` fails (and we bail to an empty list) if the
        // snapshot is empty.
        if unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok() {
            loop {
                if let Some(name) = exe_name_from_entry(&entry.szExeFile) {
                    targets.push(super::CaptureTarget {
                        pid: entry.th32ProcessID,
                        name,
                    });
                }
                if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
                    break;
                }
            }
        }

        // Release the snapshot handle regardless of how the walk ended.
        let _ = unsafe { CloseHandle(snapshot) };

        targets.sort_by(|a, b| {
            a.name
                .to_ascii_lowercase()
                .cmp(&b.name.to_ascii_lowercase())
                .then(a.pid.cmp(&b.pid))
        });
        Some(targets)
    }

    /// Decode a Toolhelp `szExeFile` UTF-16 buffer (NUL-terminated, fixed
    /// length) into the executable's display name. `None` for an empty name
    /// (e.g. the System Idle Process), so it is skipped from the picker.
    fn exe_name_from_entry(buf: &[u16]) -> Option<String> {
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let name = String::from_utf16_lossy(&buf[..len]);
        if name.is_empty() {
            None
        } else {
            Some(name)
        }
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

    /// The privilege sentinel must stay an exact ASCII identifier and stay
    /// DISTINCT from the unsupported one — the frontend branches on each to
    /// show a different message (grant-privilege hint vs. unsupported notice).
    #[test]
    fn capture_requires_privilege_sentinel_is_exact_and_distinct() {
        assert_eq!(CAPTURE_REQUIRES_PRIVILEGE, "CAPTURE_REQUIRES_PRIVILEGE");
        assert_ne!(CAPTURE_REQUIRES_PRIVILEGE, CAPTURE_UNSUPPORTED);
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

    /// On platforms with NO capture backend (macOS / other), `start` must
    /// report unsupported rather than silently succeeding. Skipped on
    /// Windows (real ETW session) and Linux (real cn_proc socket) — both need
    /// a runtime + privileges and belong to manual/privileged QA.
    #[cfg(not(any(windows, target_os = "linux")))]
    #[tokio::test]
    async fn start_is_unsupported_off_windows() {
        // Build a mock Tauri app so we have a real `AppHandle`.
        let app = tauri::test::mock_app();
        let state = Arc::new(WatcherState::new());
        let err = start(
            app.handle().clone(),
            state.clone(),
            crate::core::scope_tracker::CaptureScope::All,
        )
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

    /// End-to-end Linux capture: start the cn_proc listener, spawn a known
    /// child, and assert a `capture-event` is emitted for it. `#[ignore]`d
    /// because binding the proc-connector multicast group needs
    /// `CAP_NET_ADMIN` — run only in privileged CI / manual QA:
    /// `sudo -E cargo test capture_emits_event_for_spawned_child -- --ignored`.
    #[cfg(target_os = "linux")]
    #[ignore = "needs CAP_NET_ADMIN to bind the proc connector multicast group"]
    #[tokio::test]
    async fn capture_emits_event_for_spawned_child() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::time::Duration;
        // `listen` lives on the `Listener` trait.
        use tauri::Listener;

        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let state = Arc::new(WatcherState::new());

        // Observe the capture channel: flip a flag when ANY event arrives.
        let seen = Arc::new(AtomicBool::new(false));
        let seen_for_listener = seen.clone();
        handle.listen(CAPTURE_EVENT, move |_event| {
            seen_for_listener.store(true, Ordering::Relaxed);
        });

        start(
            handle.clone(),
            state.clone(),
            crate::core::scope_tracker::CaptureScope::All,
        )
        .await
        .expect("capture should start with CAP_NET_ADMIN");
        assert!(state.is_running().await);

        // Spawn a short-lived child whose exec the connector should report.
        let _ = std::process::Command::new("true")
            .status()
            .expect("spawn `true`");

        // Poll for the event with a generous timeout.
        let mut got = false;
        for _ in 0..50 {
            if seen.load(Ordering::Relaxed) {
                got = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        stop(state.clone()).await.expect("stop should succeed");
        assert!(!state.is_running().await);
        assert!(got, "expected a capture-event for the spawned child");
    }

    /// Negative path (Layer 2b): when the process has NO `CAP_NET_ADMIN`,
    /// `start` must reject CLEANLY with the `CAPTURE_REQUIRES_PRIVILEGE`
    /// sentinel (so the UI shows the grant-capability hint), never succeed
    /// with a dead session. This is the contract a Flatpak/Snap confinement
    /// exercises: a seccomp-filtered `socket()` or a denied multicast `bind()`
    /// both surface as `EPERM`/`EACCES` → `StartError::Privilege` → this
    /// sentinel.
    ///
    /// `#[ignore]`d and run DELIBERATELY without the capability — e.g. drop
    /// it first (`sudo setcap -r <bin>`), or run inside an unprivileged user
    /// namespace / the actual sandbox:
    ///   `unshare --user --map-root-user <test-bin> --ignored --exact \
    ///     platform::process_watch::tests::start_without_privilege_is_rejected`
    ///
    /// NOT a normal CI test: a developer box that happens to grant the
    /// capability would see `start` succeed, which is a valid (different)
    /// outcome — hence the manual gate.
    #[cfg(target_os = "linux")]
    #[ignore = "run WITHOUT CAP_NET_ADMIN (e.g. inside the sandbox) to verify clean privilege rejection"]
    #[tokio::test]
    async fn start_without_privilege_is_rejected() {
        let app = tauri::test::mock_app();
        let state = Arc::new(WatcherState::new());

        let err = start(
            app.handle().clone(),
            state.clone(),
            crate::core::scope_tracker::CaptureScope::All,
        )
        .await
        .expect_err("start must fail without CAP_NET_ADMIN");

        // The exact sentinel the frontend branches on for the tailored hint.
        assert_eq!(
            err, CAPTURE_REQUIRES_PRIVILEGE,
            "privilege denial must surface as the dedicated sentinel, not a \
             generic error or a silent success"
        );
        // No half-started session may linger on the failure path.
        assert!(!state.is_running().await, "no session should be recorded");
    }
}
