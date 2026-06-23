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

#[cfg(test)]
mod tests {
    use super::*;

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
