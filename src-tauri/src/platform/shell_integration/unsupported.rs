//! Fallback shell-integration backend for platforms without an implementation
//! (macOS and any non-Windows / non-Linux target). Every operation returns the
//! stable `SHELL_INTEGRATION_UNSUPPORTED` error so the IPC surface stays
//! identical across targets — mirroring the autostart mobile split. `status`
//! reports `supported = false` so the Settings UI hides / disables the toggle
//! rather than calling these.

use super::{ShellFavorite, ShellIntegration};

pub struct UnsupportedShellIntegration;

const UNSUPPORTED: &str =
    "SHELL_INTEGRATION_UNSUPPORTED: file-manager integration is available on Windows and Linux only";

impl ShellIntegration for UnsupportedShellIntegration {
    fn is_registered(&self) -> Result<bool, String> {
        // Never registered on an unsupported platform.
        Ok(false)
    }

    fn register(&self, _favorites: &[ShellFavorite]) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    fn unregister(&self) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }
}
