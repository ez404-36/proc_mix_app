// Elevated-run password resolution (Unix only).
//
// On Unix an elevated run shells out to `sudo -S`, which reads the
// password from stdin. This module resolves that password BEFORE the
// child is built — preferring a one-shot value from the request ("Continue
// without saving") and otherwise reading the OS keychain — and returns the
// exact sentinel error strings the JS bridge matches on by equality.
//
// Windows elevation goes through the UAC prompt (`Start-Process -Verb
// RunAs`), which reads no password from us, so this module is `#[cfg(unix)]`.

#[cfg(unix)]
use super::types::{
    ExecuteRequest, ERR_ADMIN_PASSWORD_BACKEND_PREFIX, ERR_ADMIN_PASSWORD_REQUIRED,
};
#[cfg(unix)]
use crate::security::admin_password;

/// Resolve the sudo password for an elevated Unix run.
///
/// Returns:
///   - `Ok(None)` when the run is not elevated (nothing to resolve).
///   - `Ok(Some(pw))` with the password to feed sudo's stdin.
///   - `Err(ERR_ADMIN_PASSWORD_REQUIRED)` when elevated but no one-shot
///     password was supplied and the keychain has no entry — the JS
///     bridge detects this exact string and opens the prompt.
///   - `Err("<ERR_ADMIN_PASSWORD_BACKEND_PREFIX><detail>")` when the
///     keychain backend itself errored (e.g. no D-Bus session bus).
///
/// Prefers the one-shot `req.admin_password` (the "Continue (don't save)"
/// flow): when present and non-blank it is used verbatim and the keychain
/// is never touched. Empty / blank strings are treated as absent so a
/// stray `""` can't slip through and hang sudo waiting for a real password.
#[cfg(unix)]
pub(super) fn resolve_admin_password(req: &ExecuteRequest) -> Result<Option<String>, String> {
    if !req.elevated {
        return Ok(None);
    }
    // Prefer the one-shot password from the request when present:
    // this is the "Continue (don't save)" flow where the UI prompts
    // the user, hands the value to this single run, and never writes
    // it to the keychain. Empty / blank strings are treated as absent
    // so a stray "" can't slip through and hang sudo waiting for a
    // real password.
    let one_shot = req.admin_password.as_ref().and_then(|pw| {
        let trimmed = pw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    if let Some(pw) = one_shot {
        Ok(Some(pw))
    } else {
        match admin_password::get() {
            Ok(Some(pw)) => Ok(Some(pw)),
            Ok(None) => Err(ERR_ADMIN_PASSWORD_REQUIRED.to_string()),
            Err(e) => Err(format!("{ERR_ADMIN_PASSWORD_BACKEND_PREFIX}{e}")),
        }
    }
}
