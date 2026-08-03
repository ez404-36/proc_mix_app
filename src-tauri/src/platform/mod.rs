// OS-specific code: hotkeys, tray, context menu, autostart.

// Linux Process Capture backend (netlink proc connector + `/proc` reads).
// Gated to Linux; the Windows backend lives inline in `process_watch.rs`.
#[cfg(target_os = "linux")]
mod cn_proc;
pub mod process_watch;
// Standalone quick-launch prompt dialog window (v0.12.0): collects variable /
// admin input for a tray / shell launch without showing the main window.
pub mod quick_prompt;
// Standalone Mini-App runner windows: each running mini-app opens in its own
// OS window (`miniapp-<id>`), openable from the Library or the tray's
// "Mini-Apps" submenu without showing the main window.
pub mod miniapp_window;
// File-manager context-menu integration (v0.12.0). Cross-platform façade with
// per-OS backends (Windows registry / Linux .desktop / unsupported stub).
pub mod shell_integration;
pub mod tray;
