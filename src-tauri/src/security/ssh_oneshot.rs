// Transient (one-shot) storage for an SSH password used by a single remote
// command run.
//
// Unlike `admin_password` — which keeps ONE sudo password under a fixed
// account for reuse — this module stores a password under a THROWAWAY account
// keyed by the run's id (`ssh-oneshot:<run_id>`). The password is entered by
// the user per run, parked here for the few milliseconds between spawning
// `ssh` and the `SSH_ASKPASS` helper reading it, then deleted. It is never
// persisted across runs and never returned to the JS side.
//
// Why the keychain at all for a one-shot value? Because `ssh` cannot read a
// password from its stdin / argv / a file safely, and putting it in the
// spawned process's environment block would expose it (same-UID/root can read
// `/proc/<pid>/environ` for the ssh session lifetime). Parking it in the OS
// keychain and handing the helper only an opaque `run_id` keeps the secret out
// of every process's environment — see
// `docs/plans/ssh-remote-password-transient-keychain.md`.
//
// The value lives in the OS-provided keychain — Secret Service on Linux, the
// macOS Keychain, or the Windows Credential Manager — via the `keyring` crate.
// We never persist it in SQLite, in JSON config, or in any Tauri-emitted
// event, and we never log either the value or its length.
//
// All entries share the same service as the rest of the app:
//   service:  "app.procmix.desktop"
//   account:  "ssh-oneshot:<run_id>"
//
// Tests run against `keyring`'s in-memory mock backend (the default in test
// builds), and — as in `admin_password` — deliberately do NOT exercise the
// keychain round-trip: the mock isolates each `Entry::new` call to a fresh
// store, so a `put` on one entry is invisible to a `take` on the same key,
// which is the opposite of how real platform backends behave. Testing against
// the mock would lock in semantics we don't ship. Real-backend coverage
// happens at the manual QA / smoke-test layer.

use keyring::Entry;
use thiserror::Error;

/// Service identifier shared with the other keychain modules. Kept stable
/// across releases — changing it would orphan any in-flight entries.
const SERVICE: &str = "app.procmix.desktop";

/// Prefix for the per-run throwaway account. The full account name is
/// `ssh-oneshot:<run_id>`.
const ACCOUNT_PREFIX: &str = "ssh-oneshot:";

/// Errors surfaced by this module.
///
/// As in `admin_password`, `NoEntry` is intentionally NOT modelled as an
/// error: `take`/`clear` want `Option`/idempotent semantics for "is there a
/// password parked for this run?".
#[derive(Debug, Error)]
pub enum SshOneShotError {
    /// The supplied `run_id` was empty. A throwaway account must be keyed by a
    /// real run id; an empty key would collide across runs.
    #[error("run id cannot be empty")]
    EmptyRunId,
    /// The supplied password was empty. `ssh` would hang on the askpass prompt
    /// waiting for a real password, so we reject it at the boundary.
    #[error("password cannot be empty")]
    EmptyPassword,
    /// Underlying keychain backend failure (service unavailable, no session
    /// bus on Linux headless, permission denied, etc.). The inner message is
    /// suitable for logging but never contains the secret — `keyring` never
    /// includes the password in its error variants.
    #[error("keychain backend error: {0}")]
    Backend(String),
}

/// Build the keychain account name for a run.
fn account(run_id: &str) -> String {
    format!("{ACCOUNT_PREFIX}{run_id}")
}

fn entry(run_id: &str) -> Result<Entry, SshOneShotError> {
    if run_id.is_empty() {
        return Err(SshOneShotError::EmptyRunId);
    }
    Entry::new(SERVICE, &account(run_id)).map_err(|e| SshOneShotError::Backend(e.to_string()))
}

/// Park the one-shot password for `run_id` just before spawning `ssh`.
///
/// An empty `run_id` or password is rejected before the keychain is touched —
/// both indicate a caller bug, and an empty password would later hang `ssh`'s
/// askpass prompt.
pub fn put(run_id: &str, password: &str) -> Result<(), SshOneShotError> {
    if password.is_empty() {
        return Err(SshOneShotError::EmptyPassword);
    }
    entry(run_id)?
        .set_password(password)
        .map_err(|e| SshOneShotError::Backend(e.to_string()))
}

/// Read AND delete the parked password for `run_id` in one logical step.
/// Called only by the `procmix-askpass` helper.
///
/// Returns `Ok(None)` when nothing is parked (e.g. key auth already succeeded
/// so `ssh` never asked, or the entry was already cleared) — this is not an
/// error. The delete is best-effort: a `NoEntry` on delete is ignored, and the
/// run finalizer calls [`clear`] again regardless, so a parked password can
/// never outlive its run.
pub fn take(run_id: &str) -> Result<Option<String>, SshOneShotError> {
    let e = entry(run_id)?;
    let password = match e.get_password() {
        Ok(s) => Some(s),
        Err(keyring::Error::NoEntry) => None,
        Err(err) => return Err(SshOneShotError::Backend(err.to_string())),
    };
    // Delete immediately after reading so the secret does not linger. A
    // missing entry here is not an error.
    if let Err(err) = e.delete_credential() {
        if !matches!(err, keyring::Error::NoEntry) {
            return Err(SshOneShotError::Backend(err.to_string()));
        }
    }
    Ok(password)
}

/// Remove the parked password for `run_id`, if any.
///
/// Called by the run finalizer on EVERY terminal outcome (finished / error /
/// cancelled / timeout), so a throwaway entry can never be orphaned when the
/// helper did not run (key auth succeeded, or `ssh` failed before prompting).
/// Idempotent: a missing entry is not an error, so it is safe to call after
/// [`take`] already deleted it.
pub fn clear(run_id: &str) -> Result<(), SshOneShotError> {
    let e = entry(run_id)?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(SshOneShotError::Backend(err.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `put` must reject an empty password before touching the keychain — an
    /// empty value would later hang `ssh`'s askpass prompt waiting for input.
    #[test]
    fn put_rejects_empty_password_without_touching_keychain() {
        let err = put("run-1", "").unwrap_err();
        assert!(
            matches!(err, SshOneShotError::EmptyPassword),
            "got: {err:?}"
        );
    }

    /// `put` must reject an empty run id — a throwaway account keyed by "" would
    /// collide across runs.
    #[test]
    fn put_rejects_empty_run_id() {
        let err = put("", "hunter2").unwrap_err();
        assert!(matches!(err, SshOneShotError::EmptyRunId), "got: {err:?}");
    }

    /// `take`/`clear` also reject an empty run id at the boundary (the same
    /// guard, so a malformed call can't address an unintended account).
    #[test]
    fn take_and_clear_reject_empty_run_id() {
        assert!(matches!(take("").unwrap_err(), SshOneShotError::EmptyRunId));
        assert!(matches!(
            clear("").unwrap_err(),
            SshOneShotError::EmptyRunId
        ));
    }

    /// The account name is the run id under the shared one-shot prefix. Pinned
    /// so a refactor can't silently change the key shape the helper relies on.
    #[test]
    fn account_name_is_prefixed_run_id() {
        assert_eq!(account("abc-123"), "ssh-oneshot:abc-123");
    }
}
