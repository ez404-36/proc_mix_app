//! Process Capture commands.
//!
//! Control the background "command recorder" (see `docs/process-capture.md`).
//! `WatcherState` lives in app state alongside `ExecutorState`. The watcher
//! emits captured process starts on the `capture-event` channel; the raw
//! capture stream is ephemeral on the frontend and is never persisted here.
//!
//! The frontend must only call `start_process_capture` AFTER the user has
//! granted one-time consent (`processCaptureEnabled`) — that gate lives in
//! the TS layer (`resolveCaptureConsent`). On non-Windows, `start` returns
//! the `CAPTURE_UNSUPPORTED` sentinel so the UI can hide the feature.

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::core::scope_tracker::CaptureScope;
use crate::platform::process_watch::{self, WatcherState};

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
