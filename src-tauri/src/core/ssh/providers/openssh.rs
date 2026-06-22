//! OpenSSH client-config provider: reads `~/.ssh/config` and the files it
//! `Include`s, surfacing every declared `Host` block as an [`SshHost`].
//!
//! Cross-platform: the path resolves via [`dirs::home_dir`], which yields
//! `%USERPROFILE%\.ssh\config` on Windows and `$HOME/.ssh/config` on
//! Unix — the same file the system `ssh`/`ssh.exe` reads. Read-only.
//!
//! ## Include handling
//!
//! `Include` directives are expanded read-only: every host found in an
//! included file is forced to `editable = false` (ProcMix must never rewrite
//! a file the user split out by hand). Relative include paths resolve
//! against `~/.ssh/` per OpenSSH semantics. Single-level globs
//! (`Include conf.d/*.conf`) are expanded by scanning the parent directory
//! without pulling in a glob crate. Recursion is depth-bounded to defend
//! against include cycles.

use std::path::{Path, PathBuf};

use super::super::provider::{SshSourceProvider, SshSourceWriter};
use super::super::types::{
    SshHost, SshHostDraft, SshHostId, SshSource, SshSourceError, SshWriteError,
};
use super::openssh_edit::{self, HostEdit};
use super::openssh_parse::{self, ParsedHost};

/// Maximum `Include` nesting depth. OpenSSH itself caps include depth; we
/// pick a generous-but-finite bound so a cyclic `Include` can never spin.
const MAX_INCLUDE_DEPTH: usize = 16;

/// Provider backed by the current user's OpenSSH client config.
pub struct OpenSshProvider {
    /// Absolute path to the primary config file. Injected for testability;
    /// production code uses [`OpenSshProvider::for_current_user`].
    config_path: PathBuf,
}

impl OpenSshProvider {
    /// Build a provider pointing at `~/.ssh/config` for the current user.
    ///
    /// Returns `None` when the home directory cannot be resolved (a headless
    /// or misconfigured environment) — the registry treats a `None` provider
    /// as simply unavailable.
    pub fn for_current_user() -> Option<Self> {
        let home = dirs::home_dir()?;
        Some(Self {
            config_path: home.join(".ssh").join("config"),
        })
    }

    /// Construct a provider for an explicit config path (tests).
    #[cfg(test)]
    pub fn with_config_path(config_path: PathBuf) -> Self {
        Self { config_path }
    }

    /// The directory used to resolve relative `Include` paths (the directory
    /// containing the primary config, i.e. `~/.ssh`).
    fn base_dir(&self) -> PathBuf {
        self.config_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."))
    }

    /// Read + parse `path`, recursing into its includes. `from_include` marks
    /// every host produced as non-editable. `depth` bounds recursion.
    fn collect_file(
        &self,
        path: &Path,
        from_include: bool,
        depth: usize,
        out: &mut Vec<SshHost>,
    ) -> Result<(), SshSourceError> {
        if depth > MAX_INCLUDE_DEPTH {
            return Ok(());
        }

        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            // A missing included file is not fatal — the user may reference an
            // optional path. Only the PRIMARY file's absence is handled by the
            // caller (via is_available); here we silently skip unreadable
            // includes so one bad path can't sink the whole inventory.
            Err(e) if from_include => {
                // Best-effort: skip, but surface nothing (read-only inventory).
                let _ = e;
                return Ok(());
            }
            Err(e) => return Err(SshSourceError::Read(e.to_string())),
        };

        let parsed = openssh_parse::parse(&text);
        let detail = path.display().to_string();

        for ph in parsed.hosts {
            out.push(self.to_host(ph, &detail, from_include));
        }

        for include in parsed.includes {
            for resolved in self.expand_include(&include) {
                self.collect_file(&resolved, true, depth + 1, out)?;
            }
        }

        Ok(())
    }

    /// Map a parsed host to the IPC [`SshHost`]. `from_include` forces all
    /// write flags off — ProcMix never rewrites an `Include`d file.
    fn to_host(&self, ph: ParsedHost, source_detail: &str, from_include: bool) -> SshHost {
        let writable = !from_include;
        SshHost {
            id: SshHostId::new(SshSource::OpenSshConfig, ph.name.clone()),
            name: ph.name,
            host_name: ph.host_name,
            user: ph.user,
            port: ph.port,
            identity_file: ph.identity_file,
            editable_params: ph.editable_params && writable,
            editable_name: ph.editable_name && writable,
            deletable: ph.deletable && writable,
            source_detail: source_detail.to_string(),
            raw_text: ph.raw_text,
        }
    }

    /// Resolve one `Include` argument to zero or more absolute paths.
    ///
    /// - Relative paths resolve against [`base_dir`](Self::base_dir).
    /// - A single trailing `*`/`?` glob in the final path component is
    ///   expanded by scanning the parent directory (one level, no `**`).
    /// - A literal path is returned as-is (existence is checked by the
    ///   reader, which skips unreadable includes).
    fn expand_include(&self, raw: &str) -> Vec<PathBuf> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Vec::new();
        }

        // `~` in an include path: OpenSSH expands it to the home dir.
        let expanded = if let Some(rest) = raw.strip_prefix("~/") {
            dirs::home_dir()
                .map(|h| h.join(rest))
                .unwrap_or_else(|| PathBuf::from(raw))
        } else {
            let p = PathBuf::from(raw);
            if p.is_absolute() {
                p
            } else {
                self.base_dir().join(p)
            }
        };

        let as_str = expanded.to_string_lossy();
        if as_str.contains('*') || as_str.contains('?') {
            self.glob_one_level(&expanded)
        } else {
            vec![expanded]
        }
    }

    /// Expand a single-level glob (`dir/<pattern>`). Only the final path
    /// component may contain `*`/`?`; the parent directory is scanned and its
    /// entries matched. Keeps us off a glob-crate dependency for the common
    /// `Include conf.d/*.conf` case.
    fn glob_one_level(&self, pattern_path: &Path) -> Vec<PathBuf> {
        let Some(parent) = pattern_path.parent() else {
            return Vec::new();
        };
        let Some(file_pattern) = pattern_path.file_name().and_then(|n| n.to_str()) else {
            return Vec::new();
        };

        let mut matches = Vec::new();
        let Ok(entries) = std::fs::read_dir(parent) else {
            return matches;
        };
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if glob_match(file_pattern, name) {
                    matches.push(entry.path());
                }
            }
        }
        // Deterministic order so the inventory is stable across runs.
        matches.sort();
        matches
    }
}

impl SshSourceProvider for OpenSshProvider {
    fn source(&self) -> SshSource {
        SshSource::OpenSshConfig
    }

    fn is_available(&self) -> bool {
        self.config_path.is_file()
    }

    fn list_hosts(&self) -> Result<Vec<SshHost>, SshSourceError> {
        let mut out = Vec::new();
        self.collect_file(&self.config_path, false, 0, &mut out)?;
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// Write support (surgical edit of ~/.ssh/config).
// ---------------------------------------------------------------------------

impl OpenSshProvider {
    /// Read the primary config's current text, or `""` when the file does not
    /// exist yet (a create will materialise it).
    fn read_current_text(&self) -> Result<String, SshWriteError> {
        match std::fs::read_to_string(&self.config_path) {
            Ok(t) => Ok(t),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(e) => Err(SshWriteError::Io(format!("read config: {e}"))),
        }
    }

    /// Reject a block that exists in the CURRENT file but is not params-
    /// editable — ProcMix must never rewrite a `Match`/multi-pattern/
    /// unknown-directive block. A non-existent alias (a create) passes.
    fn ensure_target_editable(&self, text: &str, alias: &str) -> Result<(), SshWriteError> {
        let parsed = openssh_parse::parse(text);
        if let Some(host) = parsed.hosts.iter().find(|h| h.name == alias) {
            if !host.editable_params {
                return Err(SshWriteError::ReadOnly(format!(
                    "host '{alias}' is managed manually"
                )));
            }
        }
        Ok(())
    }

    /// Persist `new_text` durably: back up the original on first write, write
    /// atomically (temp + rename in the same dir), and restore `0600` perms on
    /// Unix. Creates `~/.ssh` (mode `0700`) if missing.
    fn commit(&self, new_text: &str) -> Result<(), SshWriteError> {
        let dir = self
            .config_path
            .parent()
            .ok_or_else(|| SshWriteError::Io("config path has no parent".into()))?;

        // Ensure ~/.ssh exists with restrictive perms before any write.
        if !dir.exists() {
            std::fs::create_dir_all(dir)
                .map_err(|e| SshWriteError::Io(format!("create .ssh dir: {e}")))?;
            set_mode(dir, 0o700)?;
        }

        // Back up the existing config ONCE (don't clobber an earlier backup),
        // so the user always has a pre-ProcMix snapshot to restore from.
        if self.config_path.exists() {
            let backup = backup_path(&self.config_path);
            if !backup.exists() {
                std::fs::copy(&self.config_path, &backup)
                    .map_err(|e| SshWriteError::Io(format!("backup config: {e}")))?;
                set_mode(&backup, 0o600)?;
            }
        }

        write_atomic(&self.config_path, new_text.as_bytes())?;
        set_mode(&self.config_path, 0o600)?;
        Ok(())
    }
}

impl SshSourceWriter for OpenSshProvider {
    fn source(&self) -> SshSource {
        SshSource::OpenSshConfig
    }

    fn upsert_host(&self, draft: &SshHostDraft) -> Result<(), SshWriteError> {
        validate_draft(draft)?;

        let current = self.read_current_text()?;

        // If renaming, the OLD alias must also be an editable block we own.
        if let Some(prev) = draft.previous_name.as_deref() {
            if prev != draft.name {
                self.ensure_target_editable(&current, prev)?;
            }
        }
        // The (new) target alias, if it already exists, must be editable too.
        self.ensure_target_editable(&current, &draft.name)?;

        // Apply the surgical edit. On a rename we locate the OLD block and
        // rewrite it IN PLACE (swapping its `Host` line to the new alias),
        // which preserves the host's position in the file. A delete-then-append
        // would instead move the host to the bottom — the bug this avoids.
        let edit = HostEdit {
            alias: draft.name.clone(),
            host_name: draft.host_name.clone(),
            user: draft.user.clone(),
            port: draft.port,
            identity_file: draft.identity_file.clone(),
        };
        let locate = draft
            .previous_name
            .as_deref()
            .filter(|prev| *prev != draft.name)
            .unwrap_or(&draft.name);
        let next = openssh_edit::upsert_block_locating(&current, locate, &edit);

        // Defence in depth: the result MUST re-parse as our editable host,
        // else abort without writing.
        if !openssh_edit::is_editable_after(&next, &draft.name) {
            return Err(SshWriteError::Corruption(format!(
                "edited config no longer yields editable host '{}'",
                draft.name
            )));
        }

        self.commit(&next)
    }

    fn delete_host(&self, alias: &str) -> Result<(), SshWriteError> {
        // Allow wildcard patterns here too — deleting `*.staging.example.com`
        // is valid. The `deletable` gate below still blocks system/Include.
        if !is_safe_host_pattern(alias) {
            return Err(SshWriteError::Validation(format!(
                "invalid alias '{alias}'"
            )));
        }
        let current = self.read_current_text()?;
        // Deleting a non-existent host is a no-op success.
        let parsed = openssh_parse::parse(&current);
        match parsed.hosts.iter().find(|h| h.name == alias) {
            None => return Ok(()),
            Some(host) if !host.deletable => {
                return Err(SshWriteError::ReadOnly(format!(
                    "host '{alias}' is managed manually"
                )));
            }
            Some(_) => {}
        }

        let next = openssh_edit::delete_block(&current, alias);
        self.commit(&next)
    }
}

/// `true` when `name` is safe to write as a `Host` line value — a single
/// alias OR a wildcard pattern.
///
/// Unlike [`is_safe_alias`] (used for CONNECTING, which must be a concrete
/// host), this permits the pattern metacharacters `*`, `?` and a leading `!`
/// so the writer can create/edit pattern blocks like `*.staging.example.com`.
/// It still rejects everything that could corrupt the file or inject a
/// directive: empty, a LEADING `-` (looks like an ssh option), whitespace and
/// control characters, and shell metacharacters. The `Host` line is written
/// verbatim (never through a shell), so this is about file integrity, not
/// command safety.
fn is_safe_host_pattern(name: &str) -> bool {
    if name.is_empty() || name.starts_with('-') {
        return false;
    }
    name.chars().all(|c| {
        c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '@' | '*' | '?' | '!')
    })
}

/// Validate a draft before any file access. The `Host` name must be a safe
/// alias or wildcard pattern ([`is_safe_host_pattern`]); port in range; no
/// value may contain a newline (which would smuggle extra directives).
fn validate_draft(draft: &SshHostDraft) -> Result<(), SshWriteError> {
    if !is_safe_host_pattern(&draft.name) {
        return Err(SshWriteError::Validation(format!(
            "invalid alias '{}'",
            draft.name
        )));
    }
    if let Some(prev) = &draft.previous_name {
        if !is_safe_host_pattern(prev) {
            return Err(SshWriteError::Validation(format!(
                "invalid previous alias '{prev}'"
            )));
        }
    }
    for (field, value) in [
        ("hostName", &draft.host_name),
        ("user", &draft.user),
        ("identityFile", &draft.identity_file),
    ] {
        if let Some(v) = value {
            if v.contains('\n') || v.contains('\r') {
                return Err(SshWriteError::Validation(format!(
                    "{field} must not contain a newline"
                )));
            }
        }
    }
    if let Some(p) = draft.port {
        if p == 0 {
            return Err(SshWriteError::Validation("port must be 1-65535".into()));
        }
    }
    Ok(())
}

/// The sibling backup path for a config file (`<name>.procmix.bak`).
fn backup_path(config: &Path) -> PathBuf {
    let mut name = config
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_else(|| "config".into());
    name.push(".procmix.bak");
    config.with_file_name(name)
}

/// Set Unix file mode; a no-op on non-Unix platforms (Windows ACLs govern
/// access there and have no `chmod` equivalent we apply here).
#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> Result<(), SshWriteError> {
    use std::os::unix::fs::PermissionsExt;
    let perms = std::fs::Permissions::from_mode(mode);
    std::fs::set_permissions(path, perms)
        .map_err(|e| SshWriteError::Io(format!("set permissions: {e}")))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> Result<(), SshWriteError> {
    Ok(())
}

/// Atomically write `bytes` to `target`: write to a sibling temp file, then
/// rename it over the target. Mirrors `storage::env_config::write_atomic` —
/// duplicated here (not shared) to keep the SSH core free of a storage-layer
/// dependency. Rename is atomic on the same filesystem, so a concurrent
/// reader sees either the old or the new content, never a partial write.
fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), SshWriteError> {
    let dir = target
        .parent()
        .ok_or_else(|| SshWriteError::Io("target has no parent directory".into()))?;
    let file_name = target
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| SshWriteError::Io("target has no file name".into()))?;
    let tmp_name = format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let tmp_path = dir.join(tmp_name);

    std::fs::write(&tmp_path, bytes).map_err(|e| SshWriteError::Io(format!("write temp: {e}")))?;
    // Tighten the temp file's perms before it becomes the live config.
    set_mode(&tmp_path, 0o600)?;
    if let Err(e) = std::fs::rename(&tmp_path, target) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(SshWriteError::Io(format!("rename temp over target: {e}")));
    }
    Ok(())
}

/// Minimal shell-style glob matcher supporting `*` (any run) and `?` (one
/// char). Case-sensitive; operates on a single path component. Enough for
/// `*.conf` / `host_?` include patterns without a crate dependency.
fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    glob_match_inner(&p, &t)
}

fn glob_match_inner(p: &[char], t: &[char]) -> bool {
    // Iterative backtracking matcher (no recursion blowup on many `*`).
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star_p, mut star_t): (Option<usize>, usize) = (None, 0);

    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star_p = Some(pi);
            star_t = ti;
            pi += 1;
        } else if let Some(sp) = star_p {
            pi = sp + 1;
            star_t += 1;
            ti = star_t;
        } else {
            return false;
        }
    }

    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_file(dir: &Path, name: &str, contents: &str) -> PathBuf {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(contents.as_bytes()).unwrap();
        path
    }

    #[test]
    fn unavailable_when_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let provider = OpenSshProvider::with_config_path(dir.path().join("config"));
        assert!(!provider.is_available());
        // Listing a missing primary file is an error (the caller gates on
        // is_available first, but the method must not panic).
        assert!(provider.list_hosts().is_err());
    }

    #[test]
    fn lists_hosts_from_primary_file() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = write_file(
            dir.path(),
            "config",
            "Host prod\n  HostName prod.example.com\n  User deploy\n  Port 2222\n",
        );
        let provider = OpenSshProvider::with_config_path(cfg);
        assert!(provider.is_available());

        let hosts = provider.list_hosts().unwrap();
        assert_eq!(hosts.len(), 1);
        let h = &hosts[0];
        assert_eq!(h.name, "prod");
        assert_eq!(h.host_name.as_deref(), Some("prod.example.com"));
        assert_eq!(h.port, Some(2222));
        assert_eq!(h.id.source, SshSource::OpenSshConfig);
        assert!(h.editable_params);
        assert!(h.source_detail.ends_with("config"));
    }

    #[test]
    fn included_hosts_are_forced_read_only() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "extra.conf", "Host fromInclude\n  User u\n");
        let cfg = write_file(
            dir.path(),
            "config",
            "Include extra.conf\nHost local\n  User me\n",
        );
        let provider = OpenSshProvider::with_config_path(cfg);

        let hosts = provider.list_hosts().unwrap();
        let names: Vec<&str> = hosts.iter().map(|h| h.name.as_str()).collect();
        assert!(names.contains(&"local"));
        assert!(names.contains(&"fromInclude"));

        let included = hosts.iter().find(|h| h.name == "fromInclude").unwrap();
        // Even though the block itself is a clean literal alias, coming from
        // an Include forces it read-only.
        assert!(!included.editable_params);

        let primary = hosts.iter().find(|h| h.name == "local").unwrap();
        assert!(primary.editable_params);
    }

    #[test]
    fn glob_include_expands_directory() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "conf.d/a.conf", "Host alpha\n  User a\n");
        write_file(dir.path(), "conf.d/b.conf", "Host beta\n  User b\n");
        write_file(dir.path(), "conf.d/ignore.txt", "Host gamma\n  User g\n");
        let cfg = write_file(dir.path(), "config", "Include conf.d/*.conf\n");
        let provider = OpenSshProvider::with_config_path(cfg);

        let hosts = provider.list_hosts().unwrap();
        let names: Vec<&str> = hosts.iter().map(|h| h.name.as_str()).collect();
        assert!(names.contains(&"alpha"));
        assert!(names.contains(&"beta"));
        // `.txt` does not match `*.conf`.
        assert!(!names.contains(&"gamma"));
    }

    #[test]
    fn missing_include_is_skipped_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = write_file(
            dir.path(),
            "config",
            "Include does-not-exist.conf\nHost prod\n  User u\n",
        );
        let provider = OpenSshProvider::with_config_path(cfg);
        let hosts = provider.list_hosts().unwrap();
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].name, "prod");
    }

    #[test]
    fn include_cycle_terminates() {
        let dir = tempfile::tempdir().unwrap();
        // a includes b, b includes a — must not spin forever.
        write_file(dir.path(), "a.conf", "Include b.conf\nHost a\n");
        write_file(dir.path(), "b.conf", "Include a.conf\nHost b\n");
        let cfg = write_file(dir.path(), "config", "Include a.conf\n");
        let provider = OpenSshProvider::with_config_path(cfg);
        // Should return (bounded by MAX_INCLUDE_DEPTH) without hanging.
        let hosts = provider.list_hosts().unwrap();
        assert!(hosts.iter().any(|h| h.name == "a"));
        assert!(hosts.iter().any(|h| h.name == "b"));
    }

    #[test]
    fn glob_match_basics() {
        assert!(glob_match("*.conf", "a.conf"));
        assert!(glob_match("*.conf", ".conf"));
        assert!(!glob_match("*.conf", "a.txt"));
        assert!(glob_match("host_?", "host_1"));
        assert!(!glob_match("host_?", "host_12"));
        assert!(glob_match("*", "anything"));
        assert!(glob_match("a*b*c", "axxbyyc"));
        assert!(!glob_match("a*b*c", "axxbyy"));
    }

    // ----- write support -----------------------------------------------------

    fn draft(name: &str) -> SshHostDraft {
        SshHostDraft {
            name: name.into(),
            previous_name: None,
            host_name: None,
            user: None,
            port: None,
            identity_file: None,
        }
    }

    #[test]
    fn upsert_creates_file_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("config");
        let provider = OpenSshProvider::with_config_path(cfg.clone());
        assert!(!provider.is_available());

        let mut d = draft("prod");
        d.host_name = Some("prod.example.com".into());
        d.user = Some("deploy".into());
        provider.upsert_host(&d).unwrap();

        assert!(cfg.is_file());
        let hosts = provider.list_hosts().unwrap();
        let h = hosts.iter().find(|h| h.name == "prod").unwrap();
        assert_eq!(h.host_name.as_deref(), Some("prod.example.com"));
        assert_eq!(h.user.as_deref(), Some("deploy"));
        assert!(h.editable_params);
    }

    #[cfg(unix)]
    #[test]
    fn written_file_has_0600_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let cfg = dir.path().join("config");
        let provider = OpenSshProvider::with_config_path(cfg.clone());
        provider.upsert_host(&draft("prod")).unwrap();

        let mode = std::fs::metadata(&cfg).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "config must be chmod 600");
    }

    #[test]
    fn upsert_backs_up_existing_config_once() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = write_file(dir.path(), "config", "Host old\n    User u\n");
        let provider = OpenSshProvider::with_config_path(cfg.clone());

        let mut d = draft("new");
        d.host_name = Some("n".into());
        provider.upsert_host(&d).unwrap();

        let backup = dir.path().join("config.procmix.bak");
        assert!(backup.is_file(), "first write must create a backup");
        let backup_text = std::fs::read_to_string(&backup).unwrap();
        assert_eq!(
            backup_text, "Host old\n    User u\n",
            "backup is the pre-edit content"
        );

        // A second write must NOT overwrite the original backup.
        provider.upsert_host(&draft("another")).unwrap();
        let backup_text2 = std::fs::read_to_string(&backup).unwrap();
        assert_eq!(backup_text2, "Host old\n    User u\n");
    }

    #[test]
    fn upsert_edits_existing_block_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = write_file(
            dir.path(),
            "config",
            "# my hosts\nHost prod\n    HostName old\n    User u\n",
        );
        let provider = OpenSshProvider::with_config_path(cfg.clone());

        let mut d = draft("prod");
        d.host_name = Some("new.example.com".into());
        d.user = Some("u".into());
        provider.upsert_host(&d).unwrap();

        let text = std::fs::read_to_string(&cfg).unwrap();
        assert!(text.contains("# my hosts"), "comment preserved");
        let hosts = provider.list_hosts().unwrap();
        let h = hosts.iter().find(|h| h.name == "prod").unwrap();
        assert_eq!(h.host_name.as_deref(), Some("new.example.com"));
        assert_eq!(hosts.iter().filter(|h| h.name == "prod").count(), 1);
    }

    #[test]
    fn upsert_rejects_invalid_alias() {
        let dir = tempfile::tempdir().unwrap();
        let provider = OpenSshProvider::with_config_path(dir.path().join("config"));
        let err = provider.upsert_host(&draft("-injection")).unwrap_err();
        assert!(matches!(err, SshWriteError::Validation(_)));
        // No file should have been created.
        assert!(!dir.path().join("config").exists());
    }

    #[test]
    fn upsert_rejects_newline_in_value() {
        let dir = tempfile::tempdir().unwrap();
        let provider = OpenSshProvider::with_config_path(dir.path().join("config"));
        let mut d = draft("prod");
        d.host_name = Some("h\n    ProxyCommand evil".into());
        let err = provider.upsert_host(&d).unwrap_err();
        assert!(matches!(err, SshWriteError::Validation(_)));
    }

    #[test]
    fn upsert_refuses_to_edit_a_read_only_block() {
        let dir = tempfile::tempdir().unwrap();
        // Existing block with an unknown directive → not editable.
        let cfg = write_file(
            dir.path(),
            "config",
            "Host prod\n    ProxyJump bastion\n    User u\n",
        );
        let provider = OpenSshProvider::with_config_path(cfg);
        let mut d = draft("prod");
        d.user = Some("changed".into());
        let err = provider.upsert_host(&d).unwrap_err();
        assert!(matches!(err, SshWriteError::ReadOnly(_)));
    }

    #[test]
    fn upsert_renames_by_dropping_previous_block() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = write_file(
            dir.path(),
            "config",
            "Host old\n    HostName h\n    User u\n",
        );
        let provider = OpenSshProvider::with_config_path(cfg);

        let mut d = draft("new");
        d.previous_name = Some("old".into());
        d.host_name = Some("h".into());
        d.user = Some("u".into());
        provider.upsert_host(&d).unwrap();

        let hosts = provider.list_hosts().unwrap();
        let names: Vec<&str> = hosts.iter().map(|h| h.name.as_str()).collect();
        assert!(names.contains(&"new"));
        assert!(
            !names.contains(&"old"),
            "old alias must be gone after rename"
        );
    }

    #[test]
    fn upsert_edit_keeps_block_position_in_file() {
        // Editing a host that is NOT last must not move it to the bottom
        // (regression: edited host jumped to EOF). End-to-end through the
        // provider's write pipeline.
        let dir = tempfile::tempdir().unwrap();
        let cfg = write_file(
            dir.path(),
            "config",
            "Host a\n    User ua\n\nHost mid\n    HostName old\n\nHost z\n    User uz\n",
        );
        let provider = OpenSshProvider::with_config_path(cfg.clone());

        let mut d = draft("mid");
        d.host_name = Some("new.example.com".into());
        provider.upsert_host(&d).unwrap();

        let order: Vec<String> = provider
            .list_hosts()
            .unwrap()
            .into_iter()
            .map(|h| h.name)
            .collect();
        assert_eq!(order, vec!["a", "mid", "z"], "mid must stay in the middle");
    }

    #[test]
    fn upsert_rename_keeps_block_position_in_file() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = write_file(
            dir.path(),
            "config",
            "Host a\n    User ua\n\nHost mid\n    HostName h\n\nHost z\n    User uz\n",
        );
        let provider = OpenSshProvider::with_config_path(cfg);

        let mut d = draft("mid-renamed");
        d.previous_name = Some("mid".into());
        d.host_name = Some("h".into());
        provider.upsert_host(&d).unwrap();

        let order: Vec<String> = provider
            .list_hosts()
            .unwrap()
            .into_iter()
            .map(|h| h.name)
            .collect();
        assert_eq!(
            order,
            vec!["a", "mid-renamed", "z"],
            "renamed host must keep its position, not jump to EOF"
        );
    }

    #[test]
    fn delete_removes_block_and_keeps_others() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = write_file(
            dir.path(),
            "config",
            "Host a\n    User ua\n\nHost prod\n    User u\n\nHost b\n    User ub\n",
        );
        let provider = OpenSshProvider::with_config_path(cfg);

        provider.delete_host("prod").unwrap();

        let hosts = provider.list_hosts().unwrap();
        let names: Vec<&str> = hosts.iter().map(|h| h.name.as_str()).collect();
        assert!(!names.contains(&"prod"));
        assert!(names.contains(&"a"));
        assert!(names.contains(&"b"));
    }

    #[test]
    fn delete_missing_host_is_ok() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = write_file(dir.path(), "config", "Host prod\n    User u\n");
        let provider = OpenSshProvider::with_config_path(cfg);
        // No such host → success, file unchanged.
        provider.delete_host("ghost").unwrap();
        assert_eq!(provider.list_hosts().unwrap().len(), 1);
    }

    #[test]
    fn delete_allows_a_wildcard_pattern() {
        // A wildcard pattern block is a deletable connection rule now.
        let dir = tempfile::tempdir().unwrap();
        let cfg = write_file(
            dir.path(),
            "config",
            "Host *.x\n    User ci\n\nHost keep\n    User k\n",
        );
        let provider = OpenSshProvider::with_config_path(cfg);
        provider.delete_host("*.x").unwrap();

        let names: Vec<String> = provider
            .list_hosts()
            .unwrap()
            .into_iter()
            .map(|h| h.name)
            .collect();
        assert!(!names.contains(&"*.x".to_string()));
        assert!(names.contains(&"keep".to_string()));
    }

    #[test]
    fn delete_refuses_a_block_with_unmodelled_directive() {
        // A block ProcMix can't fully model (ProxyJump) is not deletable.
        let dir = tempfile::tempdir().unwrap();
        let cfg = write_file(
            dir.path(),
            "config",
            "Host bastioned\n    HostName h\n    ProxyJump gw\n",
        );
        let provider = OpenSshProvider::with_config_path(cfg);
        let err = provider.delete_host("bastioned").unwrap_err();
        assert!(matches!(err, SshWriteError::ReadOnly(_)));
    }

    #[test]
    fn is_safe_host_pattern_allows_wildcards_blocks_injection() {
        assert!(is_safe_host_pattern("prod"));
        assert!(is_safe_host_pattern("*.staging.example.com"));
        assert!(is_safe_host_pattern("web?"));
        assert!(is_safe_host_pattern("!neg"));
        // Injection / corruption vectors still rejected.
        assert!(!is_safe_host_pattern(""));
        assert!(!is_safe_host_pattern("-oProxyCommand=x"));
        assert!(!is_safe_host_pattern("a b"));
        assert!(!is_safe_host_pattern("a\nHostName evil"));
        assert!(!is_safe_host_pattern("a;rm -rf /"));
        assert!(!is_safe_host_pattern("a$b"));
    }
}
