//! Autostart commands: launch ProcMix at system startup.
//!
//! Two commands back the Settings → Autostart section:
//!   - [`autostart_status`] reports the LIVE state — `enabled` from the OS
//!     registration (`AutoLaunchManager::is_enabled()`, the source of truth) and
//!     `startMinimized` from `storage::autostart`.
//!   - [`set_autostart`] enables/disables the OS registration and persists the
//!     `start_minimized` behaviour flag.
//!
//! The OS registration (Windows Run key / macOS LaunchAgent / Linux .desktop) is
//! managed by `tauri-plugin-autostart`, which is desktop-only. The command
//! bodies are therefore split: on desktop they talk to the plugin; on mobile
//! they return a stable `AUTOSTART_UNSUPPORTED` error so the IPC surface stays
//! identical across targets.
//!
//! NOTE (dev): in `tauri dev` the registration points at the dev binary, so a
//! real system launch won't start the packaged app. Toggling/reading state still
//! works; verify actual autostart on a built bundle.

use tauri::State;

use crate::storage::autostart as storage_autostart;
use crate::storage::DbPool;

/// Live autostart status for the Settings UI. `enabled` is read from the OS, not
/// SQLite, so it stays correct even if the user toggled autostart through the OS.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartStatus {
    pub enabled: bool,
    pub start_minimized: bool,
}

/// Read the live autostart status (OS registration + persisted behaviour flag).
#[tauri::command]
pub async fn autostart_status(
    app: tauri::AppHandle,
    pool: State<'_, DbPool>,
) -> Result<AutostartStatus, String> {
    let enabled = is_enabled(&app)?;
    let cfg = storage_autostart::load(pool.inner()).await?;
    Ok(AutostartStatus {
        enabled,
        start_minimized: cfg.start_minimized,
    })
}

/// Enable/disable the OS autostart registration and persist `start_minimized`.
///
/// `start_minimized` is encoded into the registration only indirectly (via the
/// `--autostart` arg the plugin was initialised with); the flag itself is read
/// at launch from SQLite. When the flag changes while autostart is already
/// enabled there is nothing in the registration to rewrite, so a plain persist
/// suffices — but we still reconcile the OS state to match `enabled`.
#[tauri::command]
pub async fn set_autostart(
    app: tauri::AppHandle,
    pool: State<'_, DbPool>,
    enabled: bool,
    start_minimized: bool,
) -> Result<(), String> {
    // Persist the behaviour flag first so a system launch reads the latest
    // value even if the OS toggle below partially fails.
    storage_autostart::save(
        pool.inner(),
        &storage_autostart::AutostartConfig { start_minimized },
    )
    .await?;

    set_enabled(&app, enabled)?;
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn is_enabled(app: &tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
        .is_enabled()
        .map_err(|e| format!("AUTOSTART_ERROR: {e}"))
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn is_enabled(_app: &tauri::AppHandle) -> Result<bool, String> {
    Err("AUTOSTART_UNSUPPORTED: autostart is desktop-only".to_string())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn set_enabled(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager
            .enable()
            .map_err(|e| format!("AUTOSTART_ERROR: {e}"))
    } else {
        manager
            .disable()
            .map_err(|e| format!("AUTOSTART_ERROR: {e}"))
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn set_enabled(_app: &tauri::AppHandle, _enabled: bool) -> Result<(), String> {
    Err("AUTOSTART_UNSUPPORTED: autostart is desktop-only".to_string())
}
