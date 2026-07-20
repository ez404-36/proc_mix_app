//! IPC-boundary types and validation for the SFTP file-transfer feature.
//!
//! These DTOs describe directory listings and transfer outcomes for the
//! dual-pane file manager. Every type mirrors a TypeScript interface in
//! `src/types/sftp.ts` character-for-character via serde's
//! `rename_all = "camelCase"`.
//!
//! ## Security
//!
//! The transport (see `client.rs`) spawns the system `sftp` binary with a
//! fixed argv — never through a shell. Two user-derived values reach the
//! child:
//!   1. the destination **alias**, validated by `core::ssh::is_safe_alias`
//!      (re-exported from this module) before it is placed in the argv; and
//!   2. **remote paths**, which become single tokens in the `sftp` *batch*
//!      script (fed on stdin, not the argv). [`is_safe_remote_path`] rejects
//!      NUL/control characters and a leading `-`; the batch builder
//!      additionally quotes each path as one `sftp` token so a space or quote
//!      cannot split it. No remote path is ever interpreted by a local shell.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Returned when the destination alias fails `is_safe_alias`. Mirrors the SSH
/// remote-execution sentinel shape (`<CONST>:<alias>`); the JS side matches on
/// the prefix to show a precise toast.
pub const ERR_INVALID_SFTP_TARGET: &str = "INVALID_SFTP_TARGET";

/// Returned when a remote path argument fails [`is_safe_remote_path`].
pub const ERR_INVALID_REMOTE_PATH: &str = "INVALID_REMOTE_PATH";

/// What a directory entry is. Symlinks are surfaced as their own kind so the
/// UI can badge them; following them is left to `sftp`/the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SftpEntryKind {
    File,
    Dir,
    Symlink,
}

/// A single entry in a remote directory listing. Mirrors `SftpEntry` in
/// `src/types/sftp.ts`.
///
/// `size`/`modified`/`permissions` are best-effort: `sftp ls -l` output is
/// parsed tolerantly, so a row that cannot be fully parsed still yields an
/// entry with `name` set and the optional fields `None`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    /// The entry's base name (no path), e.g. `node_modules`.
    pub name: String,
    pub kind: SftpEntryKind,
    /// Size in bytes when known.
    pub size: Option<u64>,
    /// Modification time as the raw, `LC_ALL=C` `ls -l` date field(s), kept
    /// verbatim for display. Not normalised to RFC 3339 in this iteration.
    pub modified: Option<String>,
    /// The raw permission string (e.g. `drwxr-xr-x`) when parsed.
    pub permissions: Option<String>,
}

/// A remote directory listing for one pane. Mirrors `SftpListing`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpListing {
    /// The absolute remote directory this listing is for.
    pub path: String,
    pub entries: Vec<SftpEntry>,
}

/// A single entry in a LOCAL directory listing (the left pane). Mirrors
/// `LocalEntry` in `src/types/sftp.ts`. Distinct from [`SftpEntry`] because
/// local entries come from `std::fs` (no permission string parse needed) and
/// the kind comes from the filesystem metadata directly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    pub name: String,
    pub kind: SftpEntryKind,
    pub size: Option<u64>,
}

/// A local directory listing for the left pane. Mirrors `LocalListing`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalListing {
    /// The absolute local directory this listing is for.
    pub path: String,
    pub entries: Vec<LocalEntry>,
}

/// Errors an SFTP operation can fail with. `String`-backed and safe to
/// surface: messages derive from `sftp`'s `LC_ALL=C` stderr (no secret is
/// embedded — passwords reach `sftp` only via the askpass helper's stdout).
#[derive(Debug, Error)]
pub enum SftpError {
    /// The destination alias failed `is_safe_alias`. Carries the alias so the
    /// command layer can format `INVALID_SFTP_TARGET:<alias>`.
    #[error("{ERR_INVALID_SFTP_TARGET}:{0}")]
    InvalidTarget(String),
    /// A remote path argument failed [`is_safe_remote_path`].
    #[error("{ERR_INVALID_REMOTE_PATH}:{0}")]
    InvalidPath(String),
    /// The `sftp` binary was not found on this machine.
    #[error("sftp client not found")]
    SftpNotFound,
    /// `sftp` exited non-zero; carries its trimmed `LC_ALL=C` stderr.
    #[error("sftp failed: {0}")]
    Remote(String),
    /// A local filesystem error (e.g. listing the local pane, a missing
    /// download target directory).
    #[error("local io error: {0}")]
    LocalIo(String),
    /// A local path argument failed [`is_safe_local_path`] (empty or contains
    /// a NUL/control character).
    #[error("invalid local path")]
    InvalidLocalPath,
    /// A local delete target is a filesystem/user root (`/`, the OS home root,
    /// or a drive root) and is refused as obviously dangerous.
    #[error("refusing to delete a root directory")]
    RefusedRootDelete,
    /// The operation exceeded its wall-clock budget.
    #[error("sftp timed out")]
    Timeout,
    /// Faulted while spawning or waiting on the child process.
    #[error("sftp process error: {0}")]
    Process(String),
}

/// `true` when `path` is safe to embed as a single token in an `sftp` batch
/// script line.
///
/// Rejects, in order of concern:
///   - empty;
///   - a leading `-` (would be parsed as an `sftp` batch-command flag);
///   - any NUL or ASCII control character (line smuggling — a newline would
///     start a second batch command; NUL truncates).
///
/// Everything else is allowed: real remote paths legitimately contain spaces,
/// dots, slashes, unicode, and even quotes. The batch builder QUOTES the path
/// as one `sftp` token, so a space or quote cannot split it — this validator
/// only has to stop the two characters that can break out of a *line*, plus
/// option injection. It deliberately does NOT mirror the alias allow-list:
/// an alias becomes an argv element (option-injection surface), a path becomes
/// a quoted batch token.
pub fn is_safe_remote_path(path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    if path.starts_with('-') {
        return false;
    }
    !path.chars().any(|c| c == '\0' || c.is_ascii_control())
}

/// `true` when `path` is acceptable as a LOCAL filesystem path argument for the
/// left-pane file operations (`list_local_dir`, `local_delete`, `local_rename`,
/// `local_mkdir`).
///
/// These ops are reachable ONLY from the trusted local Tauri frontend (they are
/// Tauri `invoke` commands, never registered as HTTP handlers), so this is a
/// defence-in-depth sanity check rather than a sandbox. It rejects:
///   - the empty string; and
///   - any NUL or ASCII control character (a stray NUL truncates the path at the
///     syscall boundary; control characters never appear in a legitimate path
///     typed by the file manager).
///
/// It deliberately does NOT canonicalize or confine the path — the local pane is
/// meant to browse the whole filesystem with the app's own privileges.
pub fn is_safe_local_path(path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    !path.chars().any(|c| c == '\0' || c.is_ascii_control())
}

/// Critical system directories a recursive delete must always refuse, even
/// though the local pane is otherwise unconfined. These are the standard
/// Unix top-level trees whose removal would brick the OS or another user's
/// account. Compared case-sensitively against the normalised, separator-
/// trimmed path (Unix paths are case-sensitive; the Windows drive-root and
/// `\Windows`/`\Users` cases are handled separately below).
const PROTECTED_SYSTEM_DIRS: &[&str] = &[
    "/bin",
    "/boot",
    "/dev",
    "/etc",
    "/home",
    "/lib",
    "/lib32",
    "/lib64",
    "/libx32",
    "/media",
    "/mnt",
    "/opt",
    "/proc",
    "/root",
    "/run",
    "/sbin",
    "/srv",
    "/sys",
    "/usr",
    "/var",
    "/Applications",
    "/Library",
    "/System",
    "/Users",
    "/private",
    "/Volumes",
];

/// `true` when `path` points at a filesystem, user, or critical system root
/// that a recursive delete must refuse, regardless of platform:
///   - the Unix filesystem root `/`;
///   - a Windows drive root (`C:\`, `C:/`, or a bare `C:`);
///   - the current user's home directory itself (deleting the whole home from
///     a file manager is never the intent — deleting a child of it is fine);
///   - the PARENT of the home directory (e.g. `/home`, `/Users`) — removing it
///     would wipe every user account;
///   - a standard top-level system tree ([`PROTECTED_SYSTEM_DIRS`], plus the
///     Windows `\Windows` / `\Users` / `\Program Files*` roots).
///
/// The comparison trims trailing separators so `"/usr"` and `"/usr/"` are
/// treated alike, and collapses repeated separators. This is a blocklist of
/// dangerous targets, not a full confinement boundary — the local pane is meant
/// to browse and manage the whole filesystem with the app's own privileges, so
/// arbitrary *user* directories outside these trees remain deletable.
pub fn is_root_delete_target(path: &str) -> bool {
    let trimmed = path.trim_end_matches(['/', '\\']);

    // Unix/posix root: the path was only separators (e.g. "/", "///").
    if trimmed.is_empty() {
        return true;
    }

    // Windows drive root: "C:", "C:\", "C:/" — after trimming separators the
    // remainder is a single drive letter followed by a colon.
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() == 2 && chars[0].is_ascii_alphabetic() && chars[1] == ':' {
        return true;
    }

    // Normalise to forward slashes and collapse repeated separators so the
    // blocklist comparisons below are robust to "/usr//", "\\Windows", etc.
    let normalised: String = {
        let mut out = String::with_capacity(trimmed.len());
        let mut prev_sep = false;
        for c in trimmed.chars() {
            let is_sep = c == '/' || c == '\\';
            if is_sep {
                if !prev_sep {
                    out.push('/');
                }
                prev_sep = true;
            } else {
                out.push(c);
                prev_sep = false;
            }
        }
        out
    };

    // Standard Unix/macOS top-level system trees.
    if PROTECTED_SYSTEM_DIRS.contains(&normalised.as_str()) {
        return true;
    }

    // Windows system roots: "<drive>:/Windows", "<drive>:/Users",
    // "<drive>:/Program Files" / "Program Files (x86)" — match the segment
    // after the drive letter, case-insensitively (Windows paths are not
    // case-sensitive).
    if let Some(after_drive) = normalised
        .strip_prefix(|c: char| c.is_ascii_alphabetic())
        .and_then(|rest| rest.strip_prefix(":/"))
    {
        let seg_lower = after_drive.to_ascii_lowercase();
        if matches!(
            seg_lower.as_str(),
            "windows" | "users" | "program files" | "program files (x86)" | "programdata"
        ) {
            return true;
        }
    }

    // The user's home directory itself, and its parent (which holds every
    // user's home).
    #[allow(deprecated)]
    if let Some(home) = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
    {
        let home_str = home.to_string_lossy();
        let home_trimmed = home_str.trim_end_matches(['/', '\\']);
        if !home_trimmed.is_empty() {
            if trimmed == home_trimmed {
                return true;
            }
            // Parent of home (e.g. "/home", "/Users") — strip the final
            // path segment and compare.
            if let Some(idx) = home_trimmed.rfind(['/', '\\']) {
                let parent = &home_trimmed[..idx];
                if !parent.is_empty() && (trimmed == parent || normalised == parent) {
                    return true;
                }
            }
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    // `is_root_delete_target` reads the process-global `HOME`/`USERPROFILE`
    // env vars. Cargo runs the tests in this binary on parallel threads, so the
    // two tests that mutate `HOME` below would otherwise race each other
    // (one's `set_var` clobbering the other's mid-assertion), making them flaky
    // on any machine where the ambient `HOME` isn't `/home/tester`. This mutex
    // serialises every `HOME`-mutating test so they never interleave.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Lock the env guard, recovering from a poisoned mutex so that a panicking
    /// (failing) assertion in one env-mutating test doesn't cascade into false
    /// failures in the others.
    fn lock_env() -> MutexGuard<'static, ()> {
        ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn sentinels_are_pinned() {
        // Mirrored by the JS sentinel matchers in sftpService.ts. Changing
        // these without updating the TS side breaks the error contract.
        assert_eq!(ERR_INVALID_SFTP_TARGET, "INVALID_SFTP_TARGET");
        assert_eq!(ERR_INVALID_REMOTE_PATH, "INVALID_REMOTE_PATH");
    }

    #[test]
    fn invalid_target_error_formats_with_alias() {
        let e = SftpError::InvalidTarget("-oProxyCommand=evil".to_string());
        assert_eq!(e.to_string(), "INVALID_SFTP_TARGET:-oProxyCommand=evil");
    }

    #[test]
    fn invalid_path_error_formats_with_path() {
        let e = SftpError::InvalidPath("-rf".to_string());
        assert_eq!(e.to_string(), "INVALID_REMOTE_PATH:-rf");
    }

    #[test]
    fn accepts_realistic_remote_paths() {
        for p in [
            "/home/user",
            "/var/log/app.log",
            "/home/user/My Documents",
            "relative/dir",
            "/data/файлы/отчёт.txt",
            "/weird/it's a file.txt",
            "/quoted/\"name\".bin",
            ".",
            "..",
        ] {
            assert!(is_safe_remote_path(p), "should accept {p:?}");
        }
    }

    #[test]
    fn rejects_empty_and_leading_dash() {
        assert!(!is_safe_remote_path(""));
        assert!(!is_safe_remote_path("-rf"));
        assert!(!is_safe_remote_path("--"));
    }

    #[test]
    fn rejects_control_chars_and_nul() {
        for p in ["a\nb", "a\rb", "a\tb", "a\0b", "line1\nrm everything"] {
            assert!(!is_safe_remote_path(p), "should reject {p:?}");
        }
    }

    #[test]
    fn local_path_accepts_realistic_paths() {
        for p in [
            "/home/user",
            "/home/user/Documents/file.txt",
            "C:\\Users\\me\\file.txt",
            "relative/dir",
            "/data/файлы/отчёт.txt",
            "/weird/it's a file.txt",
            ".",
            "..",
        ] {
            assert!(is_safe_local_path(p), "should accept {p:?}");
        }
    }

    #[test]
    fn local_path_rejects_empty_and_control_chars() {
        assert!(!is_safe_local_path(""));
        for p in ["a\nb", "a\rb", "a\0b", "a\tb"] {
            assert!(!is_safe_local_path(p), "should reject {p:?}");
        }
    }

    #[test]
    fn root_delete_target_flags_filesystem_root() {
        for p in ["/", "//", "///"] {
            assert!(is_root_delete_target(p), "should flag {p:?}");
        }
    }

    #[test]
    fn root_delete_target_flags_windows_drive_root() {
        for p in ["C:", "C:\\", "C:/", "d:", "Z:\\"] {
            assert!(is_root_delete_target(p), "should flag {p:?}");
        }
    }

    #[test]
    fn root_delete_target_allows_child_paths() {
        for p in [
            "/home/user/Documents",
            "/var/log",
            "C:\\Users\\me",
            "/tmp/scratch/",
            "relative/dir",
        ] {
            assert!(!is_root_delete_target(p), "should allow {p:?}");
        }
    }

    #[test]
    fn root_delete_target_flags_home_root_only() {
        // Serialise with the other HOME-mutating test to avoid a data race on
        // the process-global env var.
        let _guard = lock_env();
        // Drive the check deterministically via $HOME.
        let prev = std::env::var_os("HOME");
        std::env::set_var("HOME", "/home/tester");
        assert!(is_root_delete_target("/home/tester"));
        assert!(is_root_delete_target("/home/tester/")); // trailing slash
        assert!(!is_root_delete_target("/home/tester/Documents"));
        match prev {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }

    #[test]
    fn root_delete_target_flags_home_parent() {
        // Serialise with the other HOME-mutating test to avoid a data race on
        // the process-global env var.
        let _guard = lock_env();
        let prev = std::env::var_os("HOME");
        std::env::set_var("HOME", "/home/tester");
        // The parent of $HOME holds every account — must be refused.
        assert!(is_root_delete_target("/home"));
        assert!(is_root_delete_target("/home/"));
        match prev {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }

    #[test]
    fn root_delete_target_flags_system_dirs() {
        for p in [
            "/etc", "/usr", "/var", "/bin", "/boot", "/lib", "/lib64", "/opt", "/sbin", "/sys",
            "/proc", "/dev", "/root", "/run", "/srv", "/mnt", "/media", "/usr/", "//usr", "/var//",
        ] {
            assert!(is_root_delete_target(p), "should flag system dir {p:?}");
        }
    }

    #[test]
    fn root_delete_target_flags_windows_system_roots() {
        for p in [
            "C:\\Windows",
            "C:/Windows",
            "c:\\windows",
            "C:\\Users",
            "D:\\Program Files",
            "C:\\Program Files (x86)",
            "C:\\ProgramData",
        ] {
            assert!(is_root_delete_target(p), "should flag windows root {p:?}");
        }
    }

    #[test]
    fn root_delete_target_still_allows_legit_subdirs() {
        // Children of system trees and arbitrary user dirs remain deletable —
        // the blocklist guards the roots, not their contents.
        for p in [
            "/var/log/app",
            "/usr/local/share/scratch",
            "/etc/myapp/cache",
            "/home/user/Documents",
            "/opt/tools/build",
            "/data/project",
            "C:\\Users\\me\\Downloads",
            "C:\\Windows\\Temp\\scratch",
        ] {
            assert!(!is_root_delete_target(p), "should allow {p:?}");
        }
    }

    #[test]
    fn entry_kind_round_trips_camel_case() {
        assert_eq!(
            serde_json::to_string(&SftpEntryKind::Symlink).unwrap(),
            "\"symlink\""
        );
        assert_eq!(
            serde_json::to_string(&SftpEntryKind::Dir).unwrap(),
            "\"dir\""
        );
    }
}
