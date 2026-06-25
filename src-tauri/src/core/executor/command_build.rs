// Command construction for the execution engine.
//
// Maps a logical shell name to its native invocation, builds the argv for
// the elevated Unix (`sudo -S`) and Windows (`Start-Process -Verb RunAs`)
// paths, and assembles the final `tokio::process::Command` — including the
// working-directory validation, env overrides, stdio wiring, and the Unix
// `setsid()` pre_exec that puts the child in its own process group.
//
// The `libc` shim (`setsid`/`killpg`/`getpgid`) lives here and is exposed
// `pub(crate)` so the waiter (`super::waiter`) can issue the group kill and
// the kill-path tests can drive it directly.

use std::path::PathBuf;
use std::process::Stdio;

use tokio::process::Command;

use crate::core::parser::ResolvedScript;
use crate::core::proc_ext::NoConsoleWindow;
use crate::core::ssh::is_safe_alias;

use super::types::{
    ExecuteRequest, ExecutionTarget, ERR_INVALID_REMOTE_TARGET, ERR_INVALID_WORKING_DIR,
    ERR_REMOTE_ELEVATION_UNSUPPORTED, ERR_REMOTE_TARGET_UNRESOLVED,
    ERR_SSH_PASSWORD_BACKEND_PREFIX,
};

/// How a remote run authenticates, which changes the `ssh` argv + environment.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum RemoteAuth {
    /// Keys / agent / `~/.ssh/config`. `BatchMode=yes` forbids every prompt so
    /// a non-interactive host fails fast. The default for a remote run.
    Keys,
    /// Password via the `SSH_ASKPASS` helper. `BatchMode` is dropped (it would
    /// suppress askpass); a single password prompt is allowed. Unix only.
    Password,
}

/// Where the askpass helper should read the password from, when password auth
/// is selected (Unix only). Determines which env var the executor sets on the
/// `ssh` child and whether it parks a one-shot secret beforehand.
#[cfg(unix)]
#[derive(Clone, PartialEq, Eq, Debug)]
enum PasswordSource {
    /// A one-shot password supplied with THIS run (`req.ssh_password`). Parked
    /// in a throwaway keychain entry keyed by the run id before spawn; the
    /// helper reads it via `PROCMIX_ASKPASS_RUN_ID` and deletes it.
    OneShot,
    /// A password saved persistently for the host (`security::ssh_password`,
    /// account `ssh-password:<alias>`). Nothing is parked; the helper reads it
    /// via `PROCMIX_ASKPASS_ALIAS` and leaves it in place for reuse.
    Persistent,
}

/// TCP connect budget handed to `ssh` via `-o ConnectTimeout` for a remote
/// run. Mirrors the reachability probe's budget (`core::ssh::check`). The
/// executor's own optional `timeout_seconds` is the wall-clock backstop for
/// the whole run; this only bounds the initial connect so an unreachable host
/// fails fast instead of hanging the spawn.
const REMOTE_CONNECT_TIMEOUT_SECS: u64 = 8;

/// Map a logical shell name to the (executable, prefix-arguments) pair.
///
/// The caller appends the user's script as the final argument. Each variant
/// here maps to a *native* invocation — no aliasing between shells:
///   - "bash"       -> bash -c <script>
///   - "zsh"        -> zsh -c <script>
///   - "sh"         -> sh -c <script>
///   - "fish"       -> fish -c <script>
///   - "pwsh"       -> pwsh -NoProfile -Command <script>   (PowerShell Core)
///   - "powershell" -> powershell -NoProfile -Command <script>   (Windows PS 5.1)
///   - "cmd"        -> cmd /C <script>
///
/// Unknown shells fall back to `bash -c <script>` as a defensive default
/// (the TypeScript `Shell` union should prevent this in practice).
///
/// `-NoProfile` on PowerShell avoids loading the user's profile, which can
/// add noticeable startup latency and unexpected output for scripted use.
pub(super) fn shell_invocation(shell: &str) -> (&'static str, &'static [&'static str]) {
    match shell {
        "cmd" => ("cmd", &["/C"]),
        "pwsh" => ("pwsh", &["-NoProfile", "-Command"]),
        "powershell" => ("powershell", &["-NoProfile", "-Command"]),
        "fish" => ("fish", &["-c"]),
        "zsh" => ("zsh", &["-c"]),
        "sh" => ("sh", &["-c"]),
        "bash" => ("bash", &["-c"]),
        _ => ("bash", &["-c"]),
    }
}

pub(super) fn default_shell() -> &'static str {
    if cfg!(windows) {
        "powershell"
    } else {
        "bash"
    }
}

/// Map a logical shell name to the (executable, prefix-arguments) pair used on
/// the REMOTE host.
///
/// The OS of a remote host is unknown (it is not recorded in `~/.ssh/config`),
/// so we assume POSIX — the overwhelmingly common SSH case. A command's
/// declared shell is honoured when it is POSIX-invokable:
///   - "bash" / "zsh" / "sh" / "fish" -> `<shell> -c <script>`
///   - "pwsh"                          -> `pwsh -NoProfile -Command <script>`
///
/// Windows-only shells (`cmd`, `powershell`) cannot be assumed to exist on a
/// POSIX host, so they fall back to `sh -c`. An unknown shell also falls back
/// to `sh` (the most portable choice for a remote target — `bash` may be
/// absent on minimal hosts, but `sh` is mandated by POSIX). The form surfaces
/// this so the user is not surprised on a Windows-SSH target.
pub(super) fn remote_shell_invocation(shell: &str) -> (&'static str, &'static [&'static str]) {
    match shell {
        "pwsh" => ("pwsh", &["-NoProfile", "-Command"]),
        "fish" => ("fish", &["-c"]),
        "zsh" => ("zsh", &["-c"]),
        "bash" => ("bash", &["-c"]),
        "sh" => ("sh", &["-c"]),
        // `cmd` / `powershell` (Windows-only) and any unknown value fall back to
        // the portable POSIX `sh`.
        _ => ("sh", &["-c"]),
    }
}

/// Build the argv for a REMOTE run over the system `ssh` binary.
///
/// Shape (key auth):
/// ```text
/// ssh -o BatchMode=yes -o ConnectTimeout=<N> -o StrictHostKeyChecking=accept-new
///     -o ConnectionAttempts=1 <alias> -- <remote_shell> <prefix...> <script> [extra...]
/// ```
///
/// For [`RemoteAuth::Password`] the leading `BatchMode=yes` is replaced with
/// `NumberOfPasswordPrompts=1`: `BatchMode` suppresses the `SSH_ASKPASS`
/// helper, so it must be off, but we still allow only a SINGLE password prompt
/// so a wrong password fails fast instead of retrying. The askpass env vars are
/// set on the `Command` by the caller, not here.
///
/// Invariants (locked by unit tests):
///   - `ssh` is spawned directly; there is NO local shell, so the script body
///     is never interpreted locally.
///   - `alias` is a single standalone token (validated by `is_safe_alias`
///     before this is called), never concatenated with a flag.
///   - `--` separates ssh's own options/destination from the remote command,
///     so a remote shell name starting with `-` can't be misread as an ssh
///     option.
///   - `script` is exactly ONE argv element. `ssh` re-quotes each remote
///     argument as a single token when it builds the command line sent to the
///     server, so the remote shell receives the script verbatim — exactly one
///     remote interpretation, no local one.
///   - key auth carries `BatchMode=yes` (never blocks on a prompt); password
///     auth carries `NumberOfPasswordPrompts=1` (exactly one attempt).
///
/// Pure `Vec<String>` so tests assert the exact shape without spawning.
fn build_remote_argv(
    alias: &str,
    auth: RemoteAuth,
    remote_shell_program: &str,
    remote_shell_prefix: &[&str],
    script: &str,
    extra_args: &[String],
) -> Vec<String> {
    // First option pair depends on auth: keys forbid every prompt; password
    // allows exactly one (BatchMode would suppress the askpass helper).
    let (first_opt, first_val): (&str, String) = match auth {
        RemoteAuth::Keys => ("-o", "BatchMode=yes".to_string()),
        RemoteAuth::Password => ("-o", "NumberOfPasswordPrompts=1".to_string()),
    };
    let mut argv: Vec<String> = vec![
        first_opt.into(),
        first_val,
        "-o".into(),
        format!("ConnectTimeout={REMOTE_CONNECT_TIMEOUT_SECS}"),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "-o".into(),
        "ConnectionAttempts=1".into(),
    ];
    // Password auth: force the password method and stop offering public keys.
    // Without this, a host with several keys in the agent/`~/.ssh/` offers each
    // one first and the server cuts the connection with "Too many authentication
    // failures" (its MaxAuthTries) before password auth is ever reached. Go
    // straight to the prompt our askpass helper answers.
    if auth == RemoteAuth::Password {
        argv.push("-o".into());
        argv.push("PubkeyAuthentication=no".into());
        argv.push("-o".into());
        argv.push("IdentitiesOnly=yes".into());
        argv.push("-o".into());
        argv.push("PreferredAuthentications=password,keyboard-interactive".into());
    }
    argv.extend([
        // Destination alias: a single standalone token. Validated upstream by
        // is_safe_alias (no leading '-', no shell metacharacters).
        alias.to_string(),
        // End ssh's options + destination; everything after is the remote
        // command, forwarded to the server.
        "--".into(),
        remote_shell_program.to_string(),
    ]);
    for prefix in remote_shell_prefix {
        argv.push((*prefix).to_string());
    }
    // The script is a SINGLE argv element — ssh quotes it as one token when it
    // assembles the remote command line, so the remote shell sees it verbatim.
    argv.push(script.to_string());
    for a in extra_args {
        argv.push(a.clone());
    }
    argv
}

/// Resolve the absolute path to the `procmix-askpass` sidecar.
///
/// Checked in order:
///   1. `resource_candidate` — the bundled location, resolved by the caller
///      from the Tauri `PathResolver` (`BaseDirectory::Resource`). In an
///      installed app the helper ships via `bundle.resources`, which lands in
///      the platform resource dir (macOS `Contents/Resources`, Linux
///      `/usr/lib/<app>`), NOT next to the executable — so this must be tried.
///   2. `current_exe()`-sibling — the dev/`cargo build` layout, where both
///      binaries sit in `target/<profile>/`. Also covers any packager that
///      happens to co-locate them.
///
/// Returns an error string when neither exists, so the caller fails the run
/// with a clear message instead of spawning `ssh` with a broken `SSH_ASKPASS`.
#[cfg(unix)]
pub(crate) fn askpass_helper_path(
    resource_candidate: Option<&std::path::Path>,
) -> Result<PathBuf, String> {
    // 1. Bundled resource location (when the caller could resolve one).
    if let Some(cand) = resource_candidate {
        if cand.is_file() {
            return Ok(cand.to_path_buf());
        }
    }
    // 2. Sibling of the current executable (dev / co-located packaging).
    let exe = std::env::current_exe()
        .map_err(|e| format!("cannot locate the askpass helper (current_exe): {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "cannot locate the askpass helper (no parent dir)".to_string())?;
    let helper = dir.join("procmix-askpass");
    if helper.is_file() {
        return Ok(helper);
    }
    Err(format!(
        "askpass helper not found (resource: {:?}, sibling: {})",
        resource_candidate,
        helper.display()
    ))
}

/// PowerShell-safe single-quoted string escape.
///
/// PowerShell uses doubled single-quote (`''`) as the literal escape
/// inside single-quoted strings, just like SQL. This keeps user
/// scripts containing apostrophes (`don't run this`) intact when we
/// embed them into a `Start-Process` argument list. Used by the
/// Windows elevated path; surface kept testable.
#[cfg(any(windows, test))]
fn ps_single_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// Build the argv passed to `powershell.exe` to launch an elevated
/// process on Windows.
///
/// The shape is:
///   powershell -NoProfile -ExecutionPolicy Bypass -Command
///       Start-Process -FilePath '<shell>' -ArgumentList <args>
///                     -Verb RunAs -Wait [-WorkingDirectory '<dir>']
///
/// `-Verb RunAs` triggers the OS-native UAC dialog. No password is
/// stored or transmitted from this app; the OS handles authentication.
/// `-Wait` blocks the wrapper PowerShell process until the elevated
/// child exits, so our outer waiter task can observe the exit code via
/// the wrapper. stdout/stderr of the elevated process are NOT captured
/// — they belong to a different security context. This is documented
/// in the UI hint (S11) so users aren't surprised.
///
/// `working_dir` is forwarded via `Start-Process -WorkingDirectory`;
/// env overrides are not, because `Start-Process` has no portable way
/// to set them on the elevated child (the new token has its own env).
/// Callers that need env should bake values into the script body.
///
/// Pure helper for testability — does not spawn or touch the OS.
#[cfg(any(windows, test))]
fn build_elevated_windows_argv(
    shell_program: &str,
    shell_prefix_args: &[&str],
    script: &str,
    extra_args: &[String],
    working_dir: Option<&str>,
) -> Vec<String> {
    // Assemble the ArgumentList that PowerShell hands to the elevated
    // shell. Each element is single-quoted (with PS escaping) and the
    // resulting array literal is interpolated into one -Command string.
    let mut arglist_parts: Vec<String> = Vec::new();
    for prefix in shell_prefix_args {
        arglist_parts.push(ps_single_quote(prefix));
    }
    arglist_parts.push(ps_single_quote(script));
    for a in extra_args {
        arglist_parts.push(ps_single_quote(a));
    }
    let arglist = arglist_parts.join(",");

    let mut cmd_parts: Vec<String> = vec![
        "Start-Process".to_string(),
        "-FilePath".to_string(),
        ps_single_quote(shell_program),
    ];
    if !arglist.is_empty() {
        cmd_parts.push("-ArgumentList".to_string());
        cmd_parts.push(arglist);
    }
    cmd_parts.push("-Verb".to_string());
    cmd_parts.push("RunAs".to_string());
    cmd_parts.push("-Wait".to_string());
    if let Some(wd) = working_dir {
        cmd_parts.push("-WorkingDirectory".to_string());
        cmd_parts.push(ps_single_quote(wd));
    }
    let ps_command = cmd_parts.join(" ");

    vec![
        "powershell".to_string(),
        "-NoProfile".to_string(),
        "-ExecutionPolicy".to_string(),
        "Bypass".to_string(),
        "-Command".to_string(),
        ps_command,
    ]
}

/// Build the argv (program + args) for an elevated Unix invocation.
///
/// On Unix we prepend `sudo -S` (read password from stdin) followed by
/// the shell + its native -c/-Command flag, then the script, then any
/// caller-supplied trailing args. `-p ''` silences sudo's prompt so
/// nothing prints to stderr while sudo waits for the password — we'd
/// otherwise leak that prompt into the live-output stream and confuse
/// users.
///
/// `-S` makes sudo read the password from stdin and ends after a single
/// newline; we close stdin immediately after writing the password, so
/// the child script itself never sees stdin (matching the non-elevated
/// path's `Stdio::null()` behavior from the script's point of view).
///
/// When `preserve_env` is true we add `-E` so sudo doesn't strip the
/// caller's environment overrides. This is opt-in because the host's
/// sudoers config may reject env preservation; non-overridden runs
/// don't need it.
///
/// Returned as a pure `Vec<String>` so unit tests can assert the exact
/// shape without ever calling `Command::spawn`.
///
/// Gated to Unix (and test builds) so it isn't dead code on Windows, where
/// elevation goes through the UAC wrapper instead — mirrors the
/// `#[cfg(any(windows, test))]` on `build_elevated_windows_argv`.
#[cfg(any(unix, test))]
fn build_elevated_unix_argv(
    shell_program: &str,
    shell_prefix_args: &[&str],
    script: &str,
    extra_args: &[String],
    preserve_env: bool,
) -> Vec<String> {
    // `-p ''` silences sudo's prompt so nothing leaks into the live
    // output stream. `-E` is opt-in env-preservation (only when the
    // caller passes env overrides). `--` ends sudo's option list so a
    // future shell name starting with `-` can't be misread.
    let mut argv: Vec<String> = vec![
        "sudo".to_string(),
        "-S".to_string(),
        "-p".to_string(),
        String::new(),
    ];
    if preserve_env {
        argv.push("-E".to_string());
    }
    argv.push("--".to_string());
    argv.push(shell_program.to_string());
    for prefix in shell_prefix_args {
        argv.push((*prefix).to_string());
    }
    argv.push(script.to_string());
    for a in extra_args {
        argv.push(a.clone());
    }
    argv
}

/// Build the `tokio::process::Command` for a run.
///
/// Three branches:
///
///   - non-elevated: `<shell> <prefix_args> <script> [extra...]`
///     (unchanged from before the elevation feature).
///   - elevated on Unix: prepend `sudo -S [-E] -- ` + the same
///     invocation, with stdin switched from Null to Piped so the caller
///     can hand sudo the password.
///   - elevated on Windows: wrap with `powershell -Command
///     Start-Process -Verb RunAs -Wait …` which triggers UAC. The
///     wrapper's stdout/stderr are empty (the real child runs in a
///     different security context); we only observe its exit code.
///
/// Also resolves and validates the working directory BEFORE spawn (M3),
/// applies env overrides, wires stdout/stderr to pipes, sets stdin per
/// platform/elevation, and on Unix installs the `setsid()` pre_exec so
/// the child becomes a session leader (own process group) for tree kill.
/// `askpass_resource_path` is the bundled `procmix-askpass` location resolved
/// by the caller from the Tauri `PathResolver` (Resource base dir). It is only
/// consulted on the remote password-auth path; pass `None` when there is no
/// resolver (tests) or it could not be resolved — the resolver then falls back
/// to the `current_exe()`-sibling layout.
pub(super) fn build_command(
    program: &str,
    prefix_args: &[&str],
    resolved: &ResolvedScript,
    req: &ExecuteRequest,
    global_env: &std::collections::BTreeMap<String, String>,
    #[cfg_attr(not(unix), allow(unused_variables))] askpass_resource_path: Option<&std::path::Path>,
) -> Result<Command, String> {
    let extra_args: Vec<String> = resolved.args.clone();

    // ------------------------------------------------------------------
    // Remote branch (SSH). Handled first and returns early: a remote run
    // shares none of the local working-dir validation, env application, or
    // sudo/UAC elevation below. It spawns the system `ssh` binary directly
    // (no local shell) with a fixed argv.
    // ------------------------------------------------------------------
    match &req.target {
        ExecutionTarget::Local => { /* fall through to the local build below */ }
        ExecutionTarget::RemotePrompt => {
            // The frontend must resolve a "choose host at run time" target into
            // a concrete Remote before invoking. Reaching the spawn path with it
            // unresolved is a contract violation, not something we can run.
            return Err(ERR_REMOTE_TARGET_UNRESOLVED.to_string());
        }
        ExecutionTarget::Remote { alias } => {
            // Local sudo/UAC does not map onto a remote host; reject rather than
            // silently dropping the user's elevation request.
            if req.elevated {
                return Err(ERR_REMOTE_ELEVATION_UNSUPPORTED.to_string());
            }
            // The alias is the only user-derived value reaching the local argv.
            // Validate it with the SAME allow-list the reachability probe uses
            // (no leading '-', no shell metacharacters) BEFORE it is spawned.
            if !is_safe_alias(alias) {
                return Err(format!("{ERR_INVALID_REMOTE_TARGET}{alias}"));
            }

            // Decide the auth path + (on Unix) where the password comes from.
            //
            // Password auth (via the SSH_ASKPASS helper) is selected when EITHER
            //   (a) a one-shot password was supplied with this run
            //       (`req.ssh_password`, blank treated as absent), OR
            //   (b) the host has a password saved persistently
            //       (`security::ssh_password::has(alias)`).
            // One-shot takes priority: it is the just-entered intent for this
            // run. Both are Unix only — on Windows the askpass transport is
            // unreliable, so we ignore any password and always use key auth.
            #[cfg(unix)]
            let password_source: Option<PasswordSource> = {
                let one_shot = req
                    .ssh_password
                    .as_deref()
                    .map(|s| !s.trim().is_empty())
                    .unwrap_or(false);
                if one_shot {
                    Some(PasswordSource::OneShot)
                } else if crate::security::ssh_password::has(alias).unwrap_or(false) {
                    // A keychain read failure here is treated as "no saved
                    // password" (fall back to keys) rather than aborting: an
                    // unavailable keychain shouldn't block a key-auth host. A
                    // genuinely password-only host will then fail fast on the
                    // key path, which is the correct, visible outcome.
                    Some(PasswordSource::Persistent)
                } else {
                    None
                }
            };
            #[cfg(unix)]
            let auth = if password_source.is_some() {
                RemoteAuth::Password
            } else {
                RemoteAuth::Keys
            };
            #[cfg(not(unix))]
            let auth = RemoteAuth::Keys;

            // The command's declared shell is the LOCAL logical name; map it to
            // a POSIX remote invocation (falling back to `sh`). `program` here
            // is the local shell program we'd have used; we re-derive the remote
            // shell from its name so `sh`/`bash`/… stay consistent.
            let (remote_program, remote_prefix) = remote_shell_invocation(program);
            let argv = build_remote_argv(
                alias,
                auth,
                remote_program,
                remote_prefix,
                &resolved.script,
                &extra_args,
            );

            let mut c = Command::new("ssh");
            c.args(&argv);
            // English ssh diagnostics regardless of the user's locale, matching
            // the reachability probe so surfaced messages stay stable.
            c.env("LC_ALL", "C");
            // Windows: spawn ssh.exe without flashing a console window (no-op
            // elsewhere). See `core::proc_ext`.
            c.no_console_window();
            c.stdout(Stdio::piped()).stderr(Stdio::piped());
            // No stdin: the remote script must not block waiting on input it
            // cannot receive. Password auth is delivered via SSH_ASKPASS (a
            // separate helper process), NOT stdin, so this holds for both auth
            // paths.
            c.stdin(Stdio::null());

            // Password auth (Unix): point `ssh` at the askpass helper and tell
            // it which keychain source to read. The password itself NEVER enters
            // `ssh`'s argv or env — only an opaque run id (one-shot) or the
            // already-validated alias (persistent) does. The helper reads the
            // secret in-process and pipes it to `ssh` on demand.
            #[cfg(unix)]
            if let Some(source) = password_source {
                let helper = askpass_helper_path(askpass_resource_path)
                    .map_err(|e| format!("{ERR_SSH_PASSWORD_BACKEND_PREFIX}{e}"))?;

                match source {
                    PasswordSource::OneShot => {
                        // The run id is the execution id. `mod.rs` sets it on
                        // `req` before calling us, so it is always present for a
                        // remote run; guard anyway rather than park a bogus key.
                        let run_id = req
                            .execution_id
                            .as_deref()
                            .filter(|s| !s.is_empty())
                            .ok_or_else(|| {
                                format!(
                                    "{ERR_SSH_PASSWORD_BACKEND_PREFIX}missing run id for password auth"
                                )
                            })?;
                        let password = req
                            .ssh_password
                            .as_deref()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .expect("OneShot source implies a non-blank ssh_password");

                        // Park the secret BEFORE setting env, so a keychain
                        // failure aborts the run without ever spawning `ssh`.
                        crate::security::ssh_oneshot::put(run_id, password)
                            .map_err(|e| format!("{ERR_SSH_PASSWORD_BACKEND_PREFIX}{e}"))?;
                        c.env("PROCMIX_ASKPASS_RUN_ID", run_id);
                    }
                    PasswordSource::Persistent => {
                        // Nothing to park: the password already lives under
                        // `ssh-password:<alias>`. The helper reads it by alias
                        // (re-validated by `is_safe_alias` inside `get`) and
                        // leaves it in place for reuse across runs. The alias is
                        // already `is_safe_alias`-validated above.
                        c.env("PROCMIX_ASKPASS_ALIAS", alias);
                    }
                }

                c.env("SSH_ASKPASS", &helper);
                // OpenSSH >= 8.4: call askpass even though a TTY may be present
                // /absent; combined with stdin=null + setsid (no controlling
                // TTY) this reliably routes the prompt to our helper.
                c.env("SSH_ASKPASS_REQUIRE", "force");
                // DISPLAY is required by some older OpenSSH builds before they
                // will invoke askpass at all; set a dummy value so the helper is
                // reached even on a headless box. Harmless when unused.
                c.env("DISPLAY", ":0");
            }

            // NOTE (limitations, see docs/ssh-remote-execution.md):
            //   - `working_dir` is intentionally NOT applied — it would refer to
            //     a path on THIS machine, not the remote host.
            //   - `env` (per-command and global .env) is intentionally NOT
            //     forwarded — ssh does not propagate env without server-side
            //     SendEnv/AcceptEnv config.
            // Both are surfaced as hints in the command form.
            let _ = global_env;

            // On Unix, put the LOCAL ssh process in its own group so cancel /
            // timeout can kill it (closing the channel). The remote process is
            // best-effort — killing ssh closes the connection but a detached
            // remote process may outlive it (no PTY in this version).
            #[cfg(unix)]
            unsafe {
                c.pre_exec(|| {
                    let _ = libc_setsid();
                    Ok(())
                });
            }

            return Ok(c);
        }
    }

    // Only the Unix `sudo -E` path (and the no-elevation-support fallback)
    // reads this; the Windows UAC wrapper does not, where it would be unused.
    // `-E` (preserve env) matters when EITHER the command declares env OR a
    // registered global .env file contributes a variable.
    #[cfg(not(windows))]
    let preserve_env = !resolved.env.is_empty() || !global_env.is_empty();

    // ------------------------------------------------------------------
    // Build the Command. Three branches:
    //
    //   - non-elevated: `<shell> <prefix_args> <script> [extra...]`
    //     (unchanged from before this feature).
    //   - elevated on Unix: prepend `sudo -S [-E] -- ` + the same
    //     invocation, with stdin switched from Null to Piped so we can
    //     hand sudo the password.
    //   - elevated on Windows: wrap with `powershell -Command
    //     Start-Process -Verb RunAs -Wait …` which triggers UAC. The
    //     wrapper's stdout/stderr are empty (the real child runs in a
    //     different security context); we only observe its exit code.
    // ------------------------------------------------------------------
    let mut cmd = if req.elevated {
        #[cfg(unix)]
        {
            let argv = build_elevated_unix_argv(
                program,
                prefix_args,
                &resolved.script,
                &extra_args,
                preserve_env,
            );
            // argv[0] is "sudo"; the rest are the wrapped invocation.
            let mut c = Command::new(&argv[0]);
            for a in &argv[1..] {
                c.arg(a);
            }
            c
        }
        #[cfg(windows)]
        {
            let wd_str = resolved.working_dir.clone();
            let argv = build_elevated_windows_argv(
                program,
                prefix_args,
                &resolved.script,
                &extra_args,
                wd_str.as_deref(),
            );
            // argv[0] is "powershell"; the rest is the -Command block.
            let mut c = Command::new(&argv[0]);
            for a in &argv[1..] {
                c.arg(a);
            }
            c
        }
        #[cfg(not(any(unix, windows)))]
        {
            // No supported elevation path on this target — reject
            // explicitly rather than silently downgrading.
            let _ = (program, prefix_args, &extra_args, preserve_env);
            return Err("elevated execution is not supported on this platform".to_string());
        }
    } else {
        let mut c = Command::new(program);
        for prefix in prefix_args {
            c.arg(prefix);
        }
        c.arg(&resolved.script);
        for a in &extra_args {
            c.arg(a);
        }
        c
    };

    // M3: resolve and validate the working directory BEFORE spawn.
    //
    // The cwd is user-trusted (the user picks where their own command runs),
    // so this is robustness, not a privilege boundary: a non-existent dir would
    // otherwise surface as an opaque `spawn()` failure. When the command
    // specifies a `working_dir`, it MUST resolve to an existing directory — we
    // fail fast with the `ERR_INVALID_WORKING_DIR` sentinel so the UI can show
    // a precise message. When it specifies none, we fall back to the user's
    // home directory (an absent home is non-fatal: the child inherits this
    // process's cwd, the historical behaviour).
    match resolved.working_dir.as_ref() {
        Some(dir) => {
            let wd = PathBuf::from(dir);
            if !wd.is_dir() {
                return Err(format!("{ERR_INVALID_WORKING_DIR}{dir}"));
            }
            cmd.current_dir(wd);
        }
        None => {
            if let Some(home) = dirs::home_dir() {
                cmd.current_dir(home);
            }
        }
    }

    // Env precedence (lowest → highest):
    //   1. inherited process environment (already on `cmd`)
    //   2. registered global .env files (`global_env`)
    //   3. per-command env (`resolved.env`) — always wins on key collision
    // Applied in that order so a later `cmd.env` overrides an earlier one.
    for (k, v) in global_env {
        cmd.env(k, v);
    }
    if !resolved.env.is_empty() {
        for (k, v) in &resolved.env {
            cmd.env(k, v);
        }
    }

    // Windows: suppress the console window the spawned shell (cmd.exe /
    // powershell.exe) or the UAC wrapper powershell would otherwise flash.
    // No-op on Unix (sudo / bash etc. inherit no console there). See
    // `core::proc_ext`.
    cmd.no_console_window();

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    // Only the Unix elevated path needs a piped stdin (to hand sudo
    // the password). On Windows the UAC wrapper has nothing to read;
    // non-elevated runs explicitly null stdin so the script can't
    // hang waiting on input it has no way to receive.
    #[cfg(unix)]
    {
        if req.elevated {
            cmd.stdin(Stdio::piped());
        } else {
            cmd.stdin(Stdio::null());
        }
    }
    #[cfg(not(unix))]
    {
        cmd.stdin(Stdio::null());
    }

    // On Unix, put the child in its own process group so we can kill the
    // whole tree (e.g., a shell + its children) on cancellation.
    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| {
            // Detach from parent's process group; failure is non-fatal —
            // kill() on the direct child still works without a new pgrp.
            let _ = libc_setsid();
            Ok(())
        });
    }

    Ok(cmd)
}

// --- libc shim ---------------------------------------------------------
// We avoid pulling in the `libc` crate by declaring the few symbols we
// need on Unix. `setsid` returns the new session id (== pid) or -1.
// `killpg` sends a signal to every process in the named process group;
// the kernel ignores the sign on the pgid argument, so we pass it
// positive. `getpgid(pid)` returns the pgid of `pid` or -1; we use it to
// confirm that `setsid()` succeeded before issuing a killpg (otherwise
// killpg with the wrong group could target unrelated processes).
#[cfg(unix)]
extern "C" {
    fn setsid() -> i32;
    fn killpg(pgrp: i32, sig: i32) -> i32;
    fn getpgid(pid: i32) -> i32;
}

#[cfg(unix)]
pub(crate) const SIGTERM: i32 = 15;
#[cfg(unix)]
pub(crate) const SIGKILL: i32 = 9;

#[cfg(unix)]
#[inline]
pub(crate) unsafe fn libc_setsid() -> i32 {
    setsid()
}

#[cfg(unix)]
#[inline]
pub(crate) fn libc_killpg(pgid: i32, sig: i32) -> i32 {
    // SAFETY: killpg is a syscall wrapper with no memory side effects;
    // the only constraint is that `pgid > 0`. Callers ensure this by
    // only calling after `getpgid` returned a positive value.
    unsafe { killpg(pgid, sig) }
}

#[cfg(unix)]
#[inline]
pub(crate) fn libc_getpgid(pid: i32) -> i32 {
    // SAFETY: getpgid has no memory side effects; -1 is a valid error
    // sentinel and callers handle it.
    unsafe { getpgid(pid) }
}

#[cfg(test)]
mod shell_invocation_tests {
    use super::shell_invocation;

    #[test]
    fn bash_maps_to_bash_dash_c() {
        let (exe, args) = shell_invocation("bash");
        assert_eq!(exe, "bash");
        assert_eq!(args, &["-c"]);
    }

    #[test]
    fn zsh_maps_to_zsh_dash_c() {
        let (exe, args) = shell_invocation("zsh");
        assert_eq!(exe, "zsh");
        assert_eq!(args, &["-c"]);
    }

    #[test]
    fn sh_maps_natively_not_to_bash() {
        let (exe, args) = shell_invocation("sh");
        assert_eq!(exe, "sh", "sh must spawn /bin/sh, not bash");
        assert_eq!(args, &["-c"]);
    }

    #[test]
    fn fish_maps_to_fish_dash_c() {
        let (exe, args) = shell_invocation("fish");
        assert_eq!(exe, "fish");
        assert_eq!(args, &["-c"]);
    }

    #[test]
    fn pwsh_maps_with_noprofile_and_command() {
        let (exe, args) = shell_invocation("pwsh");
        assert_eq!(exe, "pwsh");
        assert_eq!(args, &["-NoProfile", "-Command"]);
    }

    #[test]
    fn powershell_maps_natively_not_to_pwsh() {
        let (exe, args) = shell_invocation("powershell");
        assert_eq!(
            exe, "powershell",
            "powershell must spawn the Windows PS 5.1 binary, not pwsh"
        );
        assert_eq!(args, &["-NoProfile", "-Command"]);
    }

    #[test]
    fn cmd_maps_to_cmd_slash_c() {
        let (exe, args) = shell_invocation("cmd");
        assert_eq!(exe, "cmd");
        assert_eq!(args, &["/C"]);
    }

    #[test]
    fn unknown_shell_falls_back_to_bash() {
        let (exe, args) = shell_invocation("nushell-not-in-union");
        assert_eq!(exe, "bash");
        assert_eq!(args, &["-c"]);
    }

    /// Regression: `sh` and `powershell` used to alias to `bash` and `pwsh`
    /// respectively. Lock that fix in so a future refactor cannot silently
    /// reintroduce the aliasing.
    #[test]
    fn sh_and_powershell_are_not_aliased() {
        let (sh_exe, _) = shell_invocation("sh");
        let (bash_exe, _) = shell_invocation("bash");
        assert_ne!(sh_exe, bash_exe, "sh must not alias to bash");

        let (powershell_exe, _) = shell_invocation("powershell");
        let (pwsh_exe, _) = shell_invocation("pwsh");
        assert_ne!(
            powershell_exe, pwsh_exe,
            "powershell must not alias to pwsh"
        );
    }
}

#[cfg(test)]
mod elevated_argv_tests {
    use super::build_elevated_unix_argv;

    /// Baseline shape: `sudo -S -p '' -- bash -c <script>`. The
    /// `-p ''` and `--` come BEFORE the wrapped shell. Test asserts
    /// the exact slice so any future flag reorder is caught.
    #[test]
    fn bash_script_without_extras_or_env() {
        let argv = build_elevated_unix_argv("bash", &["-c"], "echo hi", &[], false);
        assert_eq!(
            argv,
            vec![
                "sudo".to_string(),
                "-S".to_string(),
                "-p".to_string(),
                String::new(),
                "--".to_string(),
                "bash".to_string(),
                "-c".to_string(),
                "echo hi".to_string(),
            ]
        );
    }

    /// `-E` is inserted only when the caller asked us to preserve env
    /// (i.e. they passed env overrides). Placed BEFORE `--` because
    /// it's a sudo flag, not part of the wrapped invocation.
    #[test]
    fn preserve_env_inserts_dash_e_before_double_dash() {
        let argv = build_elevated_unix_argv("bash", &["-c"], "echo hi", &[], true);
        let dash_e_pos = argv.iter().position(|s| s == "-E").expect("-E present");
        let dash_dash_pos = argv.iter().position(|s| s == "--").expect("-- present");
        assert!(dash_e_pos < dash_dash_pos, "-E must come before --");
    }

    /// Trailing extras are appended AFTER the script, preserving the
    /// non-elevated path's positional contract. Important: they go
    /// past the `--`, where sudo correctly forwards them to the wrapped
    /// shell rather than interpreting them as more sudo options.
    #[test]
    fn extra_args_are_appended_after_the_script() {
        let argv = build_elevated_unix_argv(
            "bash",
            &["-c"],
            "run",
            &["one".to_string(), "two".to_string()],
            false,
        );
        let script_pos = argv
            .iter()
            .position(|s| s == "run")
            .expect("script must be present");
        assert_eq!(argv[script_pos + 1], "one");
        assert_eq!(argv[script_pos + 2], "two");
    }

    /// PowerShell-style prefix args (multiple tokens before the
    /// script) survive the wrap unchanged — important because pwsh
    /// uses `-NoProfile -Command`, not a single flag.
    #[test]
    fn multi_token_shell_prefix_is_preserved_in_order() {
        let argv = build_elevated_unix_argv(
            "pwsh",
            &["-NoProfile", "-Command"],
            "Get-Process",
            &[],
            false,
        );
        // After "--" we expect: pwsh, -NoProfile, -Command, Get-Process
        let dd = argv.iter().position(|s| s == "--").unwrap();
        assert_eq!(argv[dd + 1], "pwsh");
        assert_eq!(argv[dd + 2], "-NoProfile");
        assert_eq!(argv[dd + 3], "-Command");
        assert_eq!(argv[dd + 4], "Get-Process");
    }

    /// Regression: the script is passed as a SINGLE argument to sudo,
    /// not split on whitespace. A naive implementation that joined
    /// argv with spaces and re-split on a shell would let the user's
    /// script body inject extra arguments.
    #[test]
    fn script_with_spaces_stays_a_single_argv_element() {
        let script = "echo hello world && uname -a";
        let argv = build_elevated_unix_argv("bash", &["-c"], script, &[], false);
        assert_eq!(
            argv.iter().filter(|s| s.as_str() == script).count(),
            1,
            "script must appear verbatim as one argv element"
        );
    }
}

#[cfg(test)]
mod elevated_windows_argv_tests {
    use super::{build_elevated_windows_argv, ps_single_quote};

    /// Baseline shape: powershell wrapper invokes `Start-Process` with
    /// `-Verb RunAs -Wait`. The argv we hand to `Command::new` must
    /// be `["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
    /// "-Command", "<single command string>"]`.
    #[test]
    fn pwsh_wrapper_without_working_dir_or_extras() {
        let argv = build_elevated_windows_argv(
            "pwsh",
            &["-NoProfile", "-Command"],
            "Get-Process",
            &[],
            None,
        );
        assert_eq!(argv[0], "powershell");
        assert_eq!(argv[1], "-NoProfile");
        assert_eq!(argv[2], "-ExecutionPolicy");
        assert_eq!(argv[3], "Bypass");
        assert_eq!(argv[4], "-Command");
        // The single -Command string must contain the verb and -Wait.
        let cmd = &argv[5];
        assert!(
            cmd.contains("Start-Process"),
            "missing Start-Process: {cmd}"
        );
        assert!(cmd.contains("-Verb RunAs"), "missing -Verb RunAs: {cmd}");
        assert!(cmd.contains("-Wait"), "missing -Wait: {cmd}");
        // shell program is single-quoted.
        assert!(cmd.contains("'pwsh'"), "shell not quoted: {cmd}");
    }

    /// `-WorkingDirectory` is added only when `working_dir` is Some.
    #[test]
    fn working_dir_is_forwarded_when_present() {
        let argv = build_elevated_windows_argv("cmd", &["/C"], "dir", &[], Some("C:\\Users\\me"));
        let cmd = &argv[5];
        assert!(
            cmd.contains("-WorkingDirectory 'C:\\Users\\me'"),
            "expected -WorkingDirectory in: {cmd}"
        );
    }

    /// `-WorkingDirectory` is OMITTED entirely when working_dir is
    /// None — `Start-Process` then uses the parent's CWD, which is
    /// the same default as the non-elevated path.
    #[test]
    fn working_dir_is_absent_when_none() {
        let argv = build_elevated_windows_argv("cmd", &["/C"], "dir", &[], None);
        let cmd = &argv[5];
        assert!(
            !cmd.contains("-WorkingDirectory"),
            "should not include -WorkingDirectory: {cmd}"
        );
    }

    /// Single quotes inside the script body must be doubled to escape
    /// them — otherwise the elevated child would see a truncated or
    /// rejected command. This protects scripts like
    /// `echo can't break this`.
    #[test]
    fn apostrophe_in_script_is_pwsh_escaped() {
        let argv = build_elevated_windows_argv("cmd", &["/C"], "echo can't break this", &[], None);
        let cmd = &argv[5];
        assert!(
            cmd.contains("'echo can''t break this'"),
            "apostrophe must be doubled in PS escape: {cmd}"
        );
    }

    /// Extra args appear in the -ArgumentList, comma-separated and
    /// each independently single-quoted.
    #[test]
    fn extra_args_are_appended_to_argument_list() {
        let argv = build_elevated_windows_argv(
            "cmd",
            &["/C"],
            "echo",
            &["one".to_string(), "two".to_string()],
            None,
        );
        let cmd = &argv[5];
        assert!(
            cmd.contains("-ArgumentList '/C','echo','one','two'"),
            "expected comma-separated ArgumentList: {cmd}"
        );
    }

    /// Unit test for the escape helper directly. Strings without any
    /// apostrophe pass through as `'foo'`; strings with one become
    /// `'foo''bar'`.
    #[test]
    fn ps_single_quote_handles_plain_and_apostrophe() {
        assert_eq!(ps_single_quote("foo"), "'foo'");
        assert_eq!(ps_single_quote("foo'bar"), "'foo''bar'");
        assert_eq!(ps_single_quote(""), "''");
    }
}

#[cfg(test)]
mod remote_shell_invocation_tests {
    use super::remote_shell_invocation;

    #[test]
    fn posix_shells_map_natively() {
        assert_eq!(remote_shell_invocation("bash"), ("bash", &["-c"][..]));
        assert_eq!(remote_shell_invocation("zsh"), ("zsh", &["-c"][..]));
        assert_eq!(remote_shell_invocation("sh"), ("sh", &["-c"][..]));
        assert_eq!(remote_shell_invocation("fish"), ("fish", &["-c"][..]));
    }

    #[test]
    fn pwsh_maps_with_noprofile_command() {
        assert_eq!(
            remote_shell_invocation("pwsh"),
            ("pwsh", &["-NoProfile", "-Command"][..])
        );
    }

    /// Windows-only shells can't be assumed on a POSIX remote host, so they
    /// fall back to `sh -c` rather than failing the run.
    #[test]
    fn windows_shells_fall_back_to_sh() {
        assert_eq!(remote_shell_invocation("cmd"), ("sh", &["-c"][..]));
        assert_eq!(remote_shell_invocation("powershell"), ("sh", &["-c"][..]));
    }

    /// Unknown shells fall back to the portable POSIX `sh` (NOT `bash`, which
    /// the local fallback uses — a minimal remote host may lack bash).
    #[test]
    fn unknown_shell_falls_back_to_sh_not_bash() {
        let (exe, args) = remote_shell_invocation("nushell-not-in-union");
        assert_eq!(exe, "sh", "remote fallback must be sh, not bash");
        assert_eq!(args, &["-c"]);
    }
}

#[cfg(test)]
mod remote_argv_tests {
    use super::{build_remote_argv, RemoteAuth};

    /// Baseline shape: the alias is a standalone token, `--` separates ssh
    /// options from the remote command, and the remote shell + script follow.
    #[test]
    fn baseline_bash_shape() {
        let argv = build_remote_argv("prod", RemoteAuth::Keys, "bash", &["-c"], "uptime", &[]);
        let dd = argv.iter().position(|s| s == "--").expect("-- present");
        // Alias appears exactly once, immediately before `--`.
        assert_eq!(argv[dd - 1], "prod");
        assert_eq!(argv[dd + 1], "bash");
        assert_eq!(argv[dd + 2], "-c");
        assert_eq!(argv[dd + 3], "uptime");
    }

    /// Key auth: BatchMode, ConnectTimeout and StrictHostKeyChecking must all be
    /// present so a remote spawn never blocks on an interactive prompt.
    #[test]
    fn carries_batchmode_and_connect_timeout() {
        let argv = build_remote_argv("h", RemoteAuth::Keys, "sh", &["-c"], "echo hi", &[]);
        assert!(argv.iter().any(|a| a == "BatchMode=yes"));
        assert!(argv.iter().any(|a| a.starts_with("ConnectTimeout=")));
        assert!(argv.iter().any(|a| a == "StrictHostKeyChecking=accept-new"));
        assert!(argv.iter().any(|a| a == "--"), "must end options with --");
    }

    /// Password auth: `BatchMode=yes` must NOT be present (it would suppress the
    /// askpass helper); `NumberOfPasswordPrompts=1` replaces it so a wrong
    /// password fails after a single attempt.
    #[test]
    fn password_auth_drops_batchmode_and_limits_prompts() {
        let argv = build_remote_argv("h", RemoteAuth::Password, "sh", &["-c"], "echo hi", &[]);
        assert!(
            !argv.iter().any(|a| a == "BatchMode=yes"),
            "BatchMode must be off for password auth (it suppresses askpass)"
        );
        assert!(
            argv.iter().any(|a| a == "NumberOfPasswordPrompts=1"),
            "password auth must cap prompts at 1"
        );
        // The rest of the contract is unchanged.
        assert!(argv.iter().any(|a| a.starts_with("ConnectTimeout=")));
        assert!(argv.iter().any(|a| a == "--"));
    }

    /// Password auth must disable pubkey and prefer the password method so a
    /// multi-key host does not exhaust the server's MaxAuthTries with key offers
    /// ("Too many authentication failures") before password auth is reached.
    /// Key auth must NOT carry these (it relies on keys/agent).
    #[test]
    fn password_auth_disables_pubkey_and_prefers_password() {
        let pw = build_remote_argv("h", RemoteAuth::Password, "sh", &["-c"], "x", &[]);
        assert!(pw.iter().any(|a| a == "PubkeyAuthentication=no"), "{pw:?}");
        assert!(pw.iter().any(|a| a == "IdentitiesOnly=yes"), "{pw:?}");
        assert!(
            pw.iter()
                .any(|a| a == "PreferredAuthentications=password,keyboard-interactive"),
            "{pw:?}"
        );

        let keys = build_remote_argv("h", RemoteAuth::Keys, "sh", &["-c"], "x", &[]);
        assert!(!keys.iter().any(|a| a == "PubkeyAuthentication=no"));
        assert!(!keys
            .iter()
            .any(|a| a.starts_with("PreferredAuthentications=")));
    }

    /// The alias must be a single standalone token, never concatenated with an
    /// option flag — the core injection guard. Holds for both auth paths.
    #[test]
    fn alias_is_a_standalone_token() {
        for auth in [RemoteAuth::Keys, RemoteAuth::Password] {
            let argv = build_remote_argv("db-1", auth, "sh", &["-c"], "x", &[]);
            assert_eq!(
                argv.iter().filter(|s| s.as_str() == "db-1").count(),
                1,
                "alias must appear once as its own token ({auth:?})"
            );
            // No element merges the alias into a flag (e.g. `-odb-1`).
            assert!(argv.iter().all(|s| !s.contains("db-1") || s == "db-1"));
        }
    }

    /// Regression mirror of the local path: the script body is ONE argv
    /// element. ssh re-quotes it as a single token, so the remote shell sees
    /// it verbatim — no local interpretation, exactly one remote one.
    #[test]
    fn script_with_spaces_stays_a_single_argv_element() {
        let script = "echo hello world && uname -a";
        let argv = build_remote_argv("h", RemoteAuth::Keys, "bash", &["-c"], script, &[]);
        assert_eq!(
            argv.iter().filter(|s| s.as_str() == script).count(),
            1,
            "script must appear verbatim as one argv element"
        );
    }

    /// Trailing extra args are appended AFTER the script, past the remote
    /// shell — matching the local positional contract.
    #[test]
    fn extra_args_follow_the_script() {
        let argv = build_remote_argv(
            "h",
            RemoteAuth::Keys,
            "sh",
            &["-c"],
            "run",
            &["one".to_string(), "two".to_string()],
        );
        let pos = argv
            .iter()
            .position(|s| s == "run")
            .expect("script present");
        assert_eq!(argv[pos + 1], "one");
        assert_eq!(argv[pos + 2], "two");
    }

    /// A multi-token remote prefix (pwsh) survives in order after `--`.
    #[test]
    fn pwsh_prefix_preserved_after_double_dash() {
        let argv = build_remote_argv(
            "h",
            RemoteAuth::Keys,
            "pwsh",
            &["-NoProfile", "-Command"],
            "Get-Process",
            &[],
        );
        let dd = argv.iter().position(|s| s == "--").unwrap();
        assert_eq!(argv[dd + 1], "pwsh");
        assert_eq!(argv[dd + 2], "-NoProfile");
        assert_eq!(argv[dd + 3], "-Command");
        assert_eq!(argv[dd + 4], "Get-Process");
    }
}

#[cfg(all(test, unix))]
mod askpass_path_tests {
    use super::askpass_helper_path;

    /// When the bundled resource candidate IS a real file, the resolver returns
    /// it verbatim — without falling through to the `current_exe()` sibling.
    /// (We use this very test binary as a stand-in "existing file".)
    #[test]
    fn prefers_existing_resource_candidate() {
        let me = std::env::current_exe().unwrap();
        let got = askpass_helper_path(Some(&me)).expect("resource candidate should resolve");
        assert_eq!(got, me);
    }

    /// A non-existent resource candidate is skipped; the resolver falls through
    /// to the sibling check. In the test harness the sibling
    /// `procmix-askpass` doesn't exist next to the test binary, so we get the
    /// clear "not found" error naming BOTH probed locations.
    #[test]
    fn missing_everywhere_errors_with_both_locations() {
        let bogus = std::path::Path::new("/nonexistent/procmix-askpass-xyz");
        let err = askpass_helper_path(Some(bogus)).expect_err("nothing should resolve");
        assert!(err.contains("askpass helper not found"), "got: {err}");
        // The error mentions the resource candidate we tried.
        assert!(err.contains("procmix-askpass-xyz"), "got: {err}");
    }

    /// `None` resource candidate skips straight to the sibling probe (the dev
    /// path). Here that also fails (no sibling helper in the test dir), but the
    /// error must still be the clear not-found message.
    #[test]
    fn none_candidate_falls_back_to_sibling() {
        let err = askpass_helper_path(None).expect_err("no sibling in test dir");
        assert!(err.contains("askpass helper not found"), "got: {err}");
    }
}

#[cfg(test)]
mod build_command_remote_tests {
    use super::*;
    use crate::core::parser::ResolvedScript;
    use std::collections::BTreeMap;

    fn resolved(script: &str) -> ResolvedScript {
        ResolvedScript {
            script: script.to_string(),
            args: Vec::new(),
            env: BTreeMap::new(),
            working_dir: None,
        }
    }

    fn remote_request(alias: &str, elevated: bool) -> ExecuteRequest {
        let mut req: ExecuteRequest =
            serde_json::from_value(serde_json::json!({ "script": "ignored" })).unwrap();
        req.target = ExecutionTarget::Remote {
            alias: alias.to_string(),
        };
        req.elevated = elevated;
        req
    }

    /// A valid remote target builds an `ssh` command (program == "ssh"), not a
    /// local shell — proving there is no local interpretation layer.
    #[test]
    fn remote_target_spawns_ssh_not_local_shell() {
        let req = remote_request("prod", false);
        let cmd = build_command(
            "bash",
            &["-c"],
            &resolved("uptime"),
            &req,
            &BTreeMap::new(),
            None,
        )
        .expect("remote build ok");
        let program = cmd.as_std().get_program().to_string_lossy().to_string();
        assert_eq!(program, "ssh");
    }

    /// A remote run with NO password uses key auth — the argv carries
    /// `BatchMode=yes` and there is no `SSH_ASKPASS` env. (The password path is
    /// exercised at the `build_remote_argv` level since it requires a real
    /// keychain + the bundled helper, neither present in a unit test.)
    #[test]
    fn remote_without_password_uses_key_auth_argv() {
        let req = remote_request("prod", false);
        let cmd = build_command(
            "bash",
            &["-c"],
            &resolved("uptime"),
            &req,
            &BTreeMap::new(),
            None,
        )
        .expect("remote build ok");
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(
            args.iter().any(|a| a == "BatchMode=yes"),
            "key-auth remote must carry BatchMode=yes: {args:?}"
        );
        // No askpass env on the key path — neither the helper pointer nor
        // EITHER password-source selector (one-shot run id or persistent alias).
        for k in [
            "SSH_ASKPASS",
            "PROCMIX_ASKPASS_RUN_ID",
            "PROCMIX_ASKPASS_ALIAS",
        ] {
            let present = cmd
                .as_std()
                .get_envs()
                .any(|(key, _)| key == std::ffi::OsStr::new(k));
            assert!(!present, "key-auth remote must not set {k}");
        }
    }

    /// An unsafe alias (leading '-', option injection) is rejected before any
    /// spawn, with the pinned sentinel + the offending alias.
    #[test]
    fn unsafe_alias_is_rejected() {
        for bad in ["-oProxyCommand=evil", "a b", "host;rm", "h$(x)", "*"] {
            let req = remote_request(bad, false);
            let err = build_command(
                "bash",
                &["-c"],
                &resolved("x"),
                &req,
                &BTreeMap::new(),
                None,
            )
            .expect_err("must reject unsafe alias");
            assert!(
                err.starts_with(ERR_INVALID_REMOTE_TARGET),
                "expected invalid-target sentinel for {bad:?}, got {err}"
            );
        }
    }

    /// Remote + elevation is unsupported in this version; reject with the
    /// pinned sentinel rather than silently dropping elevation.
    #[test]
    fn remote_with_elevation_is_rejected() {
        let req = remote_request("prod", true);
        let err = build_command(
            "bash",
            &["-c"],
            &resolved("x"),
            &req,
            &BTreeMap::new(),
            None,
        )
        .expect_err("must reject remote elevation");
        assert_eq!(err, ERR_REMOTE_ELEVATION_UNSUPPORTED);
    }

    /// An unresolved `RemotePrompt` reaching the spawn path is a frontend
    /// contract violation; reject with the pinned sentinel.
    #[test]
    fn remote_prompt_is_rejected_as_unresolved() {
        let mut req: ExecuteRequest =
            serde_json::from_value(serde_json::json!({ "script": "x" })).unwrap();
        req.target = ExecutionTarget::RemotePrompt;
        let err = build_command(
            "bash",
            &["-c"],
            &resolved("x"),
            &req,
            &BTreeMap::new(),
            None,
        )
        .expect_err("must reject unresolved prompt");
        assert_eq!(err, ERR_REMOTE_TARGET_UNRESOLVED);
    }

    /// A remote run does NOT validate `working_dir` against the LOCAL fs — a
    /// path that doesn't exist locally must not fail the build (it refers to
    /// the remote host). This is the visible contract of "ignore working_dir".
    #[test]
    fn remote_ignores_local_working_dir_validation() {
        let mut r = resolved("ls");
        r.working_dir = Some("/definitely/not/a/local/dir/xyz".to_string());
        let req = remote_request("prod", false);
        // Must succeed despite the nonexistent local dir.
        build_command("bash", &["-c"], &r, &req, &BTreeMap::new(), None)
            .expect("remote must ignore local working_dir");
    }

    /// A Windows-only declared shell is downgraded to `sh` on the remote host
    /// (the argv carries `sh`, never `cmd`).
    #[test]
    fn remote_downgrades_cmd_to_sh() {
        let req = remote_request("prod", false);
        let cmd = build_command(
            "cmd",
            &["/C"],
            &resolved("dir"),
            &req,
            &BTreeMap::new(),
            None,
        )
        .expect("remote build ok");
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(
            args.iter().any(|a| a == "sh"),
            "expected sh in argv: {args:?}"
        );
        assert!(
            !args.iter().any(|a| a == "cmd"),
            "cmd must not reach remote argv"
        );
    }
}
