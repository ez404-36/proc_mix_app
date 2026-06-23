// `procmix-askpass` — the SSH_ASKPASS helper for remote password auth.
//
// When ProcMix runs a remote command whose host needs a password, the
// executor (Unix only) parks the one-shot password in a throwaway OS-keychain
// entry keyed by the run id (`security::ssh_oneshot::put`), then spawns `ssh`
// with:
//
//   SSH_ASKPASS=<path to this binary>
//   SSH_ASKPASS_REQUIRE=force
//   PROCMIX_ASKPASS_RUN_ID=<run_id>
//
// and no controlling TTY. When `ssh` needs the password it execs this helper,
// which inherits that environment. The helper reads the run id, takes (reads +
// deletes) the parked password from the keychain, and prints it to stdout —
// which `ssh` reads. The password therefore never appears in `ssh`'s argv or
// environment; only the opaque run id does. See
// `docs/plans/ssh-remote-password-transient-keychain.md`.
//
// Contract enforced here:
//   - stdout carries ONLY the password (no trailing newline beyond what the
//     password contains — `ssh` strips a single trailing newline, so we print
//     the value verbatim with one newline as the conventional askpass reply).
//   - On any failure (no run id, nothing parked, keychain error) we print
//     NOTHING to stdout and exit non-zero, so `ssh` falls through to the next
//     auth method / fails rather than authenticating with garbage.
//   - We never log the password or its length.
//
// This binary is gated behind the `ssh-askpass` Cargo feature (see
// Cargo.toml `[[bin]]` `required-features`), built only via
// `npm run build:askpass` on Unix. Remote password auth is Unix-only
// (Win32-OpenSSH's SSH_ASKPASS handling is unreliable); the `#[cfg(not(unix))]`
// arm below is a defensive no-op stub in case the feature is ever enabled on a
// non-Unix target — it always fails so nothing is ever returned to ssh.

/// Environment variable carrying the run id whose parked password to fetch.
/// Set by the executor on the spawned `ssh` child; inherited by this helper.
const RUN_ID_ENV: &str = "PROCMIX_ASKPASS_RUN_ID";

#[cfg(unix)]
fn main() {
    use std::io::Write;

    // The run id is the only input we need; `ssh` also passes its prompt text
    // as argv[1], which we deliberately ignore.
    let run_id = match std::env::var(RUN_ID_ENV) {
        Ok(s) if !s.is_empty() => s,
        // No run id (or empty) → not our invocation, or a contract violation.
        // Print nothing, fail, so ssh does not authenticate with garbage.
        _ => std::process::exit(1),
    };

    match procmix_lib::security::ssh_oneshot::take(&run_id) {
        Ok(Some(password)) => {
            // Write the password verbatim followed by a single newline — the
            // conventional askpass reply shape. ssh strips one trailing
            // newline. Use stdout directly; never log the value.
            let mut out = std::io::stdout().lock();
            // If the write fails there is nothing useful to report; exit
            // non-zero so ssh treats it as no answer.
            if out.write_all(password.as_bytes()).is_err() || out.write_all(b"\n").is_err() {
                std::process::exit(1);
            }
            let _ = out.flush();
            std::process::exit(0);
        }
        // Nothing parked for this run (key auth already succeeded, or the entry
        // was cleared) — fail quietly so ssh moves on.
        Ok(None) => std::process::exit(1),
        // Keychain backend failure — fail quietly. The error message must not
        // leak to stdout (ssh would read it as the password), so we drop it.
        Err(_) => std::process::exit(1),
    }
}

#[cfg(not(unix))]
fn main() {
    // Remote password auth is Unix-only; this helper is never wired up on
    // Windows. Compile to a stub that always fails so the binary still builds
    // as part of the workspace.
    let _ = RUN_ID_ENV;
    std::process::exit(1);
}
