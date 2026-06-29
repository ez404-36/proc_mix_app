//! Window-behaviour commands: control what closing the main window does.
//!
//! Two commands back the Settings → Tray section:
//!   - [`get_window_behavior`] reads the persisted config (the `close_to_tray`
//!     flag) from `storage::window_behavior`.
//!   - [`set_window_behavior`] persists a new value AND updates the synchronous
//!     runtime cache the `CloseRequested` handler reads
//!     (`platform::tray::set_close_to_tray`), so the change takes effect for the
//!     very next window close without a restart.
//!
//! `close_to_tray = true` (default) → closing the window hides it to the tray;
//! `false` → closing the window quits ProcMix.

use tauri::State;

use crate::storage::window_behavior as storage_window_behavior;
use crate::storage::DbPool;

/// Read the persisted window-behaviour config for the Settings UI.
#[tauri::command]
pub async fn get_window_behavior(
    pool: State<'_, DbPool>,
) -> Result<storage_window_behavior::WindowBehaviorConfig, String> {
    storage_window_behavior::load(pool.inner()).await
}

/// Persist the window-behaviour config and update the runtime cache so the new
/// "close to tray" preference applies to the next window close immediately.
#[tauri::command]
pub async fn set_window_behavior(
    pool: State<'_, DbPool>,
    close_to_tray: bool,
) -> Result<(), String> {
    storage_window_behavior::save(
        pool.inner(),
        &storage_window_behavior::WindowBehaviorConfig { close_to_tray },
    )
    .await?;
    // Mirror into the synchronous cache the CloseRequested handler reads. Done
    // AFTER a successful persist so the cache never gets ahead of the DB.
    crate::platform::tray::set_close_to_tray(close_to_tray);
    Ok(())
}
