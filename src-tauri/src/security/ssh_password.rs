// Persistent per-host storage for an SSH password used by remote command runs.
//
// This is Phase 2 of the SSH remote-password feature. Unlike `ssh_oneshot` —
// which parks a password under a THROWAWAY account for the lifetime of a single
// run — this module stores a password PERSISTENTLY, one per SSH host alias, so
// a password host can run unattended (schedule / workflow) without an
// interactive prompt. Key/agent auth remains the recommended default; a stored
// password is a fallback.
//
// The value lives in the OS-provided keychain — Secret Service on Linux, the
// macOS Keychain, or the Windows Credential Manager — via the `keyring` crate.
// We never persist it in SQLite, in JSON config, or in any Tauri-emitted event,
// and we never log either the value or its length. The value is NEVER returned
// across IPC: the JS side only ever learns whether a password exists (`has`),
// exactly like `admin_password`. The actual `get` is consumed in-process by the
// `procmix-askpass` sidecar.
//
// All entries share the same service as the rest of the app:
//   service:  "app.procmix.desktop"
//   account:  "ssh-password:<alias>"
//
// Security boundary: the `<alias>` part of the account name is user-derived
// (it comes from `~/.ssh/config`). It is allow-list validated by
// `core::ssh::is_safe_alias` — the SAME check the spawn path and the
// reachability probe use — at the START of every public function, so arbitrary
// text can never become a credential-store key (and a value can never be
// addressed by a malformed alias). This is the single difference from
// `admin_password`, whose account is a fixed constant.
//
// Tests run against `keyring`'s in-memory mock backend (the default in test
// builds) and — as in `admin_password` / `ssh_oneshot` — deliberately do NOT
// exercise the keychain round-trip: the mock isolates each `Entry::new` call to
// a fresh store, so a `set` on one entry is invisible to a `get` on another,
// the opposite of how real platform backends behave. Tests cover only the
// boundary guards (empty password, unsafe alias) and the account-name shape.
// Real-backend coverage happens at the manual QA / smoke-test layer.

use keyring::Entry;
use thiserror::Error;

use crate::core::ssh::is_safe_alias;

/// Service identifier shared with the other keychain modules. Kept stable
/// across releases — changing it would orphan stored passwords on the user's
/// machine.
const SERVICE: &str = "app.procmix.desktop";

/// Prefix for the per-host account. The full account name is
/// `ssh-password:<alias>`.
const ACCOUNT_PREFIX: &str = "ssh-password:";

/// Errors surfaced by this module.
///
/// As in `admin_password`, `NoEntry` is intentionally NOT modelled as an
/// error: callers want `Option<String>` / idempotent semantics for "is there a
/// password stored for this host?".
#[derive(Debug, Error)]
pub enum SshPasswordError {
    /// The supplied alias failed `is_safe_alias`. Arbitrary text must not
    /// become a credential-store key, so it is rejected before the keychain is
    /// touched. The alias is echoed back so the caller can surface which value
    /// was rejected — it is not a secret.
    #[error("invalid SSH alias: {0}")]
    InvalidAlias(String),
    /// The supplied password was empty. A blank stored password would later
    /// hang `ssh`'s askpass prompt waiting for real input, so we reject it at
    /// the boundary (matching `admin_password`).
    #[error("password cannot be empty")]
    EmptyPassword,
    /// Underlying keychain backend failure (service unavailable, no session bus
    /// on Linux headless, permission denied, etc.). The inner message is
    /// suitable for logging but never contains the secret — `keyring` never
    /// includes the password in its error variants.
    #[error("keychain backend error: {0}")]
    Backend(String),
}

/// Build the keychain account name for a host alias.
fn account(alias: &str) -> String {
    format!("{ACCOUNT_PREFIX}{alias}")
}

/// Resolve an `Entry` for `alias`, validating the alias first.
///
/// The `is_safe_alias` guard is the security boundary of this module: it runs
/// before any keychain access, so an unsafe alias can never address (or create)
/// a credential-store entry.
fn entry(alias: &str) -> Result<Entry, SshPasswordError> {
    if !is_safe_alias(alias) {
        return Err(SshPasswordError::InvalidAlias(alias.to_string()));
    }
    Entry::new(SERVICE, &account(alias)).map_err(|e| SshPasswordError::Backend(e.to_string()))
}

/// Read the stored password for `alias`.
///
/// Returns `Ok(None)` when the keychain reports no entry — the normal state for
/// a host that uses key auth, and NOT an error. Consumed in-process by the
/// `procmix-askpass` sidecar; never returned across IPC.
pub fn get(alias: &str) -> Result<Option<String>, SshPasswordError> {
    let entry = entry(alias)?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(SshPasswordError::Backend(e.to_string())),
    }
}

/// Persist `password` for `alias`. Empty passwords are rejected — `ssh` would
/// hang on the askpass prompt waiting for a real one, and silently storing a
/// blank value would hide UI bugs.
pub fn set(alias: &str, password: &str) -> Result<(), SshPasswordError> {
    // Validate the alias first (via `entry`), THEN the password: an unsafe
    // alias is a harder error than a blank password and must short-circuit
    // before we inspect the (secret) value at all.
    let entry = entry(alias)?;
    if password.is_empty() {
        return Err(SshPasswordError::EmptyPassword);
    }
    entry
        .set_password(password)
        .map_err(|e| SshPasswordError::Backend(e.to_string()))
}

/// Remove the stored password for `alias`, if any. A missing entry is not an
/// error — `clear` is idempotent so the UI can call it unconditionally.
pub fn clear(alias: &str) -> Result<(), SshPasswordError> {
    let entry = entry(alias)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(SshPasswordError::Backend(e.to_string())),
    }
}

/// Convenience wrapper: `true` iff a password is currently stored for `alias`.
///
/// The boolean shape is what the JS side sees (`hasSshPassword(alias)`),
/// avoiding leaking the password value across IPC just to answer "is something
/// there?" — exactly like `admin_password::has`.
pub fn has(alias: &str) -> Result<bool, SshPasswordError> {
    Ok(get(alias)?.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `set` must reject an empty password before writing it — a blank value
    /// would later hang `ssh`'s askpass prompt. (See the module note on why we
    /// don't unit-test the keychain round-trip.)
    #[test]
    fn set_rejects_empty_password() {
        let err = set("prod", "").unwrap_err();
        assert!(
            matches!(err, SshPasswordError::EmptyPassword),
            "got: {err:?}"
        );
    }

    /// Every public function must reject an unsafe alias at the boundary, so
    /// arbitrary text can never become a credential-store key. A leading `-`
    /// (option-injection shape) is the canonical unsafe alias.
    #[test]
    fn unsafe_alias_is_rejected_by_every_entry_point() {
        let bad = "-oProxyCommand=evil";
        assert!(matches!(
            set(bad, "hunter2").unwrap_err(),
            SshPasswordError::InvalidAlias(_)
        ));
        assert!(matches!(
            get(bad).unwrap_err(),
            SshPasswordError::InvalidAlias(_)
        ));
        assert!(matches!(
            clear(bad).unwrap_err(),
            SshPasswordError::InvalidAlias(_)
        ));
        assert!(matches!(
            has(bad).unwrap_err(),
            SshPasswordError::InvalidAlias(_)
        ));
    }

    /// An alias containing whitespace / shell metacharacters is also rejected
    /// (it could never be a real `~/.ssh/config` Host token anyway).
    #[test]
    fn alias_with_metacharacters_is_rejected() {
        assert!(matches!(
            set("a host", "pw").unwrap_err(),
            SshPasswordError::InvalidAlias(_)
        ));
        assert!(matches!(
            set("a;b", "pw").unwrap_err(),
            SshPasswordError::InvalidAlias(_)
        ));
    }

    /// The account name is the alias under the shared ssh-password prefix.
    /// Pinned so a refactor can't silently change the key shape the sidecar
    /// relies on.
    #[test]
    fn account_name_is_prefixed_alias() {
        assert_eq!(account("prod-db"), "ssh-password:prod-db");
    }
}
