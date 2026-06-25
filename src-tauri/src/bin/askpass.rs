// `procmix-askpass` — the SSH_ASKPASS helper for remote password auth.
//
// When ProcMix runs a remote command whose host needs a password, the executor
// (Unix only) spawns `ssh` with `SSH_ASKPASS=<this binary>`,
// `SSH_ASKPASS_REQUIRE=force`, no controlling TTY, and exactly ONE of two
// password-source env vars that tell this helper where to read the secret:
//
//   PROCMIX_ASKPASS_RUN_ID=<run_id>   — one-shot (Phase 1): the executor parked
//                                       a per-run password under a throwaway
//                                       keychain entry (`ssh-oneshot:<run_id>`)
//                                       just before spawning. The helper takes
//                                       (reads + deletes) it.
//   PROCMIX_ASKPASS_ALIAS=<alias>     — persistent (Phase 2): the user saved a
//                                       password for this host under
//                                       `ssh-password:<alias>`. The helper reads
//                                       it (without deleting — it is reused
//                                       across runs).
//
// When `ssh` needs the password it execs this helper, which inherits that
// environment. The password therefore never appears in `ssh`'s argv or
// environment; only the opaque run id / the (validated) alias does. See
// `docs/plans/ssh-remote-password-transient-keychain.md` (Phase 1) and
// `docs/plans/ssh-remote-password-keychain-implementation-plan.md` (Phase 2).
//
// Source priority: one-shot first, then persistent. A run never sets both, but
// if it did the one-shot (transient, just-entered) value wins — it is the more
// specific intent for this single run.
//
// Contract enforced here:
//   - stdout carries ONLY the password, with a single trailing newline (the
//     conventional askpass reply shape; `ssh` strips one trailing newline).
//   - On ANY failure (no source env, nothing stored, unsafe alias, keychain
//     error) we print NOTHING to stdout and exit non-zero, so `ssh` falls
//     through to the next auth method / fails rather than authenticating with
//     garbage or leaking an error string as the "password".
//   - We never log the password or its length.
//
// This binary is gated behind the `ssh-askpass` Cargo feature (see Cargo.toml
// `[[bin]]` `required-features`), built only via `npm run build:askpass` on
// Unix. Remote password auth is Unix-only (Win32-OpenSSH's SSH_ASKPASS handling
// is unreliable); the `#[cfg(not(unix))]` arm below is a defensive no-op stub
// in case the feature is ever enabled on a non-Unix target — it always fails so
// nothing is ever returned to ssh.

/// Environment variable carrying the run id whose parked one-shot password to
/// fetch. Set by the executor on the spawned `ssh` child; inherited here.
const RUN_ID_ENV: &str = "PROCMIX_ASKPASS_RUN_ID";

/// Environment variable carrying the host alias whose persistent password to
/// fetch. Set by the executor on the spawned `ssh` child; inherited here.
const ALIAS_ENV: &str = "PROCMIX_ASKPASS_ALIAS";

/// Resolve the password from whichever source env var is set, one-shot first.
///
/// Returns `Ok(Some(pw))` to answer the prompt, `Ok(None)` when no source is
/// configured or nothing is stored (ssh should move on), and `Err(())` on a
/// keychain backend failure. The caller treats both `Ok(None)` and `Err` as
/// "print nothing, exit non-zero" — but they are distinguished so the logic
/// stays unit-testable without a real keychain.
///
/// Kept free of any I/O so it can be reasoned about; the secret is returned by
/// value and written exactly once by `main`.
#[cfg(unix)]
fn resolve_password(run_id: Option<String>, alias: Option<String>) -> Result<Option<String>, ()> {
    // One-shot takes priority: it is the transient, just-entered secret for
    // this specific run. `take` reads AND deletes so it never outlives the run.
    if let Some(run_id) = run_id.filter(|s| !s.is_empty()) {
        return procmix_lib::security::ssh_oneshot::take(&run_id).map_err(|_| ());
    }
    // Persistent fallback: read the saved per-host password. `get` validates
    // the alias with `is_safe_alias` internally and does NOT delete it (it is
    // reused across runs).
    if let Some(alias) = alias.filter(|s| !s.is_empty()) {
        return procmix_lib::security::ssh_password::get(&alias).map_err(|_| ());
    }
    // No source configured — not our invocation, or a contract violation.
    Ok(None)
}

#[cfg(unix)]
fn main() {
    use std::io::Write;

    // `ssh` also passes its prompt text as argv[1], which we deliberately
    // ignore: the password source is selected purely by the env vars.
    let run_id = std::env::var(RUN_ID_ENV).ok();
    let alias = std::env::var(ALIAS_ENV).ok();

    let password = match resolve_password(run_id, alias) {
        Ok(Some(pw)) => pw,
        // Nothing to return (no source, nothing stored, or backend error) —
        // print nothing and fail so ssh does not authenticate with garbage and
        // no error string is ever read as the password.
        Ok(None) | Err(()) => std::process::exit(1),
    };

    // Write the password verbatim followed by a single newline — the
    // conventional askpass reply shape. Never log the value.
    let mut out = std::io::stdout().lock();
    if out.write_all(password.as_bytes()).is_err() || out.write_all(b"\n").is_err() {
        std::process::exit(1);
    }
    let _ = out.flush();
    std::process::exit(0);
}

#[cfg(not(unix))]
fn main() {
    // Remote password auth is Unix-only; this helper is never wired up on
    // Windows. Compile to a stub that always fails so the binary still builds
    // as part of the workspace.
    let _ = (RUN_ID_ENV, ALIAS_ENV);
    std::process::exit(1);
}

#[cfg(all(unix, test))]
mod tests {
    use super::*;

    /// No source env at all → `Ok(None)`, so `main` prints nothing and exits
    /// non-zero (ssh moves on). Guards against a refactor that defaults to
    /// answering with an empty/garbage password.
    #[test]
    fn no_source_resolves_to_none() {
        assert_eq!(resolve_password(None, None), Ok(None));
    }

    /// Empty strings are treated as absent for BOTH sources — an empty run id
    /// or alias must not address a keychain entry. With both empty the result
    /// is the no-source case.
    #[test]
    fn empty_source_values_are_treated_as_absent() {
        assert_eq!(
            resolve_password(Some(String::new()), Some(String::new())),
            Ok(None)
        );
    }

    /// With only the persistent alias set (and nothing stored in the test mock
    /// keychain), the helper resolves to `Ok(None)` rather than erroring — a
    /// host with no saved password simply falls through to key auth. (The mock
    /// `keyring` backend reports `NoEntry`, which `ssh_password::get` maps to
    /// `Ok(None)`; a real saved password is exercised in manual QA, per the
    /// module note.)
    #[test]
    fn persistent_alias_with_no_stored_password_is_none() {
        assert_eq!(resolve_password(None, Some("prod".to_string())), Ok(None));
    }
}
