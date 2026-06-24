// Bearer-token authentication for the built-in HTTP API.
//
// Every `/api/*` route except `GET /api/health` requires a valid
// `Authorization: Bearer <token>` header whose value matches the token stored
// in the OS keychain (`security::api_token`). The comparison is CONSTANT-TIME
// (via `subtle`) so a timing side-channel cannot leak the token byte-by-byte.
// The per-IP rate limiter (`HttpServerState`) bounds online brute force.
//
// This module is pure auth LOGIC — it does not touch axum types — so it is
// trivially unit-testable. The router wires it into a middleware layer.

use subtle::ConstantTimeEq;

/// Outcome of validating a request's `Authorization` header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthOutcome {
    /// The header carried a Bearer token equal to the stored token.
    Ok,
    /// No token is configured server-side. Every authenticated request is
    /// rejected until the user generates one (the server should not run at all
    /// without a token, but this is a defensive fail-closed).
    NoTokenConfigured,
    /// The header was absent, malformed, or carried the wrong token.
    Unauthorized,
}

/// Extract the Bearer credential from a raw `Authorization` header value.
/// Returns `None` when the header is absent or is not a `Bearer <token>` form.
/// The scheme match is ASCII-case-insensitive per RFC 7235; the token itself is
/// taken verbatim (a single leading space after the scheme is consumed).
pub fn extract_bearer(header: Option<&str>) -> Option<&str> {
    let header = header?;
    let rest = header.strip_prefix("Bearer ").or_else(|| {
        // Case-insensitive scheme: accept "bearer "/"BEARER " etc.
        let (scheme, rest) = header.split_once(' ')?;
        scheme.eq_ignore_ascii_case("bearer").then_some(rest)
    })?;
    let token = rest.trim();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

/// Compare a presented token against the configured token in constant time.
///
/// `configured` is `None` when no token is stored (fail closed →
/// `NoTokenConfigured`). The constant-time `ct_eq` over the byte slices avoids
/// the early-return timing leak of `==`. A length mismatch still runs the
/// comparison (over the shorter prefix) and returns `Unauthorized` — `ct_eq`
/// only compares equal-length slices, so we guard length explicitly but
/// uniformly (both branches do a `ct_eq`) to keep timing flat.
pub fn verify(presented: Option<&str>, configured: Option<&str>) -> AuthOutcome {
    let Some(configured) = configured else {
        return AuthOutcome::NoTokenConfigured;
    };
    let Some(presented) = presented else {
        // Still perform a dummy constant-time compare so a missing header and
        // a wrong token take indistinguishable time.
        let _ = configured.as_bytes().ct_eq(configured.as_bytes());
        return AuthOutcome::Unauthorized;
    };

    let a = presented.as_bytes();
    let b = configured.as_bytes();
    // `ct_eq` requires equal lengths to be meaningful; when lengths differ the
    // tokens cannot be equal. Compare anyway over a padded view to keep the
    // time independent of WHERE the mismatch is, then AND in the length check.
    let len_eq = (a.len() == b.len()) as u8;
    let bytes_eq = if a.len() == b.len() {
        a.ct_eq(b).unwrap_u8()
    } else {
        // Run a same-length dummy compare so timing doesn't reveal the length.
        let _ = b.ct_eq(b);
        0u8
    };
    if (len_eq & bytes_eq) == 1 {
        AuthOutcome::Ok
    } else {
        AuthOutcome::Unauthorized
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_bearer_token() {
        assert_eq!(extract_bearer(Some("Bearer abc123")), Some("abc123"));
        assert_eq!(extract_bearer(Some("bearer abc123")), Some("abc123"));
        assert_eq!(extract_bearer(Some("BEARER  spaced ")), Some("spaced"));
    }

    #[test]
    fn rejects_non_bearer_or_empty() {
        assert_eq!(extract_bearer(None), None);
        assert_eq!(extract_bearer(Some("Basic abc")), None);
        assert_eq!(extract_bearer(Some("Bearer ")), None);
        assert_eq!(extract_bearer(Some("token")), None);
    }

    #[test]
    fn verify_accepts_matching_token() {
        assert_eq!(verify(Some("s3cr3t"), Some("s3cr3t")), AuthOutcome::Ok);
    }

    #[test]
    fn verify_rejects_wrong_token() {
        assert_eq!(verify(Some("wrong"), Some("s3cr3t")), AuthOutcome::Unauthorized);
        // Different lengths must also be Unauthorized, not a panic.
        assert_eq!(verify(Some("short"), Some("longer-token")), AuthOutcome::Unauthorized);
    }

    #[test]
    fn verify_handles_missing_credentials_and_config() {
        assert_eq!(verify(None, Some("s3cr3t")), AuthOutcome::Unauthorized);
        assert_eq!(verify(Some("anything"), None), AuthOutcome::NoTokenConfigured);
        assert_eq!(verify(None, None), AuthOutcome::NoTokenConfigured);
    }
}
