// Store for the "Connections" tab of the Environment view.
//
// Holds the read-only SSH host inventory (parsed from ~/.ssh/config and other
// sources by the backend) plus per-host reachability-check state so the UI can
// render a spinner/result badge per row. All IPC goes through
// `sshConnectionService` — this store never calls `invoke` directly.

import { create } from 'zustand';
import {
  listSshHosts,
  checkSshHost,
  saveSshHost,
  deleteSshHost,
} from '../services/sshConnectionService';
import type {
  SshCheckResult,
  SshHostDraft,
  SshHostView,
  SshInventoryView,
  SshSource,
  SshSourceStatus,
} from '../types/sshHost';

/** Transient per-host check state, keyed by the composite host key. */
export type HostCheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'done'; result: SshCheckResult };

/**
 * Shared stable reference for the "idle" check state. `selectCheckState` must
 * return the SAME object for an unchecked host on every call — returning a
 * fresh `{ kind: 'idle' }` literal would defeat zustand's `Object.is`
 * selector comparison and cause an infinite render loop.
 */
const IDLE_CHECK_STATE: HostCheckState = { kind: 'idle' };

/**
 * Composite host key matching the backend's `SshHostId::key()`
 * (`"<source>:<name>"`). Used both as the metadata key and the per-host
 * check-state map key, so the two layers always agree.
 */
export function hostKey(source: SshSource, name: string): string {
  return `${source}:${name}`;
}

export interface SshHostState {
  hosts: SshHostView[];
  /** Wildcard/pattern blocks (read-only "rules"), shown in a separate section. */
  patterns: SshHostView[];
  sources: SshSourceStatus[];
  isLoading: boolean;
  /** Set when the inventory load itself failed (not a per-source error). */
  loadError: string | null;
  /** Per-host check state, keyed by `hostKey`. Absent entries are `idle`. */
  checks: Record<string, HostCheckState>;

  /** Load (or reload) the full inventory. */
  load: () => Promise<void>;
  /** Probe one host and record the result in `checks`. */
  check: (host: SshHostView) => Promise<void>;
  /**
   * Create or edit a host, applying the refreshed inventory the backend
   * returns. Rejects on validation/IO/read-only errors so the form can show
   * the message inline.
   */
  save: (source: SshSource, draft: SshHostDraft) => Promise<void>;
  /** Delete a host, applying the refreshed inventory the backend returns. */
  remove: (source: SshSource, alias: string) => Promise<void>;
}

/** Apply a fresh inventory payload to the store (hosts + patterns + sources). */
function applyInventory(
  set: (partial: Partial<SshHostState>) => void,
  inventory: SshInventoryView,
): void {
  set({
    hosts: inventory.hosts,
    patterns: inventory.patterns,
    sources: inventory.sources,
    loadError: null,
  });
}

export const useSshHostStore = create<SshHostState>((set) => ({
  hosts: [],
  patterns: [],
  sources: [],
  isLoading: false,
  loadError: null,
  checks: {},

  load: async () => {
    set({ isLoading: true, loadError: null });
    try {
      const inventory = await listSshHosts();
      set({ hosts: inventory.hosts, patterns: inventory.patterns, sources: inventory.sources });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ loadError: message });
    } finally {
      set({ isLoading: false });
    }
  },

  check: async (host) => {
    const key = hostKey(host.id.source, host.id.name);
    set((s) => ({ checks: { ...s.checks, [key]: { kind: 'checking' } } }));
    try {
      const result = await checkSshHost(host.name, key);
      set((s) => ({
        checks: { ...s.checks, [key]: { kind: 'done', result } },
      }));
      // Reflect the fresh result on the host row too (lastCheck* fields), so
      // a later reload isn't required to show the updated badge.
      set((s) => ({
        hosts: s.hosts.map((h) =>
          hostKey(h.id.source, h.id.name) === key
            ? { ...h, lastCheckOk: result.reachable, lastCheckAt: new Date().toISOString() }
            : h,
        ),
      }));
    } catch (err) {
      // The backend's check command does not reject for unreachable hosts;
      // a rejection here is a genuine IPC fault. Surface it as a done-state
      // with a non-reachable result rather than leaving the row spinning.
      const message = err instanceof Error ? err.message : String(err);
      set((s) => ({
        checks: {
          ...s.checks,
          [key]: { kind: 'done', result: { reachable: false, message } },
        },
      }));
    }
  },

  save: async (source, draft) => {
    // Let the error propagate so the form can render it inline; the backend
    // returns the refreshed inventory on success.
    const inventory = await saveSshHost(source, draft);
    applyInventory(set, inventory);
  },

  remove: async (source, alias) => {
    const inventory = await deleteSshHost(source, alias);
    applyInventory(set, inventory);
  },
}));

/** Read a host's current check state (idle when not present). */
export function selectCheckState(
  state: SshHostState,
  source: SshSource,
  name: string,
): HostCheckState {
  return state.checks[hostKey(source, name)] ?? IDLE_CHECK_STATE;
}
