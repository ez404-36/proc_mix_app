//! OS file-manager context-menu integration (v0.12.0).
//!
//! Registers a "ProcMix" submenu in the system file manager's right-click menu
//! listing the user's favorite commands / workflows. Clicking an entry launches
//! that favorite HEADLESSLY (via `core::launch`), passing the right-clicked
//! filesystem path as the `PROCMIX_SELECTED_PATH` variable. The launch reaches
//! the running app through the single-instance argv hook (Stage 3); this module
//! owns only the OS-side REGISTRATION of the menu entries.
//!
//! ## Source of truth
//!
//! Like autostart, the OS registration itself is the single source of truth for
//! whether the integration is enabled — there is NO SQLite mirror. [`status`]
//! probes the OS ([`ShellIntegration::is_registered`]); [`set_enabled`]
//! registers / unregisters. This avoids a second source that could drift from
//! the real OS state when the user edits the registry / removes a `.desktop`
//! file by hand.
//!
//! ## Platforms
//!
//! - **Windows** ([`windows`]): `HKCU\Software\Classes` keys — no admin rights.
//!   Three roots cover the three right-click contexts: a file, a folder, and the
//!   folder background (empty area). See the module docs.
//! - **Linux** ([`linux`]): a freedesktop `.desktop` file with one
//!   `[Desktop Action …]` per favorite under `~/.local/share/applications`.
//! - **macOS / other** ([`unsupported`]): a stub returning
//!   `SHELL_INTEGRATION_UNSUPPORTED`, so the IPC surface stays identical across
//!   targets (mirrors the autostart mobile split).
//!
//! ## Security
//!
//! The registration writes a fixed command line that launches ProcMix with
//! `--run-favorite <kind>:<id> --path <selected>`, where `<selected>` is the OS
//! placeholder (`%1` / `%V` on Windows, `%f` / `%u` on Linux) the file manager
//! substitutes. The favorite `<kind>:<id>` come from ProcMix's own DB (trusted);
//! the path is untrusted and is validated + passed as a variable VALUE — never
//! built into a shell string — on the receiving side (Stage 3,
//! `core::launch`). This module never executes anything; it only writes
//! registration data.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
mod unsupported;

/// Upper bound on how many favorites the shell menu lists, matching the tray
/// submenu cap. A longer favorites list is truncated to the first
/// [`MAX_SHELL_FAVORITES`]; the user opens ProcMix for the rest. Keeps the
/// context menu usable and the registry / desktop file bounded.
pub const MAX_SHELL_FAVORITES: usize = 15;

/// One favorite rendered as a context-menu entry. `kind` is `"command"` /
/// `"workflow"`, `id` the logical id (round-tripped via the launch argv), and
/// `name` the visible label. Mirrors `platform::tray::FavoriteEntry` but is
/// owned here so the shell layer does not depend on the tray module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellFavorite {
    pub kind: String,
    pub id: String,
    pub name: String,
}

/// Live status of the shell integration, returned to the Settings UI.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellIntegrationStatus {
    /// `false` on platforms without an implementation (macOS / other), so the
    /// UI can hide / disable the toggle.
    pub supported: bool,
    /// Whether the OS registration currently exists (the source of truth).
    pub enabled: bool,
}

/// The platform-specific registration backend. One implementor per OS; the
/// active one is returned by [`backend`].
pub trait ShellIntegration {
    /// Whether the integration is currently registered in the OS.
    fn is_registered(&self) -> Result<bool, String>;

    /// (Re)write the OS registration to list exactly `favorites` (already
    /// capped by the caller). Replaces any previous registration so a stale
    /// entry never lingers.
    fn register(&self, favorites: &[ShellFavorite]) -> Result<(), String>;

    /// Remove the OS registration entirely. Idempotent — unregistering when
    /// nothing is registered is a successful no-op.
    fn unregister(&self) -> Result<(), String>;
}

/// The active platform backend.
#[cfg(target_os = "windows")]
fn backend() -> impl ShellIntegration {
    windows::WindowsShellIntegration::new()
}

#[cfg(target_os = "linux")]
fn backend() -> impl ShellIntegration {
    linux::LinuxShellIntegration::new()
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
fn backend() -> impl ShellIntegration {
    unsupported::UnsupportedShellIntegration
}

/// Whether this platform has a shell-integration implementation at all.
pub const fn is_supported() -> bool {
    cfg!(any(target_os = "windows", target_os = "linux"))
}

/// Read the live status: `supported` from the build target, `enabled` by
/// probing the OS registration. A probe error maps to `enabled = false` (we
/// could not confirm a registration) and is logged — the UI shows the toggle
/// off rather than erroring.
pub fn status() -> ShellIntegrationStatus {
    let enabled = if is_supported() {
        backend().is_registered().unwrap_or_else(|e| {
            tracing::warn!("shell-integration: is_registered probe failed: {e}");
            false
        })
    } else {
        false
    };
    ShellIntegrationStatus {
        supported: is_supported(),
        enabled,
    }
}

/// Enable or disable the integration. Enabling (re)writes the registration with
/// the given favorites (capped to [`MAX_SHELL_FAVORITES`]); disabling removes
/// it. On an unsupported platform both return `SHELL_INTEGRATION_UNSUPPORTED`.
pub fn set_enabled(enabled: bool, favorites: &[ShellFavorite]) -> Result<(), String> {
    if !is_supported() {
        return Err("SHELL_INTEGRATION_UNSUPPORTED: file-manager integration is \
                    available on Windows and Linux only"
            .to_string());
    }
    let backend = backend();
    if enabled {
        let capped: Vec<ShellFavorite> =
            favorites.iter().take(MAX_SHELL_FAVORITES).cloned().collect();
        backend.register(&capped)
    } else {
        backend.unregister()
    }
}

/// Re-write the registration to reflect a changed favorite set, but ONLY when
/// the integration is currently enabled. A no-op (and never an error) when the
/// integration is off or unsupported — called from the favorite-mutation
/// commands, which must not fail just because the integration is disabled.
pub fn refresh_if_enabled(favorites: &[ShellFavorite]) {
    if !is_supported() {
        return;
    }
    let backend = backend();
    match backend.is_registered() {
        Ok(true) => {
            let capped: Vec<ShellFavorite> =
                favorites.iter().take(MAX_SHELL_FAVORITES).cloned().collect();
            if let Err(e) = backend.register(&capped) {
                tracing::error!("shell-integration: failed to refresh registration: {e}");
            }
        }
        Ok(false) => {}
        Err(e) => tracing::warn!("shell-integration: refresh probe failed: {e}"),
    }
}

/// Resolve the absolute path to the running ProcMix executable, used verbatim
/// as the launcher program in the OS registration. Surfaced as a typed error
/// (never a panic) so a failure to resolve it disables registration cleanly.
pub(crate) fn current_exe_path() -> Result<std::path::PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("cannot resolve ProcMix executable path: {e}"))
}

/// Build the launch arguments (after the exe) for a favorite. Produces
/// `["--run-favorite", "<kind>:<id>", "--path", <path_placeholder>]`.
///
/// Windows-only: the Windows registry backend substitutes the Explorer
/// placeholder (`%1` / `%V`) for `path_placeholder`. The Linux backend builds
/// its own argv inside the generated file-manager script (the path comes from a
/// manager-specific env var, not a placeholder), so it does not use this.
/// The `<kind>:<id>` token comes from the trusted DB.
#[cfg(target_os = "windows")]
pub(crate) fn launch_args(fav: &ShellFavorite, path_placeholder: &str) -> Vec<String> {
    vec![
        "--run-favorite".to_string(),
        format!("{}:{}", fav.kind, fav.id),
        "--path".to_string(),
        path_placeholder.to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn launch_args_shape() {
        let fav = ShellFavorite {
            kind: "command".into(),
            id: "abc-123".into(),
            name: "Build".into(),
        };
        assert_eq!(
            launch_args(&fav, "%1"),
            vec![
                "--run-favorite".to_string(),
                "command:abc-123".to_string(),
                "--path".to_string(),
                "%1".to_string(),
            ]
        );
    }

    #[test]
    fn is_supported_matches_target() {
        assert_eq!(
            is_supported(),
            cfg!(any(target_os = "windows", target_os = "linux"))
        );
    }
}
