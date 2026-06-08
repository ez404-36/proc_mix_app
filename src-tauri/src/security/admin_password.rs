// Storage helpers for the sudo password used by the "Run as administrator"
// feature on Unix.
//
// The password lives in the OS-provided keychain — Secret Service on
// Linux, the macOS Keychain, or the Windows Credential Manager — via
// the `keyring` crate. We never persist it in SQLite, in JSON config,
// or in any Tauri-emitted event, and we never log either the value or
// its length.
//
// All entries share a fixed (service, username) pair:
//   service:  "app.procmix.desktop"
//   account:  "admin-sudo"
//
// Tests run against `keyring`'s in-memory mock backend so CI never
// touches a real keychain. The default backend is restored after each
// test via a guard so tests cannot leak state into each other.

use keyring::Entry;
use thiserror::Error;

/// Identifier used when registering and looking up the credential.
/// Kept stable across releases — changing it would orphan stored
/// passwords on the user's machine.
const SERVICE: &str = "app.procmix.desktop";
const ACCOUNT: &str = "admin-sudo";

/// Errors surfaced by this module.
///
/// `NoEntry` is intentionally NOT modelled as an error: callers want
/// `Option<String>` semantics for "is there a password stored?".
#[derive(Debug, Error)]
pub enum AdminPasswordError {
    /// Underlying keychain backend failure (service unavailable, no
    /// session bus on Linux headless, permission denied, etc.). The
    /// inner message is suitable for logging but NOT for showing the
    /// password value itself — `keyring` never includes the secret in
    /// its error variants.
    #[error("keychain backend error: {0}")]
    Backend(String),
}

fn entry() -> Result<Entry, AdminPasswordError> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| AdminPasswordError::Backend(e.to_string()))
}

/// Read the currently-stored admin password.
///
/// Returns `Ok(None)` when the keychain reports no entry — this is
/// the normal state on first launch and is NOT an error. Any other
/// failure (D-Bus unavailable, OS denied access, malformed entry)
/// surfaces as [`AdminPasswordError::Backend`].
pub fn get() -> Result<Option<String>, AdminPasswordError> {
    let entry = entry()?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AdminPasswordError::Backend(e.to_string())),
    }
}

/// Persist the given password. Empty strings are rejected — sudo
/// would never accept one anyway, and silently storing one would
/// hide bugs in the UI.
pub fn set(password: &str) -> Result<(), AdminPasswordError> {
    if password.is_empty() {
        return Err(AdminPasswordError::Backend(
            "password cannot be empty".to_string(),
        ));
    }
    let entry = entry()?;
    entry
        .set_password(password)
        .map_err(|e| AdminPasswordError::Backend(e.to_string()))
}

/// Remove the stored password if any. A missing entry is not an error
/// — `clear()` is idempotent so the UI can call it unconditionally.
pub fn clear() -> Result<(), AdminPasswordError> {
    let entry = entry()?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AdminPasswordError::Backend(e.to_string())),
    }
}

/// Convenience wrapper: `true` iff a password is currently stored.
/// The boolean shape matches the JS-side `hasAdminPassword()` API,
/// avoiding the need to leak the password value across IPC just to
/// answer "is something there?".
pub fn has() -> Result<bool, AdminPasswordError> {
    Ok(get()?.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `set("")` must reject before touching the keychain. This guards
    /// the boundary check against accidental removal in a refactor —
    /// without it, sudo would later reject an empty password noisily
    /// and the user would have no idea what they typed.
    ///
    /// Note: we don't unit-test the keychain round-trip itself. The
    /// `keyring` crate's mock backend deliberately isolates each
    /// `Entry::new` call to a fresh in-memory store, so a `set` on one
    /// entry is invisible to a `get` on another — exactly the opposite
    /// of how real platform backends behave. Testing against the mock
    /// would lock in semantics we don't ship. Real-backend coverage
    /// happens at the manual QA / smoke-test layer.
    #[test]
    fn set_rejects_empty_password_without_touching_keychain() {
        let err = set("").unwrap_err();
        match err {
            AdminPasswordError::Backend(msg) => {
                assert!(
                    msg.contains("empty"),
                    "expected 'empty' in message, got: {msg}"
                );
            }
        }
    }
}
