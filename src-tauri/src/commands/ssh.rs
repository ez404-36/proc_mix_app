//! "Environment" view → "Connections" tab: read-only SSH host inventory +
//! editable-source writes and reachability checks.
//!
//! Hosts are parsed read-only from their source of truth (`~/.ssh/config`, …)
//! by `core::ssh`; ProcMix never writes connection parameters except through
//! the explicit `save_ssh_host` / `delete_ssh_host` commands targeting a
//! writable source. The only ProcMix-owned state is the last
//! reachability-check result, stored in `ssh_host_meta` and merged into the
//! view here. The check spawns the system `ssh` in batch mode with a validated
//! alias and a hard timeout (see `core::ssh::check`) — it never blocks on a
//! prompt and is injection-safe.

use tauri::State;

use crate::core::ssh::history as ssh_history;
use crate::storage::DbPool;

/// One host in the inventory view: the parsed connection plus ProcMix's
/// stored metadata (last check result). Mirrors `SshHostView` in
/// `src/types/sshHost.ts`.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostView {
    #[serde(flatten)]
    pub host: crate::core::ssh::SshHost,
    pub last_check_at: Option<String>,
    pub last_check_ok: Option<bool>,
}

/// The full inventory payload: connectable hosts (with merged metadata),
/// wildcard/pattern blocks (read-only "rules"), plus per-source status.
/// Mirrors `SshInventoryView` in `src/types/sshHost.ts`.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshInventoryView {
    pub hosts: Vec<SshHostView>,
    /// Pattern blocks (`Host *`, `*.example.com`, …) shown in a separate
    /// read-only section. Carried as `SshHostView` for a uniform wire shape;
    /// their `lastCheck*` are always null (patterns are never checked).
    pub patterns: Vec<SshHostView>,
    pub sources: Vec<crate::core::ssh::SshSourceStatus>,
}

/// Serializes all writes to `~/.ssh/config` and guards a read from observing
/// a half-applied edit. Held for the whole load→edit→commit cycle so two
/// concurrent `save`/`delete` calls cannot clobber each other, and a
/// `list_ssh_hosts` issued mid-write waits for the consistent result.
static SSH_WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Build the inventory view (parsed hosts + merged metadata + source status).
/// Shared by `list_ssh_hosts` and the write commands, which return the fresh
/// inventory after mutating so the UI updates without a second round-trip.
async fn build_inventory_view(pool: &DbPool) -> Result<SshInventoryView, String> {
    let inventory = tokio::task::spawn_blocking(crate::core::ssh::load_inventory)
        .await
        .map_err(|e| format!("ssh inventory task failed: {e}"))?;

    let meta = crate::storage::ssh_host_meta::load_all(pool).await?;

    let hosts = inventory
        .hosts
        .into_iter()
        .map(|host| {
            let m = meta.get(&host.id.key());
            SshHostView {
                last_check_at: m.and_then(|x| x.last_check_at.clone()),
                last_check_ok: m.and_then(|x| x.last_check_ok),
                host,
            }
        })
        .collect();

    // Patterns are never checked, so they carry no metadata — wrap with null
    // check fields for a uniform wire shape.
    let patterns = inventory
        .patterns
        .into_iter()
        .map(|host| SshHostView {
            last_check_at: None,
            last_check_ok: None,
            host,
        })
        .collect();

    Ok(SshInventoryView {
        hosts,
        patterns,
        sources: inventory.sources,
    })
}

/// List every SSH host discovered across all available sources, merged with
/// each host's stored last-check metadata.
///
/// The parse touches the filesystem (config + includes), so it runs on a
/// blocking pool. Metadata is read from SQLite and joined by the composite
/// host key. Always returns a definitive inventory; a per-source read failure
/// is reported inside `sources[].error`, never as a command error.
#[tauri::command]
pub async fn list_ssh_hosts(pool: State<'_, DbPool>) -> Result<SshInventoryView, String> {
    // Wait for any in-flight write so the list never reflects a half-edit.
    let _guard = SSH_WRITE_LOCK.lock().await;
    build_inventory_view(pool.inner()).await
}

/// Create or edit an editable SSH host in its source file, then return the
/// refreshed inventory.
///
/// Only writable sources (currently `open-ssh-config`) are accepted; a write
/// to a read-only source fails with a clear error. The actual file mutation
/// (validate → surgical edit → backup → atomic write → chmod) runs on a
/// blocking pool under the process-wide write lock.
#[tauri::command]
pub async fn save_ssh_host(
    pool: State<'_, DbPool>,
    watch_state: State<'_, std::sync::Arc<crate::core::ssh::SshWatchState>>,
    source: crate::core::ssh::SshSource,
    draft: crate::core::ssh::SshHostDraft,
) -> Result<SshInventoryView, String> {
    let _guard = SSH_WRITE_LOCK.lock().await;

    let writer = crate::core::ssh::writer_for(source)
        .ok_or_else(|| "this SSH source is read-only".to_string())?;

    // Capture the prior state (for the history "before" snapshot) before the
    // write. The locate alias is the previous name on a rename, else the name.
    let locate = draft
        .previous_name
        .clone()
        .filter(|p| *p != draft.name)
        .unwrap_or_else(|| draft.name.clone());
    let is_rename = draft
        .previous_name
        .as_deref()
        .is_some_and(|p| p != draft.name);
    let before = find_inventory_host(source, &locate).map(|h| ssh_history::snapshot_of(&h));

    let draft_for_write = draft.clone();
    tokio::task::spawn_blocking(move || writer.upsert_host(&draft_for_write))
        .await
        .map_err(|e| format!("ssh write task failed: {e}"))?
        .map_err(|e| e.to_string())?;

    // Record history (best-effort) from the freshly-written state.
    if let Some(after) = find_inventory_host(source, &draft.name) {
        match (is_rename, before) {
            (true, Some(before)) => ssh_history::record_rename(pool.inner(), before, &after).await,
            (_, before) => ssh_history::record_upsert(pool.inner(), before, &after).await,
        }
    }

    // Advance the watcher baseline to the post-write state so the watcher
    // doesn't re-log this same change as external (echo-suppression).
    let next = tokio::task::spawn_blocking(crate::core::ssh::current_snapshot_map)
        .await
        .map_err(|e| format!("ssh snapshot task failed: {e}"))?;
    watch_state.set_baseline(next).await;

    build_inventory_view(pool.inner()).await
}

/// Delete an editable SSH host from its source file, then return the refreshed
/// inventory. Removing a non-existent host is a success (idempotent).
#[tauri::command]
pub async fn delete_ssh_host(
    pool: State<'_, DbPool>,
    watch_state: State<'_, std::sync::Arc<crate::core::ssh::SshWatchState>>,
    source: crate::core::ssh::SshSource,
    alias: String,
) -> Result<SshInventoryView, String> {
    let _guard = SSH_WRITE_LOCK.lock().await;

    let writer = crate::core::ssh::writer_for(source)
        .ok_or_else(|| "this SSH source is read-only".to_string())?;

    // Snapshot before deleting, so history has the removed block.
    let before = find_inventory_host(source, &alias).map(|h| ssh_history::snapshot_of(&h));

    let alias_for_write = alias.clone();
    tokio::task::spawn_blocking(move || writer.delete_host(&alias_for_write))
        .await
        .map_err(|e| format!("ssh write task failed: {e}"))?
        .map_err(|e| e.to_string())?;

    // Only record if the host actually existed (deleting a ghost is a no-op).
    if let Some(before) = before {
        ssh_history::record_delete(pool.inner(), before).await;
    }

    // Echo-suppression: advance the watcher baseline to the post-delete state.
    let next = tokio::task::spawn_blocking(crate::core::ssh::current_snapshot_map)
        .await
        .map_err(|e| format!("ssh snapshot task failed: {e}"))?;
    watch_state.set_baseline(next).await;

    build_inventory_view(pool.inner()).await
}

/// Parse the current inventory and return the single host matching
/// `(source, name)`, if present. Used to snapshot a host's state for history
/// before/after a write. Runs the (blocking) parse synchronously — callers
/// already hold the write lock, and this is a one-off lookup.
fn find_inventory_host(
    source: crate::core::ssh::SshSource,
    name: &str,
) -> Option<crate::core::ssh::SshHost> {
    let inv = crate::core::ssh::load_inventory();
    inv.hosts
        .into_iter()
        .chain(inv.patterns)
        .find(|h| h.id.source == source && h.name == name)
}

/// Probe one host for reachability and persist the result.
///
/// `alias` is the `Host` name to connect to (validated and spawned safely by
/// `core::ssh::check`); `host_key` is the composite `"<source>:<name>"` key
/// under which the result is stored. Returns the check outcome for the UI to
/// render immediately. Never errors on an unreachable host — that is a
/// successful check with `reachable: false`.
#[tauri::command]
pub async fn check_ssh_host(
    pool: State<'_, DbPool>,
    alias: String,
    host_key: String,
) -> Result<crate::core::ssh::SshCheckResult, String> {
    let result = crate::core::ssh::check_alias(&alias).await;

    let at = chrono::Local::now().to_rfc3339();
    // Persisting the result is best-effort: a metadata-write failure must not
    // discard the answer the user just asked for. Surface the check result
    // regardless; the row simply stays stale.
    if let Err(e) =
        crate::storage::ssh_host_meta::record_check(pool.inner(), &host_key, result.reachable, &at)
            .await
    {
        tracing::error!("ssh: failed to persist check for {host_key}: {e}");
    }

    Ok(result)
}
