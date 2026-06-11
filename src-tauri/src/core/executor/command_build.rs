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

use super::types::{ExecuteRequest, ERR_INVALID_WORKING_DIR};

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
pub(super) fn build_command(
    program: &str,
    prefix_args: &[&str],
    resolved: &ResolvedScript,
    req: &ExecuteRequest,
    global_env: &std::collections::BTreeMap<String, String>,
) -> Result<Command, String> {
    let extra_args: Vec<String> = resolved.args.clone();
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
