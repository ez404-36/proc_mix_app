//! Recording SSH connection changes into the shared action history.
//!
//! Two producers feed this module:
//!   - the `save_ssh_host` / `delete_ssh_host` commands, for changes made
//!     INSIDE ProcMix (`Added` / `Edited` / `Deleted`);
//!   - the config watcher's diff, for changes detected OUTSIDE ProcMix
//!     (`Discovered` / `EditedExternally` / `DeletedExternally`).
//!
//! A rename is always recorded as a delete of the old name + an add of the
//! new one (the file edit itself stays in place — see `openssh_edit`). For an
//! external diff this is the only reliable interpretation: we cannot tell a
//! rename from independent delete+create just by comparing two file states.
//!
//! Snapshots and id/timestamp generation happen server-side here (unlike the
//! frontend-driven command/workflow history), because the watcher has no
//! frontend to originate the event.

use crate::core::ssh::types::{SshHost, SshSource};
use crate::storage::history::{HistoryEvent, HistoryEventPayload, SshHostSnapshot};
use crate::storage::DbPool;

/// `true` when a host name is a wildcard/pattern rather than a concrete alias.
fn is_pattern(name: &str) -> bool {
    name.contains('*') || name.contains('?') || name.starts_with('!')
}

/// Build the compact history snapshot from a parsed host.
pub fn snapshot_of(host: &SshHost) -> SshHostSnapshot {
    SshHostSnapshot {
        host_key: host.id.key(),
        name: host.name.clone(),
        source: host.id.source.as_key().to_string(),
        host_name: host.host_name.clone(),
        user: host.user.clone(),
        port: host.port,
        identity_file: host.identity_file.clone(),
        is_pattern: is_pattern(&host.name),
        raw_text: host.raw_text.clone(),
    }
}

/// Source token for OpenSSH user-config writes (the only writable source).
pub fn openssh_source_key() -> &'static str {
    SshSource::OpenSshConfig.as_key()
}

/// Wrap a payload into a `HistoryEvent` with a fresh id and timestamp.
fn event(payload: HistoryEventPayload) -> HistoryEvent {
    HistoryEvent {
        id: uuid::Uuid::new_v4().to_string(),
        created_at: chrono::Local::now().to_rfc3339(),
        payload,
    }
}

/// Best-effort insert: a history write must never fail the user's actual SSH
/// operation, so errors are logged and swallowed.
async fn record(pool: &DbPool, payload: HistoryEventPayload) {
    let evt = event(payload);
    if let Err(e) = crate::storage::history::insert_event(pool, &evt).await {
        tracing::error!("ssh history: failed to record event: {e}");
    }
}

// ---------------------------------------------------------------------------
// ProcMix-originated events (from the save/delete commands).
// ---------------------------------------------------------------------------

/// Record an `Added` or `Edited` event for a ProcMix write. `before` is the
/// host's prior snapshot when it already existed (an edit), else `None` (a
/// create).
pub async fn record_upsert(pool: &DbPool, before: Option<SshHostSnapshot>, after: &SshHost) {
    let after_snap = snapshot_of(after);
    let payload = match before {
        Some(before) => HistoryEventPayload::SshHostEdited {
            host_key: after_snap.host_key.clone(),
            host_name: after_snap.name.clone(),
            snapshot_before: before,
            snapshot_after: after_snap,
        },
        None => HistoryEventPayload::SshHostAdded {
            host_key: after_snap.host_key.clone(),
            host_name: after_snap.name.clone(),
            snapshot_after: after_snap,
        },
    };
    record(pool, payload).await;
}

/// Record a rename as a delete of the old block + an add of the new one.
pub async fn record_rename(pool: &DbPool, before: SshHostSnapshot, after: &SshHost) {
    record(
        pool,
        HistoryEventPayload::SshHostDeleted {
            host_key: before.host_key.clone(),
            host_name: before.name.clone(),
            snapshot_before: before,
        },
    )
    .await;
    let after_snap = snapshot_of(after);
    record(
        pool,
        HistoryEventPayload::SshHostAdded {
            host_key: after_snap.host_key.clone(),
            host_name: after_snap.name.clone(),
            snapshot_after: after_snap,
        },
    )
    .await;
}

/// Record a ProcMix delete.
pub async fn record_delete(pool: &DbPool, before: SshHostSnapshot) {
    record(
        pool,
        HistoryEventPayload::SshHostDeleted {
            host_key: before.host_key.clone(),
            host_name: before.name.clone(),
            snapshot_before: before,
        },
    )
    .await;
}

// ---------------------------------------------------------------------------
// External diff (from the watcher).
// ---------------------------------------------------------------------------

/// One external change derived from diffing two inventory snapshots.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExternalChange {
    Discovered(SshHostSnapshot),
    Edited {
        before: SshHostSnapshot,
        after: SshHostSnapshot,
    },
    Deleted(SshHostSnapshot),
}

/// Diff a previous against a current set of snapshots (keyed by host key) and
/// return the external changes. A key present only in `current` is a
/// discovery; only in `previous` is a deletion; in both with different content
/// is an edit. Pure — no IO — so it is unit-testable.
pub fn diff_snapshots(
    previous: &std::collections::HashMap<String, SshHostSnapshot>,
    current: &std::collections::HashMap<String, SshHostSnapshot>,
) -> Vec<ExternalChange> {
    let mut changes = Vec::new();

    // Discovered + Edited: walk current.
    for (key, cur) in current {
        match previous.get(key) {
            None => changes.push(ExternalChange::Discovered(cur.clone())),
            Some(prev) if prev != cur => changes.push(ExternalChange::Edited {
                before: prev.clone(),
                after: cur.clone(),
            }),
            Some(_) => {}
        }
    }
    // Deleted: keys gone from current.
    for (key, prev) in previous {
        if !current.contains_key(key) {
            changes.push(ExternalChange::Deleted(prev.clone()));
        }
    }
    changes
}

/// Record one external change to history.
pub async fn record_external(pool: &DbPool, change: ExternalChange) {
    let payload = match change {
        ExternalChange::Discovered(s) => HistoryEventPayload::SshHostDiscovered {
            host_key: s.host_key.clone(),
            host_name: s.name.clone(),
            snapshot_after: s,
        },
        ExternalChange::Edited { before, after } => HistoryEventPayload::SshHostEditedExternally {
            host_key: after.host_key.clone(),
            host_name: after.name.clone(),
            snapshot_before: before,
            snapshot_after: after,
        },
        ExternalChange::Deleted(s) => HistoryEventPayload::SshHostDeletedExternally {
            host_key: s.host_key.clone(),
            host_name: s.name.clone(),
            snapshot_before: s,
        },
    };
    record(pool, payload).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn snap(key: &str, user: Option<&str>) -> SshHostSnapshot {
        SshHostSnapshot {
            host_key: key.to_string(),
            name: key.split(':').nth(1).unwrap_or(key).to_string(),
            source: "open-ssh-config".into(),
            host_name: Some("h".into()),
            user: user.map(|s| s.to_string()),
            port: None,
            identity_file: None,
            is_pattern: false,
            raw_text: format!("Host {key}"),
        }
    }

    fn map(items: &[SshHostSnapshot]) -> HashMap<String, SshHostSnapshot> {
        items
            .iter()
            .map(|s| (s.host_key.clone(), s.clone()))
            .collect()
    }

    #[test]
    fn diff_detects_discovery() {
        let prev = map(&[]);
        let cur = map(&[snap("openssh:new", Some("u"))]);
        let changes = diff_snapshots(&prev, &cur);
        assert_eq!(changes.len(), 1);
        assert!(matches!(changes[0], ExternalChange::Discovered(_)));
    }

    #[test]
    fn diff_detects_deletion() {
        let prev = map(&[snap("openssh:gone", Some("u"))]);
        let cur = map(&[]);
        let changes = diff_snapshots(&prev, &cur);
        assert_eq!(changes.len(), 1);
        assert!(matches!(changes[0], ExternalChange::Deleted(_)));
    }

    #[test]
    fn diff_detects_edit() {
        let prev = map(&[snap("openssh:h", Some("old"))]);
        let cur = map(&[snap("openssh:h", Some("new"))]);
        let changes = diff_snapshots(&prev, &cur);
        assert_eq!(changes.len(), 1);
        match &changes[0] {
            ExternalChange::Edited { before, after } => {
                assert_eq!(before.user.as_deref(), Some("old"));
                assert_eq!(after.user.as_deref(), Some("new"));
            }
            other => panic!("expected Edited, got {other:?}"),
        }
    }

    #[test]
    fn diff_ignores_unchanged() {
        let prev = map(&[snap("openssh:h", Some("u"))]);
        let cur = map(&[snap("openssh:h", Some("u"))]);
        assert!(diff_snapshots(&prev, &cur).is_empty());
    }

    #[test]
    fn diff_reports_rename_as_delete_plus_discover() {
        // External rename old→new: old key gone, new key appears.
        let prev = map(&[snap("openssh:old", Some("u"))]);
        let cur = map(&[snap("openssh:new", Some("u"))]);
        let changes = diff_snapshots(&prev, &cur);
        assert_eq!(changes.len(), 2);
        assert!(changes
            .iter()
            .any(|c| matches!(c, ExternalChange::Discovered(s) if s.host_key == "openssh:new")));
        assert!(changes
            .iter()
            .any(|c| matches!(c, ExternalChange::Deleted(s) if s.host_key == "openssh:old")));
    }
}
