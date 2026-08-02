//! Tauri commands exposed to the frontend via `invoke()`.
//!
//! This module is the hub: the actual command wrappers live in per-domain
//! submodules and are re-exported here so the `tauri::generate_handler!`
//! list in `lib.rs` can keep referencing every command as `commands::<name>`
//! (the command NAME is part of the IPC contract and never changes). The
//! `sftp` submodule is referenced directly (`commands::sftp::<name>`) and so
//! is left as a plain `pub mod`.

pub mod app;
pub mod autostart;
pub mod capture;
pub mod command;
pub mod history;
pub mod http_server;
pub mod miniapps;
pub mod plugins;
pub mod schedules;
pub mod security;
pub mod sftp;
pub mod shell_integration;
pub mod sound;
pub mod ssh;
pub mod terminal;
pub mod window_behavior;
pub mod workflows;

/// Convert any error into the IPC error string the frontend receives.
///
/// This is the canonical replacement for the repeated
/// `.map_err(|e| e.to_string())` keychain wrappers (admin-password,
/// ssh-password, api-token). It produces a byte-for-byte identical string to
/// the previous inline closure — `to_string()` on a `Display` type is exactly
/// what the closure did — so the serialized error reaching the frontend is
/// unchanged.
pub(crate) fn to_ipc_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// Re-export every command so `commands::<name>` paths stay valid for the
// `generate_handler!` macro in `lib.rs`. The macro needs not just the command
// FUNCTION but also the helper `macro_rules!` items that `#[tauri::command]`
// emits beside each fn (`__cmd__<name>`, `__tauri_command_name_<name>`), so a
// glob re-export is required — a named `pub use func` would leave those macros
// behind and `generate_handler!` would fail to resolve them.
//
// `sftp` keeps its `commands::sftp::<name>` path and is intentionally not
// flattened here.

pub use app::*;
pub use autostart::*;
pub use capture::*;
pub use command::*;
pub use history::*;
pub use http_server::*;
pub use miniapps::*;
pub use plugins::*;
pub use schedules::*;
pub use security::*;
pub use shell_integration::*;
pub use sound::*;
pub use ssh::*;
pub use terminal::*;
pub use window_behavior::*;
pub use workflows::*;
