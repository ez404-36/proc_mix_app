//! Background watcher that re-notifies the UI when an SSH config file changes
//! on disk OUTSIDE ProcMix (edited in a terminal, VS Code, etc.).
//!
//! ## Why polling, not `notify`
//!
//! These config files change rarely and a second of latency is irrelevant, so
//! a tiny mtime poll is more than adequate — and it deliberately avoids a new
//! `notify` crate dependency plus its well-known gotchas (editors replace a
//! file via atomic rename, which breaks a file-level inotify watch; you then
//! have to watch the directory and debounce). Polling the files' modification
//! times sidesteps all of that with a few lines and no dependency.
//!
//! ## What it emits
//!
//! On any observed change to the set of watched files (mtime or
//! existence/size), it emits the [`SSH_CONFIG_CHANGED`] Tauri event with no
//! payload. The frontend listens and re-runs `list_ssh_hosts` to refresh the
//! Connections tab. We never read or forward file CONTENT here — only the fact
//! that something changed — so this carries nothing sensitive.
//!
//! The task runs for the lifetime of the process (same lifecycle as the
//! scheduler loop). ProcMix's OWN writes also bump the mtime and will emit an
//! event; that simply triggers a harmless refresh that reproduces the state
//! the UI already applied from the write command's return value.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::Mutex;

use crate::core::ssh::history::{self, ExternalChange};
use crate::storage::history::SshHostSnapshot;
use crate::storage::DbPool;

/// Tauri event channel signalling that a watched SSH config file changed on
/// disk. No payload. Mirrors the `CAPTURE_EVENT` channel-name convention; the
/// TS side subscribes via `subscribeSshConfigChanges`
/// (`src/services/sshConnectionService.ts`).
pub const SSH_CONFIG_CHANGED: &str = "ssh-config-changed";

/// How often to poll the watched files' mtimes. A config file is edited by a
/// human at most every few seconds, so this is imperceptible yet cheap.
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// A per-file fingerprint used to detect change without reading content:
/// `(exists, modified-time, size)`. A file appearing, disappearing, being
/// touched, or changing size all flip the fingerprint.
type FileStamp = (bool, Option<SystemTime>, u64);

/// The set of files we watch. Currently the user's `~/.ssh/config`; the
/// system config rarely changes at runtime but is cheap to include.
fn watched_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".ssh").join("config"));
    }
    paths
}

/// Stat one path into a [`FileStamp`]. A missing file is a valid stamp
/// (`exists = false`), so creating the file later is detected as a change.
fn stamp(path: &PathBuf) -> FileStamp {
    match std::fs::metadata(path) {
        Ok(meta) => (true, meta.modified().ok(), meta.len()),
        Err(_) => (false, None, 0),
    }
}

/// Compute the fingerprint of the whole watched set.
fn fingerprint(paths: &[PathBuf]) -> Vec<FileStamp> {
    paths.iter().map(stamp).collect()
}

/// Shared baseline of the inventory's last-known state, keyed by host key.
///
/// Both the watcher AND the `save_ssh_host`/`delete_ssh_host` commands update
/// this. That is the **echo-suppression** mechanism: after ProcMix writes the
/// config it updates the baseline to the post-write state itself, so when the
/// watcher subsequently observes that same file change and diffs against the
/// (already-updated) baseline it finds nothing — our own write is not logged
/// as an external change. The watcher only records genuine external edits.
///
/// Managed as Tauri state (`Arc<SshWatchState>`).
#[derive(Default)]
pub struct SshWatchState {
    baseline: Mutex<HashMap<String, SshHostSnapshot>>,
}

impl SshWatchState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Overwrite the baseline with a fresh snapshot map. Called by the write
    /// commands after a successful mutation (echo-suppression) and by the
    /// watcher after diffing.
    pub async fn set_baseline(&self, snapshot: HashMap<String, SshHostSnapshot>) {
        *self.baseline.lock().await = snapshot;
    }
}

/// Snapshot the current inventory (hosts + patterns) into a key→snapshot map.
/// Pure read of the filesystem via the providers; runs on a blocking pool by
/// the caller.
pub fn current_snapshot_map() -> HashMap<String, SshHostSnapshot> {
    let inv = crate::core::ssh::load_inventory();
    inv.hosts
        .iter()
        .chain(inv.patterns.iter())
        .map(|h| (h.id.key(), history::snapshot_of(h)))
        .collect()
}

/// Spawn the watcher task. Returns immediately; the task lives for the process
/// lifetime. Call once from the Tauri `setup` hook.
pub fn spawn_ssh_config_watch<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let paths = watched_paths();
        if paths.is_empty() {
            // No resolvable home → nothing to watch; the manual Refresh button
            // still works. Exit quietly.
            return;
        }

        let pool = app.state::<DbPool>().inner().clone();
        let watch_state = app.state::<Arc<SshWatchState>>().inner().clone();

        // Seed the baseline with the inventory at startup so the first
        // external change diffs against a real prior state (and a host already
        // present at launch isn't logged as "discovered").
        let initial = tokio::task::spawn_blocking(current_snapshot_map)
            .await
            .unwrap_or_default();
        watch_state.set_baseline(initial).await;

        let mut last = fingerprint(&paths);
        let mut ticker = tokio::time::interval(POLL_INTERVAL);
        // The first tick fires immediately; skip it so we don't act at startup.
        ticker.tick().await;

        loop {
            ticker.tick().await;
            let current = fingerprint(&paths);
            if current == last {
                continue;
            }
            last = current;

            // Diff the new inventory against the shared baseline and record any
            // EXTERNAL changes. ProcMix's own writes have already advanced the
            // baseline, so they produce no diff here (echo-suppressed).
            let next = tokio::task::spawn_blocking(current_snapshot_map)
                .await
                .unwrap_or_default();
            let changes = {
                let baseline = watch_state.baseline.lock().await;
                history::diff_snapshots(&baseline, &next)
            };
            for change in changes {
                log_external(&pool, change).await;
            }
            watch_state.set_baseline(next).await;

            // Notify the UI to refresh regardless of whether anything was
            // logged (the inventory may have changed in ways we don't log).
            if let Err(e) = app.emit(SSH_CONFIG_CHANGED, ()) {
                tracing::error!("ssh watch: failed to emit change event: {e}");
            }
        }
    });
}

/// Record one external change to history (best-effort).
async fn log_external(pool: &DbPool, change: ExternalChange) {
    history::record_external(pool, change).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn stamp_distinguishes_missing_from_present() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");

        let missing = stamp(&path);
        assert!(!missing.0, "missing file → exists=false");

        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(b"Host a\n").unwrap();
        drop(f);

        let present = stamp(&path);
        assert!(present.0, "created file → exists=true");
        assert_ne!(missing, present);
    }

    #[test]
    fn fingerprint_changes_when_a_file_changes_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        std::fs::write(&path, b"Host a\n").unwrap();
        let paths = vec![path.clone()];

        let before = fingerprint(&paths);
        std::fs::write(&path, b"Host a\nHost b\n").unwrap();
        let after = fingerprint(&paths);

        assert_ne!(before, after, "size change must flip the fingerprint");
    }

    #[test]
    fn fingerprint_is_stable_when_nothing_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        std::fs::write(&path, b"Host a\n").unwrap();
        let paths = vec![path];

        let a = fingerprint(&paths);
        let b = fingerprint(&paths);
        assert_eq!(a, b);
    }

    #[test]
    fn event_name_is_pinned() {
        // The frontend subscribes to this exact string; pin it.
        assert_eq!(SSH_CONFIG_CHANGED, "ssh-config-changed");
    }
}
