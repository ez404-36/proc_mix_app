// Store for the "Environment" view.
//
// The view now shows two read-only snapshots:
//   - User scope: current process env + source detection from known shell
//     startup files (no sudo required).
//   - Root scope: `sudo env` output + source detection from root files.
//     The Tauri command returns ADMIN_PASSWORD_REQUIRED when no password
//     is stored; the store exposes that state so the UI can show a
//     "Enter admin password" affordance without a generic error toast.
//
// There are no longer any writable .env-file operations in this store.
// Those belonged to the old "global .env manager" concept that was replaced.

import { create } from 'zustand';
import { isAdminPasswordRequiredError } from '../utils/adminPassword';
import {
  getUserEnvWithSources,
  getRootEnvWithSources,
} from '../services/envSnapshotService';
import type { EnvSnapshot } from '../types/envSnapshot';

export type RootState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  /** Password is in the keychain — snapshot was loaded successfully. */
  | { kind: 'loaded'; snapshot: EnvSnapshot }
  /** Keychain has no password — UI shows "Enter admin password" button. */
  | { kind: 'no_password' }
  /** sudo ran but reported a wrong password or another auth failure. */
  | { kind: 'error'; message: string };

export interface EnvManagerState {
  userSnapshot: EnvSnapshot | null;
  isUserLoading: boolean;

  rootState: RootState;

  /** Load (or reload) the user-scope snapshot. */
  loadUser: () => Promise<void>;
  /**
   * Load (or reload) the root-scope snapshot.
   *
   * If the Tauri command signals ADMIN_PASSWORD_REQUIRED, the state
   * transitions to `no_password` — the caller does NOT need to handle
   * this case specially; the store drives the UI affordance.
   */
  loadRoot: () => Promise<void>;
}

export const useEnvManagerStore = create<EnvManagerState>((set) => ({
  userSnapshot: null,
  isUserLoading: false,
  rootState: { kind: 'idle' },

  loadUser: async () => {
    set({ isUserLoading: true });
    try {
      const snapshot = await getUserEnvWithSources();
      set({ userSnapshot: snapshot });
    } finally {
      set({ isUserLoading: false });
    }
  },

  loadRoot: async () => {
    set({ rootState: { kind: 'loading' } });
    try {
      const snapshot = await getRootEnvWithSources();
      set({ rootState: { kind: 'loaded', snapshot } });
    } catch (err) {
      if (isAdminPasswordRequiredError(err)) {
        set({ rootState: { kind: 'no_password' } });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        set({ rootState: { kind: 'error', message } });
      }
    }
  },
}));
