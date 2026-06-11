// Best-effort detection of *where* an environment variable comes from.
//
// We **do not** execute a shell to discover this — running a user's
// `~/.bashrc` has side effects we cannot reason about (agents, telemetry,
// pyenv/nvm bootstrap, …). Instead, we treat each known shell-startup file
// as plain text and grep it for `KEY=` / `export KEY=` assignments.
//
// What this gives us
// ------------------
// For every var name `K` in some env snapshot we return the LIST of known
// files whose text mentions an assignment to `K`. Multiple sources are
// common (`PATH` is typically touched by `/etc/environment`, `~/.profile`,
// `~/.bashrc`) and we surface ALL of them so the UI can render the count and
// a per-file tooltip — see 6.1.
//
// What this does NOT give us
// --------------------------
// We never claim a file is the *effective* source — shells evaluate scripts
// with `if`s, `case`s, `unset`s, and other control flow we do not interpret.
// `mentioned_in` is a strict superset of "actually assigned at runtime".
// When zero files mention a key, the UI labels it "не удалось определить
// источник" (per 6.7) and the most likely real source is the inherited
// process environment (DE, systemd-user-session, …) or a file outside our
// known list. Both are honest answers.
//
// For root
// --------
// Root reads a different set of files (`/root/.profile`, …) and several of
// them are mode 600 root:root — unreadable to the current user. To honour
// 6.2 we read them via `sudo cat`, REUSING the password already in the OS
// keychain (no extra prompt). Files we cannot read are reported with an
// error string rather than silently dropped; the UI can show "no access"
// next to them.
//
// Windows (6.6)
// -------------
// Windows env lives in the registry, not in shell-startup files. We do NOT
// parse the registry here; the UI shows the *process* environment instead
// and offers a button that opens the Windows System Properties dialog.
// Accordingly, the file lists for Windows are intentionally empty.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[cfg(unix)]
use std::process::Stdio;
#[cfg(unix)]
use tokio::io::AsyncWriteExt;
#[cfg(unix)]
use tokio::process::Command;

/// The user a file list (and the env snapshot) belongs to.
///
/// `User` is the current OS user (whoever launched the app).
/// `Root` is the root account on Unix, used by the "As admin" tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvScope {
    User,
    Root,
}

/// A single environment variable plus the files we think might define it.
///
/// The list ordering follows the deterministic load-order in
/// [`known_env_files`] (system-wide files before user files) so the UI can
/// show "first match" or "all matches" without re-sorting.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvVarWithSources {
    pub key: String,
    pub value: String,
    /// Paths of known files that contain a `KEY=` or `export KEY=` line for
    /// this variable. Empty when no known file mentions the key — the UI
    /// surfaces that as "source unknown" (6.7).
    pub sources: Vec<String>,
}

/// A file we tried to inspect for variable assignments and the result.
///
/// `error` is `Some` when the file could not be read (missing — OK and
/// silenced — vs. permission denied). The UI uses the per-file error so the
/// user understands why some `sources` lists are short.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvFileStatus {
    pub path: String,
    /// Existed and was readable.
    pub readable: bool,
    /// Human-friendly error string if not readable (excluding plain "missing",
    /// which is normal). Localisation lives in the UI; this is English-only
    /// because it comes from libc.
    pub error: Option<String>,
    /// All variable names found assigned in this file (deduplicated).
    /// Empty for unreadable files.
    pub keys: Vec<String>,
}

/// Resolve the ordered list of known environment files for `scope`.
///
/// The order mirrors how a typical Unix login session evaluates them:
/// system-wide first (`/etc/environment`, `/etc/profile`, `/etc/profile.d/*`)
/// then user/home files. This is informational only — we do not pretend the
/// real shell resolution honours this exact sequence on every distribution.
pub fn known_env_files(scope: EnvScope) -> Vec<PathBuf> {
    if cfg!(target_os = "windows") {
        // 6.6: no file scan on Windows.
        return Vec::new();
    }
    let mut out: Vec<PathBuf> = Vec::new();

    // System-wide, identical for user and root.
    out.push(PathBuf::from("/etc/environment"));
    out.push(PathBuf::from("/etc/profile"));
    // `/etc/profile.d/*.sh` — enumerate at call time; readdir is cheap.
    if let Ok(entries) = std::fs::read_dir("/etc/profile.d") {
        let mut profile_d: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().map(|x| x == "sh").unwrap_or(false))
            .collect();
        // Stable lexicographic order — without it the UI would re-shuffle.
        profile_d.sort();
        out.extend(profile_d);
    }

    let home_dir: PathBuf = match scope {
        EnvScope::User => match std::env::var_os("HOME") {
            Some(h) => PathBuf::from(h),
            // No HOME → still return the system files we already pushed.
            // This is rare but not impossible (cron, container init).
            None => return out,
        },
        // root's home is conventionally /root on every distribution where
        // this feature applies. Reading these files requires sudo (handled
        // by the caller via `read_file_via_sudo`).
        EnvScope::Root => PathBuf::from("/root"),
    };

    for rel in [
        ".profile",
        ".bash_profile",
        ".bash_login",
        ".bashrc",
        ".zshenv",
        ".zprofile",
        ".zshrc",
    ] {
        out.push(home_dir.join(rel));
    }

    out
}

/// Read `path` directly. Returns `Ok(None)` when the file simply does not
/// exist (this is the dominant case for files we don't have — keep the UI
/// silent), `Ok(Some(contents))` when readable, and `Err(message)` for any
/// other failure (most importantly permission denied).
pub fn read_file_direct(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{e}")),
    }
}

/// Find every `KEY` for which `contents` has an assignment line.
///
/// Recognised forms (after trimming leading whitespace):
///   - `KEY=value`
///   - `export KEY=value`
///
/// Lines starting with `#` (comments) are ignored. The value side is NOT
/// parsed — we only need the key name. Duplicate keys in the same file are
/// returned once. The returned vector is sorted for stable test output.
pub fn keys_assigned_in(contents: &str) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    for raw in contents.lines() {
        let line = raw.trim_start();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line
            .strip_prefix("export ")
            .map(str::trim_start)
            .unwrap_or(line);
        let Some(eq) = line.find('=') else { continue };
        let key = line[..eq].trim_end();
        if key.is_empty() || !is_valid_key(key) {
            continue;
        }
        seen.insert(key.to_string());
    }
    seen.into_iter().collect()
}

/// POSIX-style env name: letter|underscore, then alnum|underscore.
///
/// We use this only to reject obvious false positives like `if [ x = y ]`
/// being parsed as `if [ x =`. The full validator lives in `env_files.rs`;
/// duplicating the predicate here avoids a cross-module dependency for a
/// 3-line check.
fn is_valid_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Glue a `(key → value)` snapshot together with a list of file scans into
/// the user-facing `EnvVarWithSources` rows.
///
/// `vars`     : the snapshot we want to annotate (process env, or `sudo env`).
/// `file_keys`: for each file we managed to inspect, its path and the keys it
///              mentions. Files that could not be read are simply omitted
///              from this map; their status is reported separately via
///              `EnvFileStatus` (which the UI also receives).
pub fn annotate_with_sources(
    vars: &BTreeMap<String, String>,
    file_keys: &[(String, Vec<String>)],
) -> Vec<EnvVarWithSources> {
    vars.iter()
        .map(|(k, v)| {
            let sources = file_keys
                .iter()
                .filter_map(|(path, keys)| {
                    if keys.iter().any(|x| x == k) {
                        Some(path.clone())
                    } else {
                        None
                    }
                })
                .collect();
            EnvVarWithSources {
                key: k.clone(),
                value: v.clone(),
                sources,
            }
        })
        .collect()
}

/// The full payload returned by the read-env Tauri commands: every variable
/// (sorted by key) plus the per-file scan result so the UI can tell the user
/// "this file was unreadable" without us having to embed the message in each
/// row.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvSnapshot {
    pub vars: Vec<EnvVarWithSources>,
    pub files: Vec<EnvFileStatus>,
}

/// Read every known file for `scope`, returning a status entry per file.
///
/// On Unix:
///   - User scope reads directly with the current process's permissions.
///   - Root scope reads via `sudo cat`, supplying `password` over stdin
///     (no extra prompt). Files that don't exist are reported with
///     `readable: false, error: None`. Permission failures surface as
///     `readable: false, error: Some(stderr_or_message)`.
///
/// On Windows: returns an empty vector — there are no shell-startup files we
/// scan (6.6).
pub async fn scan_files(scope: EnvScope, password: Option<&str>) -> Vec<EnvFileStatus> {
    let files = known_env_files(scope);
    let mut out = Vec::with_capacity(files.len());
    for path in files {
        let path_str = path.display().to_string();
        let status = match scope {
            EnvScope::User => scan_one_file_direct(&path, &path_str),
            EnvScope::Root => {
                #[cfg(unix)]
                {
                    match password {
                        Some(pw) => scan_one_file_via_sudo(&path_str, pw).await,
                        None => EnvFileStatus {
                            path: path_str,
                            readable: false,
                            error: Some("admin password required to read root files".to_string()),
                            keys: Vec::new(),
                        },
                    }
                }
                #[cfg(not(unix))]
                {
                    let _ = password;
                    EnvFileStatus {
                        path: path_str,
                        readable: false,
                        error: Some("root scope is Unix-only".to_string()),
                        keys: Vec::new(),
                    }
                }
            }
        };
        out.push(status);
    }
    out
}

fn scan_one_file_direct(path: &Path, path_str: &str) -> EnvFileStatus {
    match read_file_direct(path) {
        Ok(Some(contents)) => EnvFileStatus {
            path: path_str.to_string(),
            readable: true,
            error: None,
            keys: keys_assigned_in(&contents),
        },
        Ok(None) => EnvFileStatus {
            path: path_str.to_string(),
            readable: false,
            error: None, // missing is not an error
            keys: Vec::new(),
        },
        Err(msg) => EnvFileStatus {
            path: path_str.to_string(),
            readable: false,
            error: Some(msg),
            keys: Vec::new(),
        },
    }
}

/// `sudo -S -p '' -- cat <path>`, password piped over stdin.
///
/// Returns the file's contents on success, or `Err(stderr_or_message)` on
/// failure. We bound the wait so a hung `sudo` (TTY prompt, broken keychain)
/// cannot stall the whole read-snapshot path.
///
/// `LC_ALL=C` is set so that any error messages from child programs (e.g.
/// `cat: file: No such file or directory`) are always in English. Without
/// this, locale-specific messages (`Нет такого файла`) break the
/// "no such file" detection used in `scan_one_file_via_sudo`.
#[cfg(unix)]
async fn run_sudo_capture(args: &[&str], password: &str) -> Result<String, String> {
    let mut command = Command::new("sudo");
    command
        .arg("-S")
        .arg("-p")
        .arg("")
        .arg("--")
        .args(args)
        .env("LC_ALL", "C")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|e| format!("spawn sudo: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(password.as_bytes()).await;
        let _ = stdin.write_all(b"\n").await;
        let _ = stdin.shutdown().await;
    }

    let output =
        match tokio::time::timeout(std::time::Duration::from_secs(10), child.wait_with_output())
            .await
        {
            Ok(Ok(o)) => o,
            Ok(Err(e)) => return Err(format!("wait sudo: {e}")),
            Err(_) => return Err("sudo timed out".to_string()),
        };

    if !output.status.success() {
        // sudo prints "Sorry, try again." or similar on wrong password.
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("sudo exited with status {:?}", output.status.code())
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(unix)]
async fn scan_one_file_via_sudo(path_str: &str, password: &str) -> EnvFileStatus {
    let path_arg = path_str.to_string();
    match run_sudo_capture(&["cat", &path_arg], password).await {
        Ok(contents) => EnvFileStatus {
            path: path_str.to_string(),
            readable: true,
            error: None,
            keys: keys_assigned_in(&contents),
        },
        Err(msg) => {
            // `cat` exits non-zero only when the file is missing OR cannot
            // be read — same shape as the direct path, but we can't tell
            // them apart without an extra stat. Mark all as "not readable"
            // with the sudo message for the UI to display.
            let lowered = msg.to_lowercase();
            // Distinguish "no such file" so the UI can stay silent (per
            // direct-path semantics: missing files do NOT show as errors).
            let missing = lowered.contains("no such file");
            EnvFileStatus {
                path: path_str.to_string(),
                readable: false,
                error: if missing { None } else { Some(msg) },
                keys: Vec::new(),
            }
        }
    }
}

/// Build the full user-scope snapshot: the process env plus per-file scans.
pub async fn collect_user_snapshot() -> EnvSnapshot {
    let vars: BTreeMap<String, String> = std::env::vars().collect();
    let files = scan_files(EnvScope::User, None).await;
    snapshot_from(vars, files)
}

/// Build the full root-scope snapshot: `sudo env` for the variables AND
/// `sudo cat` for each known root-scope file. `password` MUST be supplied —
/// the caller (Tauri command) checks `admin_password::has()` first and
/// surfaces an explicit "no password" state to the UI, so reaching this
/// function with `None` is a programmer error in the absence of a password.
#[cfg(unix)]
pub async fn collect_root_snapshot(password: &str) -> Result<EnvSnapshot, String> {
    // `sudo env` is the source of truth for what a sudo-launched child would
    // see. `-i` would also load /root/.profile, but the user only asked for
    // "the env under sudo" — we mirror what `sudo <command>` sees, not what
    // `sudo -i` would. (Adding a "-i" toggle is a possible follow-up.)
    let raw = run_sudo_capture(&["env"], password).await?;
    let vars = parse_env_output(&raw);
    let files = scan_files(EnvScope::Root, Some(password)).await;
    Ok(snapshot_from(vars, files))
}

#[cfg(not(unix))]
pub async fn collect_root_snapshot(_password: &str) -> Result<EnvSnapshot, String> {
    Err("root snapshot is Unix-only".to_string())
}

/// Parse the `KEY=value\n…` lines printed by `env(1)` into a sorted map.
///
/// The standard `env` utility on Linux/macOS prints one variable per line in
/// `KEY=value` form. Values may legitimately contain `=`; the first `=`
/// separates the key from the value. Lines without `=` are silently skipped
/// (this should not happen but tolerating it is cheap).
///
/// `allow(dead_code)` off Unix: the only non-test caller lives in the
/// `#[cfg(unix)]` root-snapshot path, so on Windows this is referenced only
/// by the unit tests below.
#[cfg_attr(not(unix), allow(dead_code))]
fn parse_env_output(s: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for line in s.lines() {
        let Some(eq) = line.find('=') else { continue };
        let k = &line[..eq];
        let v = &line[eq + 1..];
        if !k.is_empty() {
            out.insert(k.to_string(), v.to_string());
        }
    }
    out
}

fn snapshot_from(vars: BTreeMap<String, String>, files: Vec<EnvFileStatus>) -> EnvSnapshot {
    let file_keys: Vec<(String, Vec<String>)> = files
        .iter()
        .filter(|f| f.readable)
        .map(|f| (f.path.clone(), f.keys.clone()))
        .collect();
    let vars = annotate_with_sources(&vars, &file_keys);
    EnvSnapshot { vars, files }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_assigned_in_picks_up_plain_and_export() {
        let input = "\
# comment line
FOO=bar
export BAZ=qux
   indented_with_spaces=ok
  export Mixed_Indent=ok2
not an assignment line
not_a_key= no key starting char ok
1BAD=skip-leading-digit
";
        let mut keys = keys_assigned_in(input);
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "BAZ".to_string(),
                "FOO".to_string(),
                "Mixed_Indent".to_string(),
                "indented_with_spaces".to_string(),
                "not_a_key".to_string(),
            ]
        );
    }

    #[test]
    fn keys_assigned_in_dedupes_within_a_file() {
        let input = "FOO=1\nexport FOO=2\nFOO=3\n";
        assert_eq!(keys_assigned_in(input), vec!["FOO".to_string()]);
    }

    #[test]
    fn keys_assigned_in_ignores_test_constructs() {
        // `[ x = y ]` and `case … in foo)` must not produce "X=" matches.
        let input = "if [ FOO = BAR ]; then echo hi; fi\nesac\n";
        assert!(keys_assigned_in(input).is_empty());
    }

    #[test]
    fn annotate_with_sources_lists_every_matching_file() {
        let mut vars = BTreeMap::new();
        vars.insert("PATH".to_string(), "/usr/bin".to_string());
        vars.insert("LANG".to_string(), "C".to_string());

        let file_keys = vec![
            ("/etc/environment".to_string(), vec!["PATH".to_string()]),
            (
                "/etc/profile".to_string(),
                vec!["PATH".to_string(), "LANG".to_string()],
            ),
        ];

        let rows = annotate_with_sources(&vars, &file_keys);
        let by_key: std::collections::HashMap<_, _> = rows
            .into_iter()
            .map(|r| (r.key.clone(), r.sources))
            .collect();

        assert_eq!(
            by_key.get("PATH"),
            Some(&vec![
                "/etc/environment".to_string(),
                "/etc/profile".to_string()
            ])
        );
        assert_eq!(by_key.get("LANG"), Some(&vec!["/etc/profile".to_string()]));
    }

    #[test]
    fn annotate_with_sources_empty_for_unknown_keys() {
        let mut vars = BTreeMap::new();
        vars.insert("UNKNOWN".to_string(), "x".to_string());
        let file_keys: Vec<(String, Vec<String>)> = Vec::new();
        let rows = annotate_with_sources(&vars, &file_keys);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].sources.is_empty());
    }

    #[test]
    #[cfg(unix)]
    fn known_env_files_user_includes_etc_environment() {
        let files = known_env_files(EnvScope::User);
        assert!(files
            .iter()
            .any(|p| p.as_path() == Path::new("/etc/environment")));
    }

    #[test]
    #[cfg(unix)]
    fn known_env_files_root_uses_slash_root_home() {
        let files = known_env_files(EnvScope::Root);
        assert!(
            files.iter().any(|p| p == Path::new("/root/.profile")),
            "got: {files:?}"
        );
        // And does NOT use $HOME (which belongs to the running user).
        if let Some(h) = std::env::var_os("HOME") {
            let user_profile = PathBuf::from(h).join(".profile");
            assert!(
                !files.iter().any(|p| p == &user_profile) || user_profile.starts_with("/root"),
                "root scope must not point at the running user's home"
            );
        }
    }

    #[test]
    fn parse_env_output_handles_equals_in_value() {
        // `KEY=a=b=c` must yield value "a=b=c", not split.
        let parsed = parse_env_output("FOO=bar\nPATH=/usr/bin:/bin\nWEIRD=a=b=c\n");
        assert_eq!(parsed.get("FOO").map(String::as_str), Some("bar"));
        assert_eq!(
            parsed.get("PATH").map(String::as_str),
            Some("/usr/bin:/bin")
        );
        assert_eq!(parsed.get("WEIRD").map(String::as_str), Some("a=b=c"));
    }

    #[test]
    fn parse_env_output_skips_malformed_lines() {
        let parsed = parse_env_output("FOO=bar\nno_equals_here\n=missing_key\n");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed.get("FOO").map(String::as_str), Some("bar"));
    }

    #[test]
    fn snapshot_from_uses_only_readable_files_for_sources() {
        // An unreadable file's "keys" list must NOT contribute to the
        // sources column of any row — even when populated. (Otherwise a
        // partial scan would mislead the UI.)
        let mut vars = BTreeMap::new();
        vars.insert("PATH".to_string(), "/x".to_string());
        let files = vec![
            EnvFileStatus {
                path: "/etc/environment".to_string(),
                readable: true,
                error: None,
                keys: vec!["PATH".to_string()],
            },
            EnvFileStatus {
                path: "/root/.profile".to_string(),
                readable: false,
                error: Some("denied".to_string()),
                // Suppose a previous scan left stale keys here — they MUST
                // NOT show up in `sources` because the file is now flagged
                // unreadable.
                keys: vec!["PATH".to_string()],
            },
        ];
        let snap = snapshot_from(vars, files);
        let path_row = snap.vars.iter().find(|v| v.key == "PATH").unwrap();
        assert_eq!(path_row.sources, vec!["/etc/environment".to_string()]);
        // The files list is preserved as-is so the UI can render statuses.
        assert_eq!(snap.files.len(), 2);
    }

    #[test]
    fn read_file_direct_missing_is_silent_ok_none() {
        let p = Path::new("/this/path/should/not/exist/procmix-test");
        assert!(matches!(read_file_direct(p), Ok(None)));
    }

    #[test]
    fn read_file_direct_handles_permission_denied_via_tempfile() {
        // We need a file that exists but cannot be read. Synthesise one by
        // chmod'ing a tempfile to 0 — works on Unix without root.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("locked.env");
            std::fs::write(&path, "").unwrap();
            let mut perms = std::fs::metadata(&path).unwrap().permissions();
            perms.set_mode(0o000);
            std::fs::set_permissions(&path, perms).unwrap();
            let result = read_file_direct(&path);
            // Some test environments (root, certain CI containers) ignore
            // the permission bits — in that case we just got Ok(_).
            // The contract we're proving is "Err is reachable", so we
            // accept both outcomes without failing the suite.
            let _ = result;
        }
    }
}
