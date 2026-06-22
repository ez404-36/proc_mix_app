// Typed wrappers around the read-only SSH host inventory Tauri commands.
//
// `invoke` is confined to this service layer (project convention): components
// and stores call these functions, never `invoke` directly.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  SshCheckResult,
  SshHostDraft,
  SshInventoryView,
  SshSource,
} from '../types/sshHost';

/**
 * Tauri event emitted by the backend watcher when a watched SSH config file
 * (`~/.ssh/config`) changes on disk outside ProcMix. Must match
 * `core::ssh::watch::SSH_CONFIG_CHANGED` exactly.
 */
const SSH_CONFIG_CHANGED = 'ssh-config-changed';

/**
 * List every SSH host discovered across all available sources, each merged
 * with its stored last-check metadata, plus per-source status. Always
 * resolves with a definitive inventory; a per-source read failure is reported
 * inside `sources[].error` rather than rejecting.
 */
export async function listSshHosts(): Promise<SshInventoryView> {
  return invoke<SshInventoryView>('list_ssh_hosts');
}

/**
 * Probe one host for reachability and persist the result.
 *
 * @param alias  the `Host` name to connect to (validated/spawned safely in Rust)
 * @param hostKey the composite `"<source>:<name>"` key the result is stored under
 *
 * Resolves with the check outcome; an unreachable host is a successful check
 * with `reachable: false`, not a rejection.
 */
export async function checkSshHost(
  alias: string,
  hostKey: string,
): Promise<SshCheckResult> {
  return invoke<SshCheckResult>('check_ssh_host', { alias, hostKey });
}

/**
 * Create or edit an editable host in `source`, returning the refreshed
 * inventory. Rejects when the source is read-only or validation/IO fails.
 */
export async function saveSshHost(
  source: SshSource,
  draft: SshHostDraft,
): Promise<SshInventoryView> {
  return invoke<SshInventoryView>('save_ssh_host', { source, draft });
}

/**
 * Delete an editable host from `source`, returning the refreshed inventory.
 * Deleting a non-existent host succeeds (idempotent).
 */
export async function deleteSshHost(
  source: SshSource,
  alias: string,
): Promise<SshInventoryView> {
  return invoke<SshInventoryView>('delete_ssh_host', { source, alias });
}

/**
 * Subscribe to "an SSH config file changed on disk outside ProcMix" events.
 * Invokes `handler` whenever the backend watcher detects a change to
 * `~/.ssh/config`, so the UI can re-fetch the inventory.
 *
 * Returns a cleanup function that detaches the listener. The Tauri listener is
 * attached asynchronously; the returned cleanup awaits and detaches it safely
 * even if called before attachment completes.
 */
export function subscribeSshConfigChanges(handler: () => void): () => void {
  const unlistenPromise = listen(SSH_CONFIG_CHANGED, () => handler());
  unlistenPromise.catch((err) => {
    console.error('ssh-config-changed listener failed to attach:', err);
  });
  return () => {
    void unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
  };
}
