//! Pure builders for the `sftp` invocation: the fixed argv and the batch
//! script fed on stdin.
//!
//! Splitting these out (no spawn, no IO) makes the exact wire shape — argv
//! token boundaries and batch-line quoting — unit-testable, which is where the
//! security-relevant invariants live.
//!
//! ## Why a batch script
//!
//! `sftp` runs non-interactive operations from a *batch file* (`-b <file>`, or
//! `-b -` to read the script from stdin). Each line is one `sftp` command
//! (`ls`, `get`, `put`, `rm`, `rmdir`, `rename`, `mkdir`). We feed exactly one
//! command per spawn on stdin, so a remote path becomes a token inside a
//! single batch line — it never reaches a local shell, and it never reaches
//! `sftp`'s argv (which carries only fixed flags and the validated alias).
//!
//! ## Quoting
//!
//! `sftp`'s batch parser splits a line on unquoted whitespace and honours
//! double quotes, with backslash escaping inside them (OpenSSH `sftp` uses the
//! same quoting rules as its interactive line editor). [`quote_sftp_token`]
//! wraps a path in double quotes and backslash-escapes `"` and `\`, so a path
//! containing spaces or quotes stays a single token. [`is_safe_remote_path`]
//! (called by the client before building) has already rejected NUL and control
//! characters, so a newline can never smuggle a second batch line.

use super::types::is_safe_remote_path;

/// TCP connect budget handed to `sftp` via `-o ConnectTimeout`. Seconds.
/// Matches the SSH probe/exec timeout so behaviour is consistent.
const SFTP_CONNECT_TIMEOUT_SECS: u64 = 8;

/// How `sftp` should authenticate, mirroring the SSH executor's two branches.
///
/// The option strings are SSH protocol facts (shared verbatim with
/// `ssh`/`scp`), not executor logic, so they live here with the SFTP
/// transport rather than coupling this module to the executor internals.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SftpAuth {
    /// Keys / SSH agent. `BatchMode=yes` forbids every interactive prompt, so
    /// the child never blocks; a host needing a password fails fast.
    Keys,
    /// Password via the `procmix-askpass` helper (Unix-only). `BatchMode`
    /// would suppress the helper, so it is OFF; exactly one prompt is allowed
    /// so a wrong password fails fast instead of retrying.
    Password,
}

impl SftpAuth {
    /// The leading `-o key=value` option pair selecting prompt behaviour.
    fn first_option(self) -> (&'static str, &'static str) {
        match self {
            SftpAuth::Keys => ("-o", "BatchMode=yes"),
            SftpAuth::Password => ("-o", "NumberOfPasswordPrompts=1"),
        }
    }
}

/// One non-interactive SFTP operation, rendered into a single batch line.
///
/// Path fields are remote paths; the client validates each with
/// [`is_safe_remote_path`] before constructing an op. `Get`/`Put` carry both a
/// remote and a LOCAL path — the local path is also quoted as one token (it
/// never reaches a shell either).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SftpOp {
    /// `ls -l <dir>` — long listing of a directory.
    List { dir: String },
    /// `get <remote> <local>` — download.
    Get { remote: String, local: String },
    /// `put <local> <remote>` — upload.
    Put { local: String, remote: String },
    /// `rm <path>` — delete a file.
    RemoveFile { path: String },
    /// `rmdir <path>` — delete an (empty) directory.
    RemoveDir { path: String },
    /// `rename <from> <to>` — move/rename on the remote.
    Rename { from: String, to: String },
    /// `mkdir <path>` — create a directory.
    Mkdir { path: String },
}

/// Quote `token` as a single `sftp` batch token: wrap in double quotes and
/// backslash-escape `\` and `"`. Safe because the caller has already rejected
/// NUL/control chars via [`is_safe_remote_path`].
fn quote_sftp_token(token: &str) -> String {
    let mut out = String::with_capacity(token.len() + 2);
    out.push('"');
    for ch in token.chars() {
        if ch == '\\' || ch == '"' {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('"');
    out
}

/// Render one op into its `sftp` batch line (no trailing newline).
///
/// Returns `None` if any path fails [`is_safe_remote_path`] — a defensive
/// second check so a batch line can never be built from an unvalidated path
/// even if a caller forgot to validate.
pub fn render_batch_line(op: &SftpOp) -> Option<String> {
    let q = quote_sftp_token;
    let line = match op {
        SftpOp::List { dir } => {
            if !is_safe_remote_path(dir) {
                return None;
            }
            // Resolve the directory to an ABSOLUTE path and list it. `cd` makes
            // the subsequent `pwd` print the canonical absolute directory (so a
            // relative input like "." or ".." becomes e.g. "/home/user"), and a
            // bare `ls -la` then lists that new working directory. The client
            // parses the `Remote working directory: <abs>` line from `pwd` to
            // set the pane's cwd to a clean absolute path — without this the
            // pane's cwd would be the literal input ("."), which breaks "go up"
            // and path joins. Three commands, one per line.
            //
            // `-a` includes hidden entries (dotfiles) to match the LOCAL pane,
            // which lists them too (`std::fs::read_dir` yields dotfiles). The
            // `.`/`..` self/parent rows that `-a` adds are dropped by the
            // client's `parse_ls_long`, so only real hidden entries are shown.
            format!("cd {dir}\npwd\nls -la", dir = q(dir))
        }
        SftpOp::Get { remote, local } => {
            if !is_safe_remote_path(remote) || !is_safe_remote_path(local) {
                return None;
            }
            format!("get {} {}", q(remote), q(local))
        }
        SftpOp::Put { local, remote } => {
            if !is_safe_remote_path(local) || !is_safe_remote_path(remote) {
                return None;
            }
            format!("put {} {}", q(local), q(remote))
        }
        SftpOp::RemoveFile { path } => {
            if !is_safe_remote_path(path) {
                return None;
            }
            format!("rm {}", q(path))
        }
        SftpOp::RemoveDir { path } => {
            if !is_safe_remote_path(path) {
                return None;
            }
            format!("rmdir {}", q(path))
        }
        SftpOp::Rename { from, to } => {
            if !is_safe_remote_path(from) || !is_safe_remote_path(to) {
                return None;
            }
            format!("rename {} {}", q(from), q(to))
        }
        SftpOp::Mkdir { path } => {
            if !is_safe_remote_path(path) {
                return None;
            }
            format!("mkdir {}", q(path))
        }
    };
    Some(line)
}

/// Build the full batch script (one op per spawn → one line + newline) to feed
/// `sftp` on stdin. `None` if the op contains an unsafe path.
pub fn build_batch_script(op: &SftpOp) -> Option<String> {
    render_batch_line(op).map(|line| format!("{line}\n"))
}

/// Build the fixed `sftp` argv. In BOTH auth modes the batch script is fed on
/// the child's **stdin**, so no remote path is ever on the argv.
///
/// Shape (key auth):
/// ```text
/// sftp -o BatchMode=yes -o ConnectTimeout=<N> -o StrictHostKeyChecking=accept-new
///      -o ConnectionAttempts=1 -b - <alias>
/// ```
///
/// Shape (password auth) — note the ABSENCE of `-b`:
/// ```text
/// sftp -o NumberOfPasswordPrompts=1 -o ConnectTimeout=<N>
///      -o StrictHostKeyChecking=accept-new -o ConnectionAttempts=1 <alias>
/// ```
///
/// ## Why password auth must NOT use `-b`
///
/// OpenSSH's `sftp -b` implies `BatchMode=yes`, which disables ALL interactive
/// authentication — including the `SSH_ASKPASS` password prompt. With `-b` set,
/// a password host can never be answered by our askpass helper and fails with
/// `Permission denied` even though a correct password is saved. So for password
/// auth we omit `-b` entirely and instead let `sftp` read its commands from a
/// non-TTY stdin (it does this automatically when stdin is not a terminal), the
/// caller still pipes exactly the same batch script. Key auth keeps `-b -`
/// because `BatchMode=yes` is desirable there (fail fast, never prompt).
///
/// Invariants (locked by unit tests):
///   - `sftp` is spawned directly; there is NO local shell.
///   - `alias` is a single standalone token (validated by `is_safe_alias`
///     before this is called), placed LAST so a value starting with `-` could
///     not be reparsed as an option (and `is_safe_alias` already forbids that).
///   - the batch script is fed on stdin (via `-b -` for keys, via plain stdin
///     for password), so no remote path is ever on the argv.
///   - key auth carries `BatchMode=yes`; password auth carries
///     `NumberOfPasswordPrompts=1`. The askpass env vars are set on the
///     `Command` by the caller, not here.
pub fn build_sftp_argv(alias: &str, auth: SftpAuth) -> Vec<String> {
    let (first_opt, first_val) = auth.first_option();
    let mut argv: Vec<String> = vec![
        first_opt.into(),
        first_val.into(),
        "-o".into(),
        format!("ConnectTimeout={SFTP_CONNECT_TIMEOUT_SECS}"),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "-o".into(),
        "ConnectionAttempts=1".into(),
    ];
    // Password auth: force the password method and DON'T offer any public keys.
    // A host with several keys in the agent/`~/.ssh/` would otherwise offer each
    // one first, and the server cuts the connection with "Too many authentication
    // failures" (its MaxAuthTries) BEFORE password auth is reached. These options
    // make `sftp` go straight to the password prompt our askpass helper answers:
    //   - PubkeyAuthentication=no  — never offer a key (the decisive one).
    //   - IdentitiesOnly=yes       — belt-and-braces: ignore agent-provided keys.
    //   - PreferredAuthentications=password,keyboard-interactive — try password
    //     methods first (keyboard-interactive covers servers that wrap password
    //     auth that way; our single-prompt askpass answers both).
    if auth == SftpAuth::Password {
        argv.push("-o".into());
        argv.push("PubkeyAuthentication=no".into());
        argv.push("-o".into());
        argv.push("IdentitiesOnly=yes".into());
        argv.push("-o".into());
        argv.push("PreferredAuthentications=password,keyboard-interactive".into());
    }
    // Key auth: `-b -` reads the batch from stdin AND enables BatchMode (no
    // prompts). Password auth: omit `-b` so OpenSSH does not force BatchMode
    // (which would suppress the askpass prompt); the script is still piped on
    // stdin, which `sftp` consumes because it is not a TTY.
    if auth == SftpAuth::Keys {
        argv.push("-b".into());
        argv.push("-".into());
    }
    // Destination alias as the final standalone token.
    argv.push(alias.to_string());
    argv
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argv_places_alias_last_and_reads_stdin_batch() {
        let argv = build_sftp_argv("prod", SftpAuth::Keys);
        assert_eq!(argv.last().unwrap(), "prod");
        // -b - must be present so the batch comes from stdin, not argv.
        let b_idx = argv.iter().position(|a| a == "-b").expect("-b present");
        assert_eq!(argv[b_idx + 1], "-");
        assert!(argv.iter().any(|a| a == "BatchMode=yes"));
        assert!(argv.iter().any(|a| a.starts_with("ConnectTimeout=")));
    }

    #[test]
    fn password_auth_swaps_batchmode_for_single_prompt() {
        let argv = build_sftp_argv("h", SftpAuth::Password);
        assert!(argv.iter().any(|a| a == "NumberOfPasswordPrompts=1"));
        assert!(!argv.iter().any(|a| a == "BatchMode=yes"));
    }

    #[test]
    fn password_auth_omits_batch_flag_so_askpass_is_honored() {
        // `sftp -b` forces BatchMode=yes, which suppresses the SSH_ASKPASS
        // password prompt. Password auth must therefore NOT pass `-b`; the
        // batch is fed on a non-TTY stdin instead. Keys keep `-b -`.
        let pw = build_sftp_argv("h", SftpAuth::Password);
        assert!(
            !pw.iter().any(|a| a == "-b"),
            "password argv must not have -b: {pw:?}"
        );
        assert_eq!(pw.last().unwrap(), "h", "alias stays the last token");

        let keys = build_sftp_argv("h", SftpAuth::Keys);
        assert!(keys.iter().any(|a| a == "-b"), "key argv keeps -b");
    }

    #[test]
    fn password_auth_forces_password_and_disables_pubkey() {
        // A multi-key host otherwise exhausts the server's MaxAuthTries with key
        // offers before password is reached ("Too many authentication failures").
        // The password argv must disable pubkey and prefer password methods.
        let pw = build_sftp_argv("h", SftpAuth::Password);
        assert!(pw.iter().any(|a| a == "PubkeyAuthentication=no"), "{pw:?}");
        assert!(pw.iter().any(|a| a == "IdentitiesOnly=yes"), "{pw:?}");
        assert!(
            pw.iter()
                .any(|a| a == "PreferredAuthentications=password,keyboard-interactive"),
            "{pw:?}"
        );

        // Key auth must NOT carry these (it relies on keys/agent).
        let keys = build_sftp_argv("h", SftpAuth::Keys);
        assert!(!keys.iter().any(|a| a == "PubkeyAuthentication=no"));
        assert!(!keys
            .iter()
            .any(|a| a.starts_with("PreferredAuthentications=")));
    }

    #[test]
    fn no_remote_path_ever_lands_on_argv() {
        // The argv is fixed regardless of the op; paths only go on stdin.
        let argv = build_sftp_argv("prod", SftpAuth::Keys);
        assert!(!argv.iter().any(|a| a.contains('/')));
        let argv_pw = build_sftp_argv("prod", SftpAuth::Password);
        assert!(!argv_pw.iter().any(|a| a.contains('/')));
    }

    #[test]
    fn quotes_paths_with_spaces_and_quotes() {
        assert_eq!(quote_sftp_token("/a/b"), "\"/a/b\"");
        assert_eq!(quote_sftp_token("/my dir/file.txt"), "\"/my dir/file.txt\"");
        assert_eq!(
            quote_sftp_token("/weird/it's a \"file\""),
            "\"/weird/it's a \\\"file\\\"\""
        );
        assert_eq!(quote_sftp_token("/back\\slash"), "\"/back\\\\slash\"");
    }

    #[test]
    fn list_resolves_abs_path_then_lists_with_quoted_dir() {
        // List is `cd <dir>; pwd; ls -la` so the client can read the absolute
        // path from `pwd` and list the resolved cwd (including dotfiles). The
        // dir is one quoted token.
        let line = render_batch_line(&SftpOp::List {
            dir: "/var/log app".into(),
        })
        .unwrap();
        assert_eq!(line, "cd \"/var/log app\"\npwd\nls -la");
    }

    #[test]
    fn list_of_dot_resolves_via_cd_pwd() {
        // The initial pane opens on "." (login dir); the batch must `cd "."`
        // then `pwd` so the client can turn it into an absolute home path.
        let line = render_batch_line(&SftpOp::List { dir: ".".into() }).unwrap();
        assert_eq!(line, "cd \".\"\npwd\nls -la");
    }

    #[test]
    fn list_uses_dash_a_to_show_hidden_entries() {
        // `-a` so remote hidden files (dotfiles) are listed like the local pane.
        let line = render_batch_line(&SftpOp::List { dir: "/x".into() }).unwrap();
        assert!(line.contains("ls -la"), "must list hidden entries: {line}");
    }

    #[test]
    fn get_and_put_render_both_paths() {
        let get = render_batch_line(&SftpOp::Get {
            remote: "/r/f".into(),
            local: "/l/f".into(),
        })
        .unwrap();
        assert_eq!(get, "get \"/r/f\" \"/l/f\"");

        let put = render_batch_line(&SftpOp::Put {
            local: "/l/f".into(),
            remote: "/r/f".into(),
        })
        .unwrap();
        assert_eq!(put, "put \"/l/f\" \"/r/f\"");
    }

    #[test]
    fn rename_rm_rmdir_mkdir_render() {
        assert_eq!(
            render_batch_line(&SftpOp::Rename {
                from: "/a".into(),
                to: "/b".into()
            })
            .unwrap(),
            "rename \"/a\" \"/b\""
        );
        assert_eq!(
            render_batch_line(&SftpOp::RemoveFile { path: "/a".into() }).unwrap(),
            "rm \"/a\""
        );
        assert_eq!(
            render_batch_line(&SftpOp::RemoveDir { path: "/a".into() }).unwrap(),
            "rmdir \"/a\""
        );
        assert_eq!(
            render_batch_line(&SftpOp::Mkdir { path: "/a".into() }).unwrap(),
            "mkdir \"/a\""
        );
    }

    #[test]
    fn unsafe_path_yields_no_line() {
        // A newline-bearing path is rejected by is_safe_remote_path, so no
        // batch line can be built from it (defence in depth).
        assert!(render_batch_line(&SftpOp::List {
            dir: "/a\nrm /everything".into()
        })
        .is_none());
        assert!(render_batch_line(&SftpOp::RemoveFile { path: "-rf".into() }).is_none());
    }

    #[test]
    fn batch_script_has_trailing_newline() {
        // A multi-line List script (cd/pwd/ls) still ends with exactly one
        // trailing newline so sftp runs the final command.
        let script = build_batch_script(&SftpOp::List { dir: "/a".into() }).unwrap();
        assert_eq!(script, "cd \"/a\"\npwd\nls -la\n");

        // A single-line op (e.g. mkdir) keeps its one trailing newline too.
        let mk = build_batch_script(&SftpOp::Mkdir { path: "/a".into() }).unwrap();
        assert_eq!(mk, "mkdir \"/a\"\n");
    }
}
