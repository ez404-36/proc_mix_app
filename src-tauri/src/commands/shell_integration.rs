//! Tauri commands for the file-manager shell integration (v0.12.0).
//!
//! Two commands back the Settings → System "Explorer integration" section:
//!   - [`shell_integration_status`] reports `{ supported, enabled }` — `enabled`
//!     read live from the OS registration (the source of truth), exactly like
//!     autostart.
//!   - [`set_shell_integration`] registers / unregisters the OS menu entries,
//!     materialising the current favorite set when enabling.
//!
//! The registration work lives in `platform::shell_integration`; these wrappers
//! only resolve the favorite set from the DB and forward. The favorites are
//! loaded the same way the tray submenu loads them, so both menus stay in sync.

use tauri::State;

use crate::platform::shell_integration::{self, ShellFavorite, ShellIntegrationStatus};
use crate::storage::DbPool;

/// Read the live shell-integration status (OS registration + build support).
#[tauri::command]
pub fn shell_integration_status() -> Result<ShellIntegrationStatus, String> {
    Ok(shell_integration::status())
}

/// Enable or disable the file-manager integration. When enabling, the current
/// favorite commands / workflows are materialised into the OS menu; when
/// disabling, the registration is removed.
#[tauri::command]
pub async fn set_shell_integration(
    pool: State<'_, DbPool>,
    enabled: bool,
) -> Result<(), String> {
    let favorites = load_shell_favorites(pool.inner()).await;
    shell_integration::set_enabled(enabled, &favorites)
}

/// Load the commands that opted into the Explorer context menu (via the
/// per-command `explorer_enabled` flag — INDEPENDENT of `favorite`) as
/// [`ShellFavorite`] menu entries, in library order (oldest first). Shared by
/// the enable path and the command-mutation refresh. A load failure logs and
/// yields an empty list rather than erroring — a transient DB hiccup must not
/// crash a command save.
///
/// Workflows are intentionally NOT included: a workflow has many nodes with
/// distinct variable scopes and cannot consume the selected `PROCMIX_SELECTED_PATH`,
/// so only commands appear in the file-manager menu.
pub(crate) async fn load_shell_favorites(pool: &DbPool) -> Vec<ShellFavorite> {
    let mut out = Vec::new();
    match crate::storage::commands::list_all(pool).await {
        Ok(list) => {
            for c in list.into_iter().filter(|c| c.explorer_enabled) {
                out.push(ShellFavorite {
                    kind: "command".to_string(),
                    id: c.id,
                    name: c.name,
                });
            }
        }
        Err(e) => {
            tracing::error!("shell-integration: failed to load explorer-enabled commands: {e}")
        }
    }
    out
}
