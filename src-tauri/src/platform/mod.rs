// OS-specific code: hotkeys, tray, context menu, autostart.

// Linux Process Capture backend (netlink proc connector + `/proc` reads).
// Gated to Linux; the Windows backend lives inline in `process_watch.rs`.
#[cfg(target_os = "linux")]
mod cn_proc;
pub mod process_watch;
pub mod tray;
