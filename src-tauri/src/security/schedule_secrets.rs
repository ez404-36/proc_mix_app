// Keychain-backed storage for the SENSITIVE variable values a schedule needs
// at headless fire time.
//
// Why this exists
// ---------------
// A schedule persists pre-resolved variable values (a background cron fire
// cannot prompt the user). For a variable a command marks `sensitive`
// (a token, a password), storing that value in the `schedules.variable_values`
// SQLite column would write a plaintext secret to disk — violating the
// project rule that secrets live ONLY in the OS keychain, never in SQLite or
// JSON config (see AGENTS.md, `security::admin_password`).
//
// So the secret value is stored here, in the OS keychain, keyed by
// `(schedule id, variable name)`, and the SQLite column keeps only a stable
// SENTINEL reference (`SECRET_REF`) in place of the value. At fire time the
// scheduler swaps each sentinel back for the real value read from the
// keychain. The sentinel itself carries no secret, so a leaked `procmix.db`
// reveals nothing.
//
// All entries share the same keychain service as the sudo password
// (`app.procmix.desktop`); the account encodes the schedule + variable so
// many secrets coexist. Clearing a schedule clears each of its secrets.
//
// Like `admin_password`, this never logs the value or its length, and tests
// run against `keyring`'s in-memory mock backend.

use keyring::Entry;
use thiserror::Error;

/// Keychain service shared with the sudo-password entry. Stable across
/// releases — changing it would orphan stored secrets on the user's machine.
const SERVICE: &str = "app.procmix.desktop";

/// Sentinel stored in the `schedules.variable_values` JSON in place of a
/// sensitive value. It is NOT a secret — it is a fixed marker telling the
/// scheduler "read the real value from the keychain for this (schedule,
/// variable) pair". Kept a single ASCII token so a test can assert on it and a
/// future refactor cannot accidentally mutate it. The leading control-ish
/// prefix makes an accidental collision with a real user value effectively
/// impossible.
pub const SECRET_REF: &str = "\u{1}procmix:keychain-secret\u{1}";

/// Errors surfaced by this module. Mirrors `admin_password::AdminPasswordError`
/// — the inner message is safe to log (the `keyring` crate never includes the
/// secret in its error variants) but never the value itself.
#[derive(Debug, Error)]
pub enum ScheduleSecretError {
    #[error("keychain backend error: {0}")]
    Backend(String),
}

/// Build the keychain account string for a `(schedule, variable)` pair. The
/// `schedule-secret:` prefix namespaces these entries away from the
/// `admin-sudo` account so they can never collide.
fn account(schedule_id: &str, var_name: &str) -> String {
    format!("schedule-secret:{schedule_id}:{var_name}")
}

fn entry(schedule_id: &str, var_name: &str) -> Result<Entry, ScheduleSecretError> {
    Entry::new(SERVICE, &account(schedule_id, var_name))
        .map_err(|e| ScheduleSecretError::Backend(e.to_string()))
}

/// `true` when `value` is the sentinel reference (i.e. the real value lives in
/// the keychain, not in the JSON column).
pub fn is_secret_ref(value: &str) -> bool {
    value == SECRET_REF
}

/// Persist a sensitive variable value for `(schedule_id, var_name)`.
///
/// An empty value is treated as "no secret" — the caller removes any existing
/// entry instead (an empty secret carries nothing to protect and storing one
/// would just create a confusing keychain row). Returns `Ok(())` after the
/// store.
pub fn set(schedule_id: &str, var_name: &str, value: &str) -> Result<(), ScheduleSecretError> {
    entry(schedule_id, var_name)?
        .set_password(value)
        .map_err(|e| ScheduleSecretError::Backend(e.to_string()))
}

/// Read the sensitive value for `(schedule_id, var_name)`. Returns `Ok(None)`
/// when no entry exists (not an error — the schedule may predate the secret,
/// or the user cleared it), so the caller can decide how to degrade (the
/// scheduler records a `missingVariable` run).
pub fn get(schedule_id: &str, var_name: &str) -> Result<Option<String>, ScheduleSecretError> {
    match entry(schedule_id, var_name)?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(ScheduleSecretError::Backend(e.to_string())),
    }
}

/// Remove the stored secret for `(schedule_id, var_name)` if any. Idempotent —
/// a missing entry is not an error.
pub fn clear(schedule_id: &str, var_name: &str) -> Result<(), ScheduleSecretError> {
    match entry(schedule_id, var_name)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(ScheduleSecretError::Backend(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The sentinel must be a single stable token and must NOT look like a
    /// plausible user value, so it can never be mistaken for a real secret in
    /// the JSON column.
    #[test]
    fn secret_ref_is_recognised() {
        assert!(is_secret_ref(SECRET_REF));
        assert!(!is_secret_ref(""));
        assert!(!is_secret_ref("hunter2"));
        assert!(!is_secret_ref("procmix:keychain-secret"));
    }

    /// The account encodes both the schedule id and the variable name so two
    /// schedules (or two variables) never share an entry.
    #[test]
    fn account_is_unique_per_schedule_and_variable() {
        assert_ne!(account("s1", "token"), account("s2", "token"));
        assert_ne!(account("s1", "token"), account("s1", "apiKey"));
        assert!(account("s1", "token").starts_with("schedule-secret:"));
    }
}
