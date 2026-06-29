// Store for the built-in HTTP server mini-panel.
//
// Holds the server's live status, persisted config, token-presence flag, and a
// capped tail of the request log. All IPC goes through `httpServerService` —
// this store never calls `invoke` directly. The live request log is appended by
// the `useHttpServerBridge` hook from the `http-server-log` Tauri event; the
// initial snapshot is loaded once via {@link HttpServerState.load}.

import { create } from "zustand";
import {
  clearApiToken,
  clearRequestLog,
  getApiTokenStatus,
  getHttpServerConfig,
  getHttpServerStatus,
  listRequestLog,
  regenerateApiToken,
  setHttpServerConfig,
  startHttpServer,
  stopHttpServer,
} from "../services/httpServerService";
import type {
  HttpServerConfig,
  HttpServerStatus,
  RequestLogEntry,
} from "../types/httpServer";
import { useUIStore } from "./uiStore";

/**
 * Resolve the app's current UI language for the web-UI locale snapshot. The
 * desktop language lives in `uiStore`; the backend snapshots whatever we pass at
 * server start so the browser-served web UI mirrors it. Read lazily (inside the
 * action) via `getState()` so there is no import-time coupling.
 */
function currentUiLanguage(): string {
  return useUIStore.getState().language;
}

/**
 * Max request-log entries retained in the store. Matches the backend ring
 * buffer cap so the live tail and a fresh snapshot agree in size.
 */
export const REQUEST_LOG_LIMIT = 200;

/** Sensible client-side default until the real config loads from the backend. */
const DEFAULT_CONFIG: HttpServerConfig = {
  enabled: false,
  port: 48610,
  bindLan: false,
  logToConsole: true,
  serveWebUi: false,
};

export interface HttpServerStoreState {
  status: HttpServerStatus;
  config: HttpServerConfig;
  /** Whether a Bearer token is currently stored (the value is never held here). */
  hasToken: boolean;
  /** Capped tail of recent requests, oldest first. */
  log: RequestLogEntry[];
  isLoading: boolean;
  /** Set when the last load/start/stop/save surfaced an error. */
  error: string | null;

  /** Load status, config, token presence, and the request-log snapshot. */
  load: () => Promise<void>;
  /** Start the server using the persisted config; refreshes status. */
  start: () => Promise<void>;
  /** Stop the server; refreshes status. */
  stop: () => Promise<void>;
  /**
   * Persist a new config and reconcile the running server. Rejects on a port
   * validation / bind error so the panel can surface the message inline.
   */
  saveConfig: (config: HttpServerConfig) => Promise<void>;
  /** Regenerate the token and return the new value ONCE for the caller to show. */
  regenerateToken: () => Promise<string>;
  /** Clear the stored token; refreshes the presence flag. */
  clearToken: () => Promise<void>;
  /** Append one live log entry (from the bridge), capped to the limit. */
  appendLog: (entry: RequestLogEntry) => void;
  /** Clear the request log (backend ring + the in-store tail). */
  clearLog: () => Promise<void>;
}

export const useHttpServerStore = create<HttpServerStoreState>((set) => ({
  status: { running: false, port: DEFAULT_CONFIG.port, bindLan: false },
  config: DEFAULT_CONFIG,
  hasToken: false,
  log: [],
  isLoading: false,
  error: null,

  load: async () => {
    set({ isLoading: true, error: null });
    try {
      const [status, config, hasToken, log] = await Promise.all([
        getHttpServerStatus(),
        getHttpServerConfig(),
        getApiTokenStatus(),
        listRequestLog(),
      ]);
      // Keep only the most-recent entries in case a future backend returns more.
      set({ status, config, hasToken, log: log.slice(-REQUEST_LOG_LIMIT) });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ isLoading: false });
    }
  },

  start: async () => {
    set({ error: null });
    try {
      await startHttpServer(currentUiLanguage());
      const status = await getHttpServerStatus();
      set({ status });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  stop: async () => {
    set({ error: null });
    try {
      await stopHttpServer();
      const status = await getHttpServerStatus();
      set({ status });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  saveConfig: async (config) => {
    set({ error: null });
    // Let the error propagate so the panel can render it inline; on success
    // re-read the authoritative status + config the backend now holds.
    await setHttpServerConfig(config, currentUiLanguage());
    const [status, fresh] = await Promise.all([
      getHttpServerStatus(),
      getHttpServerConfig(),
    ]);
    set({ status, config: fresh });
  },

  regenerateToken: async () => {
    const token = await regenerateApiToken();
    set({ hasToken: true });
    return token;
  },

  clearToken: async () => {
    await clearApiToken();
    set({ hasToken: false });
  },

  appendLog: (entry) => {
    set((s) => {
      const next = [...s.log, entry];
      // Trim from the front so the array stays at most REQUEST_LOG_LIMIT.
      return {
        log: next.length > REQUEST_LOG_LIMIT
          ? next.slice(next.length - REQUEST_LOG_LIMIT)
          : next,
      };
    });
  },

  clearLog: async () => {
    await clearRequestLog();
    // Clear the in-store tail too; a live event arriving after this just starts
    // a fresh list.
    set({ log: [] });
  },
}));
