// Storage + generation helpers for the Bearer token guarding the built-in
// HTTP API (see core::http_server::auth).
//
// Like the sudo password (security::admin_password), the token lives ONLY in
// the OS-provided keychain — Secret Service on Linux, the macOS Keychain, or
// the Windows Credential Manager — via the `keyring` crate. It is NEVER
// persisted in SQLite, in JSON config, in any Tauri-emitted event, or in any
// log line. The frontend can ask whether a token exists (`has`) and trigger a
// regenerate (which returns the new value EXACTLY ONCE for display/copy), but
// the stored value is otherwise read only in-process by the auth middleware.
//
// All entries share a fixed (service, account) pair:
//   service:  "app.procmix.desktop"
//   account:  "http-api-token"
//
// Tests run against `keyring`'s in-memory mock backend (the same pattern as
// admin_password) so CI never touches a real keychain.

use base64::Engine;
use keyring::Entry;
use rand::RngCore;
use thiserror::Error;

/// Identifier used when registering and looking up the credential. Kept stable
/// across releases — changing it would orphan a user's stored token.
const SERVICE: &str = "app.procmix.desktop";
const ACCOUNT: &str = "http-api-token";

/// Number of random bytes in a generated token before base64url encoding.
/// 32 bytes = 256 bits of entropy — far beyond brute-force reach.
const TOKEN_BYTES: usize = 32;

/// Errors surfaced by this module. `NoEntry` is intentionally modelled as
/// `Ok(None)` (see [`get`]) rather than an error: callers want
/// "is a token stored?" semantics.
#[derive(Debug, Error)]
pub enum ApiTokenError {
    /// Underlying keychain backend failure (service unavailable, no session
    /// bus on a headless Linux box, permission denied, …). The inner message
    /// is safe to log — `keyring` never includes the secret in its errors.
    #[error("keychain backend error: {0}")]
    Backend(String),
}

fn entry() -> Result<Entry, ApiTokenError> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| ApiTokenError::Backend(e.to_string()))
}

/// Read the currently-stored API token.
///
/// Returns `Ok(None)` when the keychain reports no entry — the normal state
/// before a token has been generated, NOT an error. Any other failure surfaces
/// as [`ApiTokenError::Backend`]. Called in-process by the auth middleware on
/// every authenticated request, so it must stay cheap.
pub fn get() -> Result<Option<String>, ApiTokenError> {
    let entry = entry()?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(ApiTokenError::Backend(e.to_string())),
    }
}

/// Persist the given token. Empty strings are rejected — an empty Bearer token
/// would let every request through, so storing one would be a security bug.
pub fn set(token: &str) -> Result<(), ApiTokenError> {
    if token.is_empty() {
        return Err(ApiTokenError::Backend("token cannot be empty".to_string()));
    }
    let entry = entry()?;
    entry
        .set_password(token)
        .map_err(|e| ApiTokenError::Backend(e.to_string()))
}

/// Remove the stored token if any. A missing entry is not an error — `clear()`
/// is idempotent so the UI can call it unconditionally.
pub fn clear() -> Result<(), ApiTokenError> {
    let entry = entry()?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(ApiTokenError::Backend(e.to_string())),
    }
}

/// Convenience wrapper: `true` iff a token is currently stored. The boolean
/// shape matches the JS-side `apiTokenStatus()` API, avoiding the need to leak
/// the token value across IPC just to answer "is one set?".
pub fn has() -> Result<bool, ApiTokenError> {
    Ok(get()?.is_some())
}

/// Generate a fresh cryptographically-random token, persist it, and return the
/// plaintext value EXACTLY ONCE for the caller to display/copy. After this call
/// the only way to retrieve the value is the in-process [`get`]; the frontend
/// never receives it again. Overwrites any existing token (regenerate).
///
/// The token is 32 random bytes (256 bits) encoded as base64url-no-pad, giving
/// a URL-safe ASCII string with no `=` padding that is convenient to paste into
/// an `Authorization: Bearer …` header.
pub fn generate() -> Result<String, ApiTokenError> {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    set(&token)?;
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `set("")` must reject before touching the keychain — an empty Bearer
    /// token would authenticate every request. Guards the boundary check
    /// against accidental removal in a refactor.
    ///
    /// Note: we don't unit-test the keychain round-trip itself. The `keyring`
    /// mock backend isolates each `Entry::new` call to a fresh in-memory store,
    /// so a `set` on one entry is invisible to a `get` on another — the
    /// opposite of real platform behaviour. Real-backend coverage happens at
    /// the manual QA / smoke-test layer (same rationale as admin_password).
    #[test]
    fn set_rejects_empty_token_without_touching_keychain() {
        let err = set("").unwrap_err();
        match err {
            ApiTokenError::Backend(msg) => {
                assert!(
                    msg.contains("empty"),
                    "expected 'empty' in message, got: {msg}"
                );
            }
        }
    }

    /// A generated token must be non-empty, URL-safe (no `+`, `/`, or `=`), and
    /// of the expected base64url length for 32 bytes (43 chars, unpadded).
    /// Generation itself does not depend on a real keychain for the encoding —
    /// only the `set` write does, which the mock backend accepts.
    #[test]
    fn generate_produces_url_safe_token() {
        let token = generate().expect("generate should succeed against the mock keychain");
        assert!(!token.is_empty(), "token must be non-empty");
        assert_eq!(token.len(), 43, "32 bytes base64url-no-pad = 43 chars");
        assert!(
            !token.contains('+') && !token.contains('/') && !token.contains('='),
            "token must be URL-safe with no padding: {token}"
        );
    }
}
