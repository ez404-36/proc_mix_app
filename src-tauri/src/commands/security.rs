//! Admin-password and per-host SSH-password keychain commands.
//!
//! These thin wrappers manage secrets stored in the OS keychain via
//! `security::admin_password` / `security::ssh_password`. A secret VALUE is
//! never echoed back to the frontend — only a boolean status is queryable.
//! Every wrapper surfaces a keychain error through [`super::to_ipc_err`],
//! which produces the same string as the previous inline
//! `.map_err(|e| e.to_string())`.
//!
//! ## Admin password
//!
//! The admin-password trio manages the sudo password used by the "Run as
//! administrator" feature on Unix. The password is stored in the OS keychain
//! via `security::admin_password`, NEVER in SQLite or any Tauri-emitted event.
//!
//! On Windows the elevation path is UAC and these commands are still callable
//! (they manage the same keychain entry), but no current platform UI invokes
//! them. Tests cover only the empty-password boundary check; round-trip
//! behavior is validated by manual QA against the real OS keychain (see
//! `security::admin_password` tests for the rationale).
//!
//! ## Persistent SSH password (Phase 2)
//!
//! The SSH-password trio manages the OPTIONAL per-host SSH password used by
//! password-authenticated remote runs, stored in the OS keychain via
//! `security::ssh_password` (account `ssh-password:<alias>`). As with the
//! admin-password commands, the value is NEVER echoed back to the frontend —
//! only a boolean status is queryable (`has_ssh_password`). The actual `get`
//! is consumed in-process by the `procmix-askpass` sidecar, never over IPC.
//!
//! The `alias` is user-derived (`~/.ssh/config`); `security::ssh_password`
//! allow-list validates it with `core::ssh::is_safe_alias` on every call, so
//! these commands stay thin and re-validation is centralized. Unix-only in
//! practice (the spawn path ignores a remote password on Windows), but the
//! commands compile and manage the same keychain entry everywhere.

use crate::security::admin_password;
use crate::security::ssh_password;

use super::to_ipc_err;

/// Returns `true` if a sudo password is currently stored in the OS
/// keychain. Used by the Settings UI to decide between "Set password"
/// and "Clear saved password", and by the CommandForm to decide
/// whether to show the "you'll be asked on first run" hint.
#[tauri::command]
pub fn admin_password_status() -> Result<bool, String> {
    admin_password::has().map_err(to_ipc_err)
}

/// Persist the given sudo password. The password is trimmed of
/// leading/trailing whitespace because a stray newline from a paste
/// would make sudo reject every subsequent run. Empty strings (after
/// trimming) are rejected with a typed error rather than silently
/// stored — sudo would reject them too, and storing one would create
/// an "I can't log in any more" mystery for the user.
#[tauri::command]
pub fn set_admin_password(password: String) -> Result<(), String> {
    let trimmed = password.trim();
    if trimmed.is_empty() {
        return Err("password cannot be empty".to_string());
    }
    admin_password::set(trimmed).map_err(to_ipc_err)
}

/// Remove the stored sudo password. Idempotent — calling it when
/// nothing is stored is not an error, so the UI can call it
/// unconditionally without first reading the status.
#[tauri::command]
pub fn clear_admin_password() -> Result<(), String> {
    admin_password::clear().map_err(to_ipc_err)
}

/// Returns `true` if a password is currently stored for `alias`. Used by the
/// command form's TargetSelector to toggle between "Set password" and
/// "Clear saved password" and to show the saved indicator.
#[tauri::command]
pub fn has_ssh_password(alias: String) -> Result<bool, String> {
    ssh_password::has(&alias).map_err(to_ipc_err)
}

/// Persist `password` for `alias`. The password is trimmed because a stray
/// newline from a paste would make the askpass helper hand `ssh` a wrong
/// secret. An empty password (after trimming) is rejected with a typed error
/// rather than silently stored — `ssh` would hang on the prompt, and storing a
/// blank would create an "auth keeps failing" mystery. The alias is validated
/// inside `ssh_password::set`.
#[tauri::command]
pub fn set_ssh_password(alias: String, password: String) -> Result<(), String> {
    let trimmed = password.trim();
    if trimmed.is_empty() {
        return Err("password cannot be empty".to_string());
    }
    ssh_password::set(&alias, trimmed).map_err(to_ipc_err)
}

/// Remove the stored password for `alias`. Idempotent — calling it when nothing
/// is stored is not an error, so the UI can call it unconditionally without
/// first checking the status.
#[tauri::command]
pub fn clear_ssh_password(alias: String) -> Result<(), String> {
    ssh_password::clear(&alias).map_err(to_ipc_err)
}
