//! Spawns the system `sftp` binary to run one batch operation, wires the
//! password-auth transport, and parses directory listings.
//!
//! ## Security recap (see `mod.rs` and `docs/ssh-remote-execution.md`)
//!
//! - `sftp` is spawned with a FIXED argv ([`super::batch::build_sftp_argv`]) —
//!   never through a shell. The only user-derived argv value is the alias,
//!   validated by [`is_safe_alias`] before spawn.
//! - The operation (and its remote/local paths) is fed on **stdin** as a
//!   single-line batch script; each path is validated by
//!   [`is_safe_remote_path`] and quoted as one `sftp` token, so it can neither
//!   break out of its line nor reach a local shell.
//! - Password auth (Unix only) reuses the `procmix-askpass` helper exactly as a
//!   remote `ssh` run: the password reaches `sftp` only via the helper's stdout
//!   pipe, never the argv or env. On Windows we always use key/agent auth.
//!   IMPORTANT: the password argv omits `-b` (see [`super::batch::build_sftp_argv`])
//!   because `sftp -b` implies `BatchMode=yes`, which would suppress the askpass
//!   prompt. Without `-b`, `sftp` reads its batch from stdin — but for the
//!   password path that stdin must be a real TEMP FILE, not a pipe: OpenSSH's
//!   `put` produces a 0-byte remote file when its stdin is a pipe (do_upload
//!   requires a regular-file stdin). The temp file is seekable + non-TTY, so
//!   the batch runs non-interactively, `put`/`get` work, and BatchMode stays
//!   off so askpass is honored. Key auth keeps `-b -` on a pipe (fail fast).
//! - `LC_ALL=C` keeps `sftp`/`ls` output stable and English for parsing and so
//!   diagnostics carry no locale-specific surprises.

use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use super::batch::{build_batch_script, build_sftp_argv, SftpAuth, SftpOp};
use super::types::{is_safe_remote_path, SftpEntry, SftpEntryKind, SftpError, SftpListing};
use crate::core::ssh::is_safe_alias;

/// Hard wall-clock budget for a single sftp operation. A transfer of a large
/// file legitimately takes time, so this is generous; it exists only so a hung
/// connection can never stall the IPC handler forever.
const SFTP_OP_TIMEOUT: Duration = Duration::from_secs(120);

/// Resolve the auth mode for `alias`. On Unix, a persistently saved per-host
/// password (`security::ssh_password`) selects the askpass path; otherwise
/// keys/agent. On Windows, always keys (the askpass transport is unreliable).
///
/// A keychain read failure is treated as "no saved password" (fall back to
/// keys) rather than aborting — an unavailable keychain must not block a
/// key-auth host. A genuinely password-only host then fails fast on the key
/// path, which is the correct, visible outcome.
#[cfg(unix)]
fn resolve_auth(alias: &str) -> SftpAuth {
    if crate::security::ssh_password::has(alias).unwrap_or(false) {
        SftpAuth::Password
    } else {
        SftpAuth::Keys
    }
}

#[cfg(not(unix))]
fn resolve_auth(_alias: &str) -> SftpAuth {
    SftpAuth::Keys
}

/// Run a single SFTP operation against `alias`, feeding `op` as a one-line
/// batch script on stdin. Returns the child's captured stdout on success (used
/// by [`list_dir`]; ignored by the mutating ops).
///
/// `askpass_resource_path` is the bundled `procmix-askpass` location resolved
/// by the caller from the Tauri `PathResolver`; `None` falls back to the
/// `current_exe()`-sibling layout (dev/tests).
async fn run_op(
    alias: &str,
    op: &SftpOp,
    askpass_resource_path: Option<&std::path::Path>,
) -> Result<String, SftpError> {
    if !is_safe_alias(alias) {
        return Err(SftpError::InvalidTarget(alias.to_string()));
    }

    // Build the batch script first: this re-validates every path in the op and
    // returns `None` on an unsafe one, so we never spawn for a bad path.
    let script = build_batch_script(op).ok_or_else(|| {
        SftpError::InvalidPath(unsafe_path_of(op).unwrap_or_else(|| "?".to_string()))
    })?;

    let auth = resolve_auth(alias);
    let argv = build_sftp_argv(alias, auth);

    let mut command = Command::new("sftp");
    command
        .args(&argv)
        .env("LC_ALL", "C")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // How the batch script reaches `sftp` depends on the auth mode:
    //
    //   - Key auth uses `-b -`, which reads the batch from stdin in BatchMode.
    //     A pipe is fine here, so we write the script to a piped stdin below.
    //
    //   - Password auth CANNOT use `-b` (it forces BatchMode=yes, suppressing
    //     the askpass prompt). Without `-b`, `sftp` reads commands from stdin —
    //     BUT a `put` whose stdin is a PIPE silently produces a 0-byte remote
    //     file (OpenSSH's do_upload() requires stdin to be a regular file for
    //     its internal handling). So for password auth we put the batch in a
    //     real temp file and hand that file to the child as stdin: it is a
    //     seekable regular file (so `put` works) and not a TTY (so `sftp` runs
    //     the batch non-interactively), while BatchMode stays OFF so askpass is
    //     still honored. The temp file is deleted when `_batch_file` drops.
    let mut _batch_file: Option<tempfile::NamedTempFile> = None;
    let uses_stdin_pipe = auth == SftpAuth::Keys;
    if uses_stdin_pipe {
        command.stdin(Stdio::piped());
    } else {
        let mut tf = tempfile::NamedTempFile::new()
            .map_err(|e| SftpError::Process(format!("failed to create sftp batch file: {e}")))?;
        std::io::Write::write_all(&mut tf, script.as_bytes())
            .map_err(|e| SftpError::Process(format!("failed to write sftp batch file: {e}")))?;
        std::io::Write::flush(&mut tf)
            .map_err(|e| SftpError::Process(format!("failed to flush sftp batch file: {e}")))?;
        let handle = tf
            .reopen()
            .map_err(|e| SftpError::Process(format!("failed to open sftp batch file: {e}")))?;
        command.stdin(Stdio::from(handle));
        _batch_file = Some(tf);
    }

    // Password auth (Unix): point `sftp` at the askpass helper and tell it
    // which keychain account to read via the already-validated alias. The
    // password VALUE never enters the argv or env — only the alias does; the
    // helper reads the secret in-process and pipes it to `sftp` on demand. This
    // mirrors the remote-`ssh` persistent-password path exactly.
    #[cfg(unix)]
    if auth == SftpAuth::Password {
        let helper = crate::core::executor::askpass_helper_path(askpass_resource_path)
            .map_err(SftpError::Process)?;
        command.env("SSH_ASKPASS", &helper);
        command.env("SSH_ASKPASS_REQUIRE", "force");
        command.env("DISPLAY", ":0");
        command.env("PROCMIX_ASKPASS_ALIAS", alias);
        // Own session/process group (no controlling TTY) so askpass is used and
        // a cancel could group-kill the child. Safe: the closure only calls
        // the libc shim.
        unsafe {
            command.pre_exec(|| {
                let _ = crate::core::executor::libc_setsid();
                Ok(())
            });
        }
    }
    #[cfg(not(unix))]
    let _ = askpass_resource_path;

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(SftpError::SftpNotFound);
        }
        Err(e) => return Err(SftpError::Process(format!("failed to start sftp: {e}"))),
    };

    // Key-auth path only: feed the batch on the pipe, then close it (EOF) so
    // `sftp` runs and exits. The password path uses a temp-FILE stdin (set up
    // above), so `child.stdin` is `None` here and this block is skipped.
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(script.as_bytes())
            .await
            .map_err(|e| SftpError::Process(format!("failed to write sftp batch: {e}")))?;
        // Dropping `stdin` closes the pipe (EOF) so sftp proceeds.
    }

    let output = match tokio::time::timeout(SFTP_OP_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(SftpError::Process(format!("sftp wait failed: {e}"))),
        Err(_) => return Err(SftpError::Timeout),
    };

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    if !output.status.success() {
        let trimmed = stderr.trim();
        return Err(SftpError::Remote(if trimmed.is_empty() {
            "sftp exited non-zero".to_string()
        } else {
            trimmed.to_string()
        }));
    }

    // CRITICAL for the password path: without `-b`, `sftp` exits 0 even when a
    // `put`/`get`/`rm`/… fails (remote permission denied, disk full, quota) — it
    // just prints the error and moves on, leaving e.g. a 0-byte file behind. So
    // for MUTATING ops we scan the combined output for OpenSSH error markers and
    // surface them as a real failure instead of a silent partial result. Key
    // auth (`-b`) already exits non-zero, but the scan is harmless there too.
    //
    // A `List` is EXCLUDED: its stdout is the directory listing, and a file
    // could legitimately be named "Failure" or contain an error-like substring,
    // which must not be misread as an op failure.
    if !matches!(op, SftpOp::List { .. }) {
        if let Some(err_line) = first_sftp_error_line(&stdout, &stderr) {
            return Err(SftpError::Remote(err_line));
        }
    }

    Ok(stdout)
}

/// Scan `sftp`'s combined stdout+stderr for a line that indicates a failed
/// operation, returning the first such line. OpenSSH's `sftp` prints transfer
/// and protocol errors as human-readable lines like:
///   - `Couldn't write to remote file "...": Permission denied`
///   - `remote open("..."): Permission denied`
///   - `Cannot download ...` / `Couldn't get handle: ...`
///   - `Permission denied` / `No such file or directory` / `... failed`
///
/// We match a conservative set of markers so a normal `put`/`get` progress line
/// is never misread as an error. Returns `None` when no error marker is found.
fn first_sftp_error_line(stdout: &str, stderr: &str) -> Option<String> {
    const MARKERS: &[&str] = &[
        "Couldn't ",
        "Cannot ",
        "remote open(",
        "Permission denied",
        "No such file or directory",
        "Disk quota exceeded",
        "No space left on device",
        "Failure",
        "not a regular file",
    ];
    stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .find(|line| MARKERS.iter().any(|m| line.contains(m)))
        .map(|l| l.to_string())
}

/// Best-effort: extract the first path from an op for an `InvalidPath` error
/// message when `build_batch_script` rejected it.
fn unsafe_path_of(op: &SftpOp) -> Option<String> {
    let candidates: Vec<&str> = match op {
        SftpOp::List { dir } => vec![dir],
        SftpOp::Get { remote, local } => vec![remote, local],
        SftpOp::Put { local, remote } => vec![local, remote],
        SftpOp::RemoveFile { path } | SftpOp::RemoveDir { path } | SftpOp::Mkdir { path } => {
            vec![path]
        }
        SftpOp::Rename { from, to } => vec![from, to],
    };
    candidates
        .into_iter()
        .find(|p| !is_safe_remote_path(p))
        .map(str::to_string)
}

/// List `dir` on `alias`, parsing `sftp`'s `ls -l` output into entries.
///
/// The batch is `cd <dir>; pwd; ls -l` (see [`super::batch::render_batch_line`]),
/// so the stdout begins with a `Remote working directory: <abs>` line from
/// `pwd`. We parse that to set `listing.path` to the CANONICAL ABSOLUTE path,
/// which is essential: the pane uses `path` as its `cwd` for "go up" and path
/// joins, and a relative input like `.` would otherwise leave `cwd` literally
/// `.`. If `pwd` output is somehow absent we fall back to the input `dir`.
pub async fn list_dir(
    alias: &str,
    dir: &str,
    askpass_resource_path: Option<&std::path::Path>,
) -> Result<SftpListing, SftpError> {
    let stdout = run_op(
        alias,
        &SftpOp::List {
            dir: dir.to_string(),
        },
        askpass_resource_path,
    )
    .await?;
    let path = parse_pwd(&stdout).unwrap_or_else(|| dir.to_string());
    Ok(SftpListing {
        path,
        entries: parse_ls_long(&stdout),
    })
}

/// Parse the absolute directory from `sftp`'s `pwd` output line. OpenSSH prints
/// `Remote working directory: /home/user` (under `LC_ALL=C`). Returns the
/// trimmed absolute path, or `None` if no such line is present (older/unusual
/// builds, or the command failed) so the caller can fall back to the input.
fn parse_pwd(stdout: &str) -> Option<String> {
    const MARKER: &str = "Remote working directory:";
    for line in stdout.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix(MARKER) {
            let path = rest.trim();
            if !path.is_empty() {
                return Some(path.to_string());
            }
        }
    }
    None
}

/// Download a remote file to a local path.
pub async fn download(
    alias: &str,
    remote: &str,
    local: &str,
    askpass_resource_path: Option<&std::path::Path>,
) -> Result<(), SftpError> {
    run_op(
        alias,
        &SftpOp::Get {
            remote: remote.to_string(),
            local: local.to_string(),
        },
        askpass_resource_path,
    )
    .await
    .map(|_| ())
}

/// Upload a local file to a remote path.
pub async fn upload(
    alias: &str,
    local: &str,
    remote: &str,
    askpass_resource_path: Option<&std::path::Path>,
) -> Result<(), SftpError> {
    run_op(
        alias,
        &SftpOp::Put {
            local: local.to_string(),
            remote: remote.to_string(),
        },
        askpass_resource_path,
    )
    .await
    .map(|_| ())
}

/// Delete a remote entry. `is_dir` selects `rmdir` vs `rm`.
pub async fn remove(
    alias: &str,
    path: &str,
    is_dir: bool,
    askpass_resource_path: Option<&std::path::Path>,
) -> Result<(), SftpError> {
    let op = if is_dir {
        SftpOp::RemoveDir {
            path: path.to_string(),
        }
    } else {
        SftpOp::RemoveFile {
            path: path.to_string(),
        }
    };
    run_op(alias, &op, askpass_resource_path).await.map(|_| ())
}

/// Rename/move a remote entry.
pub async fn rename(
    alias: &str,
    from: &str,
    to: &str,
    askpass_resource_path: Option<&std::path::Path>,
) -> Result<(), SftpError> {
    run_op(
        alias,
        &SftpOp::Rename {
            from: from.to_string(),
            to: to.to_string(),
        },
        askpass_resource_path,
    )
    .await
    .map(|_| ())
}

/// Create a remote directory.
pub async fn mkdir(
    alias: &str,
    path: &str,
    askpass_resource_path: Option<&std::path::Path>,
) -> Result<(), SftpError> {
    run_op(
        alias,
        &SftpOp::Mkdir {
            path: path.to_string(),
        },
        askpass_resource_path,
    )
    .await
    .map(|_| ())
}

/// Parse `sftp`'s `ls -l` output (under `LC_ALL=C`) into [`SftpEntry`] rows.
///
/// The format mirrors `ls -l`:
/// ```text
/// drwxr-xr-x    5 user group     4096 Jun 21 10:00 node_modules
/// -rw-r--r--    1 user group      215 Jun 20 09:12 package.json
/// lrwxrwxrwx    1 user group       11 Jun 19 08:00 link -> target
/// ```
///
/// Tolerant by design: a line that doesn't match the expected column layout is
/// SKIPPED rather than failing the whole listing, and `.`/`..` are dropped. The
/// permission char selects the kind (`d`/`l`/else). The name is everything
/// after the 8th whitespace-split field (so names with spaces survive); for a
/// symlink the ` -> target` suffix is stripped.
fn parse_ls_long(stdout: &str) -> Vec<SftpEntry> {
    let mut entries = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            continue;
        }
        // An `sftp` batch echoes the command (`sftp> ls -l …`) on some builds;
        // skip any prompt-prefixed lines defensively.
        if trimmed.starts_with("sftp>") {
            continue;
        }
        if let Some(entry) = parse_ls_line(trimmed) {
            if entry.name != "." && entry.name != ".." {
                entries.push(entry);
            }
        }
    }
    entries
}

/// Iterate `(byte_offset, field)` for each whitespace-separated field in
/// `line`, collapsing runs of whitespace. Like `split_whitespace` but also
/// yields each field's starting byte offset so the caller can slice the tail
/// (the name) from the original line and keep spaces within it.
fn field_indices(line: &str) -> impl Iterator<Item = (usize, &str)> {
    let mut rest = line;
    let mut base = 0usize;
    std::iter::from_fn(move || {
        // Skip leading whitespace.
        let trimmed = rest.trim_start();
        let skipped = rest.len() - trimmed.len();
        base += skipped;
        if trimmed.is_empty() {
            return None;
        }
        // Take up to the next whitespace.
        let end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
        let field = &trimmed[..end];
        let off = base;
        base += end;
        rest = &trimmed[end..];
        Some((off, field))
    })
}

/// Parse a single `ls -l` line. Returns `None` for a line that doesn't look
/// like a long-listing row (e.g. a `total 24` header or noise).
fn parse_ls_line(line: &str) -> Option<SftpEntry> {
    // The 8 metadata columns are whitespace-separated (runs of spaces
    // collapsed); the NAME is everything after the 8th column and may itself
    // contain spaces. `split_whitespace().nth(...)` would discard the spaces
    // inside the name, so instead we record the byte offset of each field via
    // `match_indices`-style iteration and slice the remainder for the name.
    let mut indices = field_indices(line);
    let perms = indices.next()?.1;
    // The first char must be a valid file-type flag for this to be a real row.
    let kind = match perms.chars().next()? {
        'd' => SftpEntryKind::Dir,
        'l' => SftpEntryKind::Symlink,
        '-' => SftpEntryKind::File,
        // Other types (block/char/socket/fifo) are surfaced as files.
        'b' | 'c' | 's' | 'p' => SftpEntryKind::File,
        // Not a recognised mode string → not an ls row (e.g. "total 24").
        _ => return None,
    };
    let _links = indices.next()?.1;
    let _owner = indices.next()?.1;
    let _group = indices.next()?.1;
    let size_field = indices.next()?.1;
    let month = indices.next()?.1;
    let day = indices.next()?.1;
    let (time_off, time_or_year) = indices.next()?;

    // The name is everything after the 8th field, with its leading separator
    // whitespace trimmed — this preserves spaces WITHIN the name.
    let name_field = line[time_off + time_or_year.len()..].trim_start();

    let size = size_field.parse::<u64>().ok();
    let modified = Some(format!("{month} {day} {time_or_year}"));

    // For a symlink, strip the " -> target" suffix to get the link's own name.
    let name = if kind == SftpEntryKind::Symlink {
        match name_field.split_once(" -> ") {
            Some((link_name, _target)) => link_name.to_string(),
            None => name_field.to_string(),
        }
    } else {
        name_field.to_string()
    };

    if name.is_empty() {
        return None;
    }

    Some(SftpEntry {
        name,
        kind,
        size,
        modified,
        permissions: Some(perms.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_typical_listing() {
        let out = "\
drwxr-xr-x    5 user group     4096 Jun 21 10:00 node_modules
-rw-r--r--    1 user group      215 Jun 20 09:12 package.json
lrwxrwxrwx    1 user group       11 Jun 19 08:00 link -> /etc/target
";
        let entries = parse_ls_long(out);
        assert_eq!(entries.len(), 3);

        assert_eq!(entries[0].name, "node_modules");
        assert_eq!(entries[0].kind, SftpEntryKind::Dir);
        assert_eq!(entries[0].size, Some(4096));
        assert_eq!(entries[0].permissions.as_deref(), Some("drwxr-xr-x"));

        assert_eq!(entries[1].name, "package.json");
        assert_eq!(entries[1].kind, SftpEntryKind::File);
        assert_eq!(entries[1].size, Some(215));

        assert_eq!(entries[2].name, "link");
        assert_eq!(entries[2].kind, SftpEntryKind::Symlink);
    }

    #[test]
    fn skips_total_and_self_parent_but_keeps_dotfiles() {
        // `ls -la` output: the `.`/`..` self/parent rows are dropped, but real
        // hidden entries (.bashrc, .config) ARE kept and shown.
        let out = "\
total 24
drwxr-xr-x  2 u g 4096 Jun 21 10:00 .
drwxr-xr-x  3 u g 4096 Jun 21 10:00 ..
-rw-r--r--  1 u g  220 Jun 21 10:00 .bashrc
drwxr-xr-x  5 u g 4096 Jun 21 10:00 .config
-rw-r--r--  1 u g   10 Jun 21 10:00 keep.txt
";
        let entries = parse_ls_long(out);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec![".bashrc", ".config", "keep.txt"]);
        // The self/parent rows must NOT appear.
        assert!(!names.contains(&"."));
        assert!(!names.contains(&".."));
    }

    #[test]
    fn preserves_spaces_in_names() {
        let out = "-rw-r--r--  1 u g  5 Jun 21 10:00 My Report v2.txt\n";
        let entries = parse_ls_long(out);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "My Report v2.txt");
    }

    #[test]
    fn parses_year_form_date() {
        // Older files show a year instead of a time in the 8th column.
        let out = "-rw-r--r--  1 u g  5 Jun 21  2021 old.log\n";
        let entries = parse_ls_long(out);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "old.log");
        assert_eq!(entries[0].modified.as_deref(), Some("Jun 21 2021"));
    }

    #[test]
    fn ignores_non_listing_noise() {
        assert!(parse_ls_line("total 24").is_none());
        assert!(parse_ls_line("Connected to host.").is_none());
        assert!(parse_ls_line("sftp> ls -l").is_none());
    }

    #[test]
    fn parses_pwd_absolute_path() {
        // The `cd .; pwd; ls -l` batch prints this line; we read the abs path.
        let out = "Remote working directory: /home/e.zenkin\n\
-rw-r--r-- 1 u g 10 Jun 21 10:00 keep.txt\n";
        assert_eq!(parse_pwd(out).as_deref(), Some("/home/e.zenkin"));
        // The pwd line must NOT be parsed as a directory entry.
        let entries = parse_ls_long(out);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "keep.txt");
    }

    #[test]
    fn parse_pwd_returns_none_without_marker() {
        // No `pwd` line (e.g. command failed) → None so the caller falls back.
        let out = "-rw-r--r-- 1 u g 10 Jun 21 10:00 keep.txt\n";
        assert!(parse_pwd(out).is_none());
    }

    #[test]
    fn detects_put_permission_error_on_zero_exit() {
        // The signature of the silent 0-byte upload: sftp prints the error but
        // (without -b) exits 0. The scanner must catch it.
        let stdout = "Uploading /tmp/a to /home/x/a\n";
        let stderr = "Couldn't write to remote file \"/home/x/a\": Permission denied\n";
        let hit = first_sftp_error_line(stdout, stderr).expect("error detected");
        assert!(hit.contains("Permission denied"), "got: {hit}");
    }

    #[test]
    fn detects_quota_and_remote_open_errors() {
        assert!(first_sftp_error_line("", "Disk quota exceeded\n").is_some());
        assert!(
            first_sftp_error_line("remote open(\"/x\"): Permission denied\n", "").is_some()
        );
        assert!(first_sftp_error_line("Cannot download /x\n", "").is_some());
    }

    #[test]
    fn clean_transfer_output_is_not_flagged() {
        // A normal upload's progress lines must NOT be treated as an error.
        let stdout = "Uploading /tmp/a to /home/x/a\n\
/tmp/a                          100% 1400     1.2MB/s   00:00\n";
        assert!(first_sftp_error_line(stdout, "").is_none());
    }

    #[test]
    fn parse_pwd_handles_sftp_prompt_prefix() {
        // Some builds echo `sftp> pwd` before the result; the marker is matched
        // anywhere on the (trimmed) line, and a prompt-prefixed echo is ignored.
        let out = "sftp> pwd\nRemote working directory: /srv/data\n";
        assert_eq!(parse_pwd(out).as_deref(), Some("/srv/data"));
    }

    #[tokio::test]
    async fn invalid_alias_short_circuits_without_spawning() {
        let res = list_dir("-oProxyCommand=evil", "/tmp", None).await;
        assert!(matches!(res, Err(SftpError::InvalidTarget(_))));
    }

    #[tokio::test]
    async fn invalid_remote_path_short_circuits_without_spawning() {
        let res = list_dir("prod", "/a\nrm -rf /", None).await;
        assert!(matches!(res, Err(SftpError::InvalidPath(_))));
    }
}
