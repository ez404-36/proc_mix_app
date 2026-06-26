// Store for the Plugins section (Phase 1).
//
// Holds the discovered plugin list and the loading/error state. All IPC goes
// through `pluginService` — this store never calls `invoke` directly. Phase 1
// only lists/toggles/removes plugins; nothing executes plugin code.

import { create } from "zustand";
import {
  installPluginVersion,
  listPluginCatalog,
  listPlugins,
  removePlugin,
  setPluginEnabled,
} from "../services/pluginService";
import type { CatalogPlugin, PluginView } from "../types/plugin";

export interface PluginStoreState {
  /** Discovered (installed) plugins, deduplicated and status-annotated. */
  plugins: PluginView[];
  /** Catalog of installable plugins (with their versions). */
  catalog: CatalogPlugin[];
  isLoading: boolean;
  /** Name of the catalog plugin currently being installed, or null. */
  installing: string | null;
  /** Set when the last load/toggle/remove/install surfaced an error. */
  error: string | null;

  /** Load installed plugins + the catalog from the backend. */
  load: () => Promise<void>;
  /** Toggle a plugin's enabled flag, then reload to reflect the new status. */
  setEnabled: (pluginId: string, enabled: boolean) => Promise<void>;
  /** Remove a user plugin, then reload. */
  remove: (pluginId: string) => Promise<void>;
  /**
   * Install a specific version of a catalog plugin (also serves update and
   * rollback), then reload. Throws on failure so the caller can surface it.
   */
  install: (name: string, version: string) => Promise<void>;
}

/** Normalise an unknown thrown value into a message string. */
function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const usePluginStore = create<PluginStoreState>((set, get) => ({
  plugins: [],
  catalog: [],
  isLoading: false,
  installing: null,
  error: null,

  load: async () => {
    set({ isLoading: true, error: null });
    try {
      const [plugins, catalog] = await Promise.all([
        listPlugins(),
        listPluginCatalog(),
      ]);
      set({ plugins, catalog });
    } catch (err) {
      set({ error: toMessage(err) });
    } finally {
      set({ isLoading: false });
    }
  },

  setEnabled: async (pluginId, enabled) => {
    set({ error: null });
    try {
      await setPluginEnabled(pluginId, enabled);
      await get().load();
    } catch (err) {
      set({ error: toMessage(err) });
    }
  },

  remove: async (pluginId) => {
    set({ error: null });
    try {
      await removePlugin(pluginId);
      await get().load();
    } catch (err) {
      set({ error: toMessage(err) });
    }
  },

  install: async (name, version) => {
    set({ installing: name, error: null });
    try {
      await installPluginVersion(name, version);
      await get().load();
    } catch (err) {
      set({ error: toMessage(err) });
      throw err;
    } finally {
      set({ installing: null });
    }
  },
}));
