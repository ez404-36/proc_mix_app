//! Non-interactive reachability check for a configured SSH host.
//!
//! Given a host **alias** (the `Host` name from `~/.ssh/config`), we spawn
//! the system `ssh` client in batch mode to attempt a connect-and-exit, then
//! map the outcome to a [`SshCheckResult`]. We pass only the alias and let
//! `ssh` resolve `HostName`/`User`/`Port`/`IdentityFile` from the config —
//! ProcMix never assembles a raw `user@host` line, which keeps untrusted
//! values out of the argv entirely beyond the validated alias.
//!
//! ## Security
//!
//! The alias is the ONLY user-derived value reaching the child process. It
//! is:
//!   1. validated by [`is_safe_alias`] — an allow-list that rejects anything
//!      starting with `-` (option injection), any whitespace, and any shell
//!      metacharacter or control character;
//!   2. spawned via [`tokio::process::Command`] with a FIXED argument array —
//!      never through a shell — so even a metacharacter that somehow slipped
//!      past validation could not be interpreted.
//!
//! ## Batch mode / no hangs
//!
//! `-o BatchMode=yes` disables every interactive prompt (password,
//! passphrase, host-key confirmation), so the child exits promptly instead
//! of blocking on a TTY. Because of this a host that uses password or
//! passphrase auth exits non-zero with an auth error even though it is fully
//! reachable; [`is_auth_failure`] recognises those and reports the host as
//! reachable, since a credential rejection still proves we talked to an sshd.
//! `ConnectTimeout` bounds the TCP connect, and an
//! outer [`tokio::time::timeout`] is a hard backstop so a misbehaving `ssh`
//! can never stall the IPC handler. `StrictHostKeyChecking=accept-new`
//! avoids failing purely because a first-seen host isn't yet in
//! `known_hosts`, while still refusing a CHANGED key.

use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use super::types::SshCheckResult;
use crate::core::proc_ext::NoConsoleWindow;

/// TCP connect budget handed to `ssh` via `-o ConnectTimeout`. Seconds.
const SSH_CONNECT_TIMEOUT_SECS: u64 = 8;

/// Hard outer wall-clock budget for the whole probe. Slightly larger than
/// the connect timeout to allow for auth negotiation after TCP connect, but
/// finite so the handler can never hang.
const PROBE_TIMEOUT: Duration = Duration::from_secs(12);

/// `true` when `alias` is safe to pass as the destination argument to `ssh`.
///
/// Rejects, in order of concern:
///   - empty;
///   - a leading `-` (would be parsed as an option — injection);
///   - any ASCII whitespace or control character (multi-token / newline
///     smuggling);
///   - any character outside a conservative allow-list of those that
///     legitimately appear in an `ssh_config` `Host` alias.
///
/// The allow-list is intentionally broad enough for real aliases
/// (`prod`, `db-1`, `web.example.com`, `user_box`) but excludes every shell
/// metacharacter (`$`, backtick, quotes, `;`, `|`, `&`, `<`, `>`, `*`, `?`,
/// `(`, `)`, `\`, space). A wildcard alias (`*`, `?`) is also excluded — you
/// cannot "connect to" a pattern, only to a concrete host.
pub fn is_safe_alias(alias: &str) -> bool {
    if alias.is_empty() {
        return false;
    }
    if alias.starts_with('-') {
        return false;
    }
    alias
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '@'))
}

/// Build the fixed `ssh` argument vector for a batch reachability probe.
///
/// Split out (pure, no spawn) so the exact argv — and especially that the
/// alias lands as a standalone destination token, never concatenated — is
/// unit-testable.
fn build_args(alias: &str) -> Vec<String> {
    vec![
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        format!("ConnectTimeout={SSH_CONNECT_TIMEOUT_SECS}"),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "-o".into(),
        // One attempt only; the outer timeout is the real backstop.
        "ConnectionAttempts=1".into(),
        // Destination alias as a single standalone token. Validated by
        // is_safe_alias (no leading '-'), so ssh treats it as the host.
        alias.to_string(),
        // A trivial remote command so a successful auth exits 0 immediately
        // instead of opening an interactive shell.
        "true".into(),
    ]
}

/// `true` when `stderr` from a non-zero `ssh` exit indicates the server was
/// **reached** but declined *non-interactive* authentication.
///
/// In `BatchMode=yes` every prompt is suppressed, so a host that uses
/// password or passphrase-protected key auth (e.g. you normally type a
/// password interactively) makes `ssh` exit non-zero with an auth error —
/// even though the TCP connection and the SSH transport handshake both
/// succeeded. For a *reachability* probe that outcome is a success: we
/// definitively talked to an sshd. Only genuine connectivity faults
/// (timeout, refused, DNS, host-key mismatch) are truly unreachable.
///
/// The match is on the stable English text produced under `LC_ALL=C`.
fn is_auth_failure(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    // "Permission denied (publickey,password)." — server refused our creds.
    s.contains("permission denied")
        // Generic auth failures / too many attempts.
        || s.contains("authentication failed")
        || s.contains("too many authentication failures")
        // Key needs a passphrase BatchMode can't prompt for.
        || s.contains("enter passphrase")
        || s.contains("passphrase for key")
        // Server offers only keyboard-interactive / password we can't answer.
        || s.contains("keyboard-interactive")
}

/// Probe `alias` for reachability. Never returns an error to the caller — a
/// failed/unreachable host is a *successful* check with `reachable: false`,
/// so the UI always gets a definitive answer to render.
///
/// A non-interactive **auth** failure counts as reachable (see
/// [`is_auth_failure`]): reaching an sshd that declines batch-mode auth still
/// proves the host is up and connectable.
pub async fn check_alias(alias: &str) -> SshCheckResult {
    if !is_safe_alias(alias) {
        return SshCheckResult {
            reachable: false,
            message: "invalid host alias".to_string(),
        };
    }

    let mut command = Command::new("ssh");
    command
        .args(build_args(alias))
        // English error messages regardless of the user's locale, so the
        // surfaced `message` is stable/translatable on the JS side.
        .env("LC_ALL", "C")
        // Windows: probe ssh.exe without flashing a console window (no-op
        // elsewhere). See `core::proc_ext`.
        .no_console_window()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let child = match command.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Operational fault (no ssh binary), distinct from a host being
            // unreachable. Log it so a "every check fails" report is
            // diagnosable; the user still gets a definitive result.
            eprintln!("ssh check: ssh client not found (alias {alias:?})");
            return SshCheckResult {
                reachable: false,
                message: "ssh client not found".to_string(),
            };
        }
        Err(e) => {
            eprintln!("ssh check: failed to spawn ssh for alias {alias:?}: {e}");
            return SshCheckResult {
                reachable: false,
                message: format!("failed to start ssh: {e}"),
            };
        }
    };

    let output = match tokio::time::timeout(PROBE_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            // Faulted while waiting on the child — an operational error, not a
            // clean "host said no". Worth logging.
            eprintln!("ssh check: error waiting on ssh for alias {alias:?}: {e}");
            return SshCheckResult {
                reachable: false,
                message: format!("ssh failed: {e}"),
            };
        }
        Err(_) => {
            return SshCheckResult {
                reachable: false,
                message: "connection timed out".to_string(),
            };
        }
    };

    if output.status.success() {
        SshCheckResult {
            reachable: true,
            message: "reachable".to_string(),
        }
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        // A non-interactive auth failure proves we reached the sshd: TCP
        // connect + transport handshake succeeded, the server merely declined
        // credentials BatchMode can't supply. Report that as reachable so a
        // password/passphrase host isn't falsely shown as "unreachable".
        if is_auth_failure(&stderr) {
            SshCheckResult {
                reachable: true,
                message: "reachable (authentication required)".to_string(),
            }
        } else {
            SshCheckResult {
                reachable: false,
                message: if stderr.is_empty() {
                    "host unreachable".to_string()
                } else {
                    // ssh's stderr (e.g. "Connection timed out",
                    // "Connection refused") is the most useful detail.
                    stderr
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_realistic_aliases() {
        for alias in [
            "prod",
            "db-1",
            "web.example.com",
            "user_box",
            "host:1",
            "deploy@gateway",
            "a1.b2-c3",
        ] {
            assert!(is_safe_alias(alias), "should accept {alias}");
        }
    }

    #[test]
    fn rejects_option_injection() {
        for alias in ["-oProxyCommand=evil", "-v", "--", "-"] {
            assert!(!is_safe_alias(alias), "should reject {alias}");
        }
    }

    #[test]
    fn rejects_whitespace_and_control_chars() {
        for alias in ["a b", "a\tb", "a\nb", "a\rb", "with space"] {
            assert!(!is_safe_alias(alias), "should reject {alias:?}");
        }
    }

    #[test]
    fn rejects_shell_metacharacters() {
        for alias in [
            "a;rm -rf /",
            "a|b",
            "a&b",
            "a$b",
            "a`b`",
            "a>b",
            "a<b",
            "a(b)",
            "a\\b",
            "a'b'",
            "a\"b",
        ] {
            assert!(!is_safe_alias(alias), "should reject {alias}");
        }
    }

    #[test]
    fn rejects_wildcards_and_empty() {
        assert!(!is_safe_alias(""));
        assert!(!is_safe_alias("*.example.com"));
        assert!(!is_safe_alias("web?"));
    }

    #[test]
    fn args_place_alias_as_standalone_destination() {
        let args = build_args("prod");
        // The alias must appear exactly once, as its own element, immediately
        // before the trailing remote command — never concatenated with a flag.
        let alias_idx = args
            .iter()
            .position(|a| a == "prod")
            .expect("alias present");
        assert_eq!(args[alias_idx + 1], "true");
        // BatchMode must be present so the probe never blocks on a prompt.
        assert!(args.iter().any(|a| a == "BatchMode=yes"));
        // A connect timeout must be set.
        assert!(args.iter().any(|a| a.starts_with("ConnectTimeout=")));
    }

    #[test]
    fn auth_failures_count_as_reachable() {
        for stderr in [
            "Permission denied (publickey,password).",
            "Permission denied (publickey).",
            "user@host: Permission denied (password).",
            "Authentication failed.",
            "Received disconnect from 10.0.0.1 port 22:2: Too many authentication failures",
            "host_key_verification ... keyboard-interactive failed",
            "Enter passphrase for key '/home/u/.ssh/id_ed25519':",
        ] {
            assert!(
                is_auth_failure(stderr),
                "should be auth failure: {stderr:?}"
            );
        }
    }

    #[test]
    fn connectivity_failures_are_not_auth_failures() {
        for stderr in [
            "ssh: connect to host eist_astra port 22: Connection refused",
            "ssh: connect to host eist_astra port 22: Connection timed out",
            "ssh: Could not resolve hostname eist_astra: Name or service not known",
            "kex_exchange_identification: Connection closed by remote host",
            "@@@ REMOTE HOST IDENTIFICATION HAS CHANGED! @@@",
            "",
        ] {
            assert!(
                !is_auth_failure(stderr),
                "should NOT be auth failure: {stderr:?}"
            );
        }
    }

    #[tokio::test]
    async fn invalid_alias_short_circuits_without_spawning() {
        // A leading-dash alias must be rejected by validation, returning a
        // definitive non-reachable result without ever invoking ssh.
        let res = check_alias("-oProxyCommand=touch /tmp/pwned").await;
        assert!(!res.reachable);
        assert_eq!(res.message, "invalid host alias");
    }
}
