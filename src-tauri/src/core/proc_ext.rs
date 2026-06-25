//! Cross-platform spawn hardening: suppress the console window every child
//! process would otherwise flash on Windows.
//!
//! ProcMix is a GUI application (`#![windows_subsystem = "windows"]`), so it
//! has no console of its own. When it spawns a CONSOLE subsystem child —
//! `cmd.exe`, `powershell.exe`, `ssh.exe`, `sftp.exe`, `taskkill.exe`,
//! `reg.exe`, … — Windows allocates a brand-new console for that child, which
//! pops up a black window for the lifetime of the process (often just a
//! flash). For a tool that spawns commands constantly — manual runs, the cron
//! scheduler, the HTTP API, reachability probes, flag-hint probes — this is
//! the single most visible defect on Windows.
//!
//! The fix is the [`CREATE_NO_WINDOW`] process-creation flag, which tells the
//! kernel not to allocate a console for the child. We expose it as an
//! extension method, [`NoConsoleWindow::no_console_window`], implemented for
//! BOTH `tokio::process::Command` and `std::process::Command`.
//!
//! The two types reach `creation_flags` differently:
//!   - `std::process::Command` gets it from the SEALED trait
//!     `std::os::windows::process::CommandExt` (must be in scope to call).
//!   - `tokio::process::Command` does NOT (and cannot) implement that sealed
//!     trait; it exposes its own INHERENT `creation_flags` method (Windows
//!     only), so we call it directly with no trait import.
//!
//! On every non-Windows target the method is a no-op that returns the command
//! unchanged, so call sites stay platform-agnostic: just chain
//! `.no_console_window()` before `.spawn()`/`.output()`.
//!
//! SECURITY NOTE: this flag affects ONLY console-window allocation. It does
//! not change the child's tokens, privileges, environment, or argv — the
//! sandboxed-executor invariants are untouched.

/// `CREATE_NO_WINDOW` from the Win32 process-creation flags. The child runs
/// without a console window. Defined locally (rather than pulling a Win32
/// binding into every crate) because it is a single, stable ABI constant.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Chainable extension to suppress the console window a console-subsystem
/// child would flash on Windows. No-op on every other platform.
pub trait NoConsoleWindow {
    /// Apply `CREATE_NO_WINDOW` (Windows) so the spawned child gets no console
    /// window. Returns `&mut Self` so it chains with the other builder calls
    /// (`.args(...).no_console_window().spawn()`).
    fn no_console_window(&mut self) -> &mut Self;
}

impl NoConsoleWindow for tokio::process::Command {
    fn no_console_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            // tokio's `Command` has its OWN inherent `creation_flags` (Windows
            // only) — it does NOT implement the sealed `CommandExt`, so no trait
            // import here (importing it would be an unused-import warning).
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

impl NoConsoleWindow for std::process::Command {
    fn no_console_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The flag value must be exactly Win32's `CREATE_NO_WINDOW` (0x08000000).
    /// A wrong constant would silently re-introduce the flashing window (or set
    /// an unrelated creation flag), so pin it. Windows-only (the const does not
    /// exist on other targets).
    #[cfg(windows)]
    #[test]
    fn create_no_window_constant_is_exact() {
        assert_eq!(CREATE_NO_WINDOW, 0x0800_0000);
    }

    /// The method must be chainable (return `&mut Self`) for both Command
    /// types so call sites can do `.args(..).no_console_window().spawn()`.
    /// This compiles+runs on every platform: on non-Windows it is the no-op
    /// path, which still must type-check and return the command.
    #[test]
    fn no_console_window_is_chainable_for_both_command_types() {
        let mut tokio_cmd = tokio::process::Command::new("true");
        let _: &mut tokio::process::Command = tokio_cmd.no_console_window();

        let mut std_cmd = std::process::Command::new("true");
        let _: &mut std::process::Command = std_cmd.no_console_window();
    }
}
