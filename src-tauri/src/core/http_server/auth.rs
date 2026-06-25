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

use std::net::Ipv4Addr;

use subtle::ConstantTimeEq;

/// Validate a request's `Host` header against the set of host names this server
/// legitimately answers to. This is a defence against DNS-rebinding: a browser
/// page on `evil.example` can be tricked into resolving to `127.0.0.1`, but it
/// cannot forge a `Host` header — so rejecting any `Host` that is not one of our
/// expected values stops a rebinding attacker from reaching the API through a
/// victim's browser.
///
/// `host_header` is the raw `Host` value (may include a `:port` suffix and may
/// be an IPv6 literal in brackets). It is matched, case-insensitively on the
/// host portion, against:
///   - `localhost`, `127.0.0.1`, `[::1]`/`::1` (always allowed — loopback);
///   - the bound LAN IPv4 address, when the server is bound to `0.0.0.0`
///     (`bind_lan`) and a LAN IP was detected.
///
/// The port suffix, if present, must equal the bound `port`. A bare host with no
/// port is accepted (some clients omit it). An empty/absent header is REJECTED
/// (fail closed) — every well-behaved HTTP/1.1 client sends `Host`.
///
/// Returns `true` when the request may proceed, `false` when it must be refused.
pub fn is_host_allowed(
    host_header: Option<&str>,
    port: u16,
    bind_lan: bool,
    lan_ip: Option<Ipv4Addr>,
) -> bool {
    let Some(raw) = host_header else {
        return false; // No Host header — fail closed.
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return false;
    }

    // Split host and optional port, handling IPv6 literals like `[::1]:8080`.
    let (host, port_part) = split_host_port(raw);
    if host.is_empty() {
        return false;
    }

    // If a port is present it must match the bound port. A parse failure or a
    // mismatch is a reject (an attacker-chosen Host with the wrong port is not
    // one we serve).
    if let Some(port_str) = port_part {
        match port_str.parse::<u16>() {
            Ok(p) if p == port => {}
            _ => return false,
        }
    }

    // Loopback names are always valid (default bind is 127.0.0.1).
    let host_lc = host.to_ascii_lowercase();
    if host_lc == "localhost" || host_lc == "127.0.0.1" || host_lc == "::1" {
        return true;
    }

    // When exposed on the LAN, the detected LAN IPv4 is also a valid Host.
    if bind_lan {
        if let Some(ip) = lan_ip {
            if host == ip.to_string() {
                return true;
            }
        }
    }

    false
}

/// Split a raw `Host` header into its host and optional port parts, correctly
/// handling bracketed IPv6 literals (`[::1]` / `[::1]:8080`). For a normal
/// `host:port` the last `:` separates them; a host with no `:` has no port.
fn split_host_port(raw: &str) -> (&str, Option<&str>) {
    if let Some(rest) = raw.strip_prefix('[') {
        // IPv6 literal: `[addr]` or `[addr]:port`.
        if let Some((addr, after)) = rest.split_once(']') {
            let port = after.strip_prefix(':').filter(|s| !s.is_empty());
            return (addr, port);
        }
        // Malformed bracket — treat the whole thing as the host.
        return (raw, None);
    }
    match raw.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (raw, None),
    }
}

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

    #[test]
    fn host_allows_loopback_names() {
        for h in ["localhost", "127.0.0.1", "localhost:8765", "127.0.0.1:8765", "LOCALHOST"] {
            assert!(is_host_allowed(Some(h), 8765, false, None), "should allow {h:?}");
        }
        assert!(is_host_allowed(Some("[::1]"), 8765, false, None));
        assert!(is_host_allowed(Some("[::1]:8765"), 8765, false, None));
    }

    #[test]
    fn host_rejects_missing_or_foreign() {
        // No / empty Host — fail closed.
        assert!(!is_host_allowed(None, 8765, false, None));
        assert!(!is_host_allowed(Some(""), 8765, false, None));
        assert!(!is_host_allowed(Some("   "), 8765, false, None));
        // A rebinding attacker's domain.
        assert!(!is_host_allowed(Some("evil.example"), 8765, false, None));
        assert!(!is_host_allowed(Some("evil.example:8765"), 8765, false, None));
    }

    #[test]
    fn host_rejects_wrong_port() {
        assert!(!is_host_allowed(Some("localhost:9999"), 8765, false, None));
        assert!(!is_host_allowed(Some("127.0.0.1:1"), 8765, false, None));
        assert!(!is_host_allowed(Some("localhost:notaport"), 8765, false, None));
    }

    #[test]
    fn host_allows_lan_ip_only_when_bound_lan() {
        let lan: Ipv4Addr = "192.168.1.50".parse().unwrap();
        // Not bound to LAN → the LAN IP is NOT a valid Host.
        assert!(!is_host_allowed(Some("192.168.1.50"), 8765, false, Some(lan)));
        // Bound to LAN → it is.
        assert!(is_host_allowed(Some("192.168.1.50"), 8765, true, Some(lan)));
        assert!(is_host_allowed(Some("192.168.1.50:8765"), 8765, true, Some(lan)));
        // A different IP is still rejected.
        assert!(!is_host_allowed(Some("10.0.0.1"), 8765, true, Some(lan)));
        // Loopback still works under LAN bind.
        assert!(is_host_allowed(Some("localhost"), 8765, true, Some(lan)));
    }
}
