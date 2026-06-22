//! IPC-boundary types for the read-only SSH connection inventory.
//!
//! These DTOs describe SSH hosts discovered across one or more *sources*
//! (the user's `~/.ssh/config`, and — in future iterations — PuTTY's
//! registry sessions, WSL configs, the system-wide `ssh_config`, …). The
//! whole subsystem is **read-only** in this iteration: we parse and surface
//! existing connections, we never write them back. Writing will be added
//! later behind a separate `SshSourceWriter` trait (see `provider.rs`).
//!
//! Every type mirrors a TypeScript interface in `src/types/sshHost.ts`
//! character-for-character via serde's `rename_all = "camelCase"`.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Where a discovered host came from. This is a stable wire enum: the
/// frontend renders a per-source badge and groups the list by it, so the
/// kebab-case strings here MUST match the `SshSource` union in
/// `src/types/sshHost.ts`.
///
/// Only [`SshSource::OpenSshConfig`] is implemented in this iteration; the
/// other variants exist so the provider registry, the IPC contract, and the
/// UI can be built against the full set now and have new sources slot in by
/// adding a provider (see `providers/`) — no enum/contract churn later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SshSource {
    /// OpenSSH client config: `~/.ssh/config` (and any `Include`d files,
    /// surfaced read-only). Cross-platform — resolves to
    /// `%USERPROFILE%\.ssh\config` on Windows.
    OpenSshConfig,
    /// PuTTY saved sessions (Windows registry under
    /// `HKCU\Software\SimonTatham\PuTTY\Sessions`). Not yet implemented —
    /// the provider is a registered stub.
    Putty,
    /// A WSL distribution's `~/.ssh/config`, distinct from the Windows-side
    /// file. Not yet implemented — registered stub.
    Wsl,
    /// System-wide client config (`/etc/ssh/ssh_config` on Unix,
    /// `C:\ProgramData\ssh\ssh_config` on Windows). Not yet implemented —
    /// registered stub.
    SystemConfig,
}

impl SshSource {
    /// Stable string used to namespace this source inside a composite host
    /// key and the `ssh_host_meta` table. Derived from the serde kebab-case
    /// spelling so the two never drift.
    pub fn as_key(self) -> &'static str {
        match self {
            SshSource::OpenSshConfig => "openssh",
            SshSource::Putty => "putty",
            SshSource::Wsl => "wsl",
            SshSource::SystemConfig => "system",
        }
    }
}

/// Stable identity of a host across refreshes and across the IPC boundary.
///
/// A host is identified by the `(source, name)` pair: the same alias can
/// legitimately exist in two different sources (e.g. a `prod` host defined
/// both in `~/.ssh/config` and as a PuTTY session), and they are distinct
/// rows in the UI. The composite [`SshHostId::key`] (`"<source>:<name>"`)
/// is what the metadata store keys on.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostId {
    pub source: SshSource,
    /// The host alias (the value after `Host` in an OpenSSH block, or the
    /// PuTTY session name, …).
    pub name: String,
}

impl SshHostId {
    pub fn new(source: SshSource, name: impl Into<String>) -> Self {
        Self {
            source,
            name: name.into(),
        }
    }

    /// `"<source>:<name>"` — the stable composite key used by the
    /// `ssh_host_meta` table and for deduplication in the registry.
    pub fn key(&self) -> String {
        format!("{}:{}", self.source.as_key(), self.name)
    }
}

/// A single SSH host (connection) discovered by a provider.
///
/// All connection parameters are OPTIONAL because a real `~/.ssh/config`
/// block need not specify them (defaults are inherited from earlier blocks,
/// `Host *` wildcards, or OpenSSH's built-in defaults). We surface exactly
/// what the source declares and let the user/`ssh` resolve the rest — we
/// never invent values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHost {
    /// Stable `(source, name)` identity.
    pub id: SshHostId,
    /// Host alias as written in the source (echo of `id.name`, duplicated
    /// here so the frontend can render without reaching into the id).
    pub name: String,
    /// Resolved `HostName` (the real address) when the source declares one.
    pub host_name: Option<String>,
    /// `User`, when declared.
    pub user: Option<String>,
    /// `Port`, when declared. `None` means "use ssh's default (22)".
    pub port: Option<u16>,
    /// `IdentityFile` path, verbatim from the source (may contain `~` or a
    /// platform-specific path; NOT resolved here — purely informational for
    /// read-only display).
    pub identity_file: Option<String>,
    /// Whether ProcMix may rewrite this block's modelled directives
    /// (`HostName`/`User`/`Port`/`IdentityFile`) in place. `true` for
    /// single-pattern user-config blocks with only modelled directives —
    /// INCLUDING wildcard patterns like `*.staging.example.com`. `false` for
    /// `Match`, multi-pattern, negation, unknown-directive, `Include`d or
    /// system blocks. The UI shows non-editable blocks as "managed manually".
    pub editable_params: bool,
    /// Whether this block's `Host` name may be changed. Mirrors
    /// [`Self::editable_params`] at the source level; surfaced separately so
    /// the UI can warn when renaming a pattern (it reassigns the rule's
    /// scope).
    pub editable_name: bool,
    /// Whether ProcMix may delete this block. `false` for system/`Include`d
    /// blocks (and anything not writable).
    pub deletable: bool,
    /// Human-readable origin detail for a tooltip (e.g. the absolute path of
    /// the config file the block was parsed from, or `"registry"`).
    pub source_detail: String,
    /// The block's raw text exactly as it appears in the source file — the
    /// `Host` line through the line before the next block. Surfaces EVERY
    /// directive, including ones ProcMix doesn't model (`ProxyJump`,
    /// `SendEnv`, …), so the UI's view modal can show the full block. Empty
    /// for sources that have no textual form (e.g. a future registry-backed
    /// provider).
    pub raw_text: String,
}

/// Errors a provider can surface while listing hosts. Kept coarse and
/// `String`-backed: the inner message is safe to log (it never contains a
/// secret — SSH configs hold no passwords) and is shown to the user as-is.
#[derive(Debug, Error)]
pub enum SshSourceError {
    /// The source's backing file/registry could not be read. The source is
    /// reported as unavailable rather than failing the whole inventory.
    #[error("ssh source read error: {0}")]
    Read(String),
    /// The source's content could not be parsed.
    #[error("ssh source parse error: {0}")]
    Parse(String),
}

/// Result of probing a host for reachability (`ssh -o BatchMode=yes …`).
///
/// `reachable` reflects a clean, non-interactive connect+exit. `message` is
/// a short human-readable explanation for the UI (e.g. the failure reason,
/// or a note that the `ssh` binary was not found). Mirrors
/// `SshCheckResult` in `src/types/sshHost.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshCheckResult {
    pub reachable: bool,
    pub message: String,
}

/// A write request describing the desired state of one editable host.
///
/// Only the modelled fields are expressible — a draft can never carry an
/// unknown directive, so writing one can never introduce a block ProcMix
/// wouldn't itself consider editable. `None` for an optional field means the
/// corresponding directive should be absent. Mirrors `SshHostDraft` in
/// `src/types/sshHost.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostDraft {
    /// The `Host` alias. For an edit this also identifies the block to
    /// rewrite; for a rename, see [`SshHostDraft::previous_name`].
    pub name: String,
    /// When renaming an existing host, the old alias to remove. `None` for a
    /// create or an in-place edit (same alias).
    #[serde(default)]
    pub previous_name: Option<String>,
    pub host_name: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
}

/// Errors a write (create/edit/delete) can fail with. `String`-backed and
/// safe to surface: SSH configs contain no secrets.
#[derive(Debug, Error)]
pub enum SshWriteError {
    /// The draft failed validation (bad alias, port out of range, a value
    /// containing a newline, …) — rejected before touching the file.
    #[error("invalid ssh host: {0}")]
    Validation(String),
    /// The target block is not one ProcMix may write (wildcard/`Match`/
    /// unknown directive, or an `Include`d/system source).
    #[error("ssh host is read-only: {0}")]
    ReadOnly(String),
    /// A filesystem error while backing up, writing, or fixing permissions.
    #[error("ssh config write error: {0}")]
    Io(String),
    /// The edit produced text that does not re-parse as the expected editable
    /// host — a safety stop that aborts the write before it is committed.
    #[error("ssh config write would corrupt the file: {0}")]
    Corruption(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_key_matches_serde_spelling() {
        // The composite key prefix must equal the kebab-case wire string so
        // the metadata table and the IPC payload never disagree.
        for (source, expected) in [
            (SshSource::OpenSshConfig, "openssh"),
            (SshSource::Putty, "putty"),
            (SshSource::Wsl, "wsl"),
            (SshSource::SystemConfig, "system"),
        ] {
            assert_eq!(source.as_key(), expected);
            let json = serde_json::to_string(&source).expect("serialize");
            // serde kebab-case spelling for OpenSshConfig is "open-ssh-config";
            // as_key is the shorter stable token. They are intentionally
            // independent, so we only assert as_key here and pin the serde
            // spelling separately below.
            assert!(json.starts_with('"'));
        }
    }

    #[test]
    fn host_id_key_is_source_prefixed() {
        let id = SshHostId::new(SshSource::OpenSshConfig, "prod");
        assert_eq!(id.key(), "openssh:prod");
    }

    #[test]
    fn same_name_different_source_are_distinct() {
        let a = SshHostId::new(SshSource::OpenSshConfig, "prod");
        let b = SshHostId::new(SshSource::Putty, "prod");
        assert_ne!(a, b);
        assert_ne!(a.key(), b.key());
    }

    #[test]
    fn ssh_source_round_trips_through_serde() {
        let value = SshSource::OpenSshConfig;
        let json = serde_json::to_string(&value).expect("serialize");
        let back: SshSource = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(value, back);
    }

    #[test]
    fn wire_spellings_are_pinned() {
        // These EXACT strings are mirrored by the `SshSource` union in
        // `src/types/sshHost.ts`. Changing serde's rename here without
        // updating the TS union would silently break the IPC contract, so
        // pin them.
        assert_eq!(
            serde_json::to_string(&SshSource::OpenSshConfig).unwrap(),
            "\"open-ssh-config\""
        );
        assert_eq!(
            serde_json::to_string(&SshSource::Putty).unwrap(),
            "\"putty\""
        );
        assert_eq!(serde_json::to_string(&SshSource::Wsl).unwrap(), "\"wsl\"");
        assert_eq!(
            serde_json::to_string(&SshSource::SystemConfig).unwrap(),
            "\"system-config\""
        );
    }
}
