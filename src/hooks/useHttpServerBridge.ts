import { useEffect } from "react";
import { subscribeRequestLog } from "../services/httpServerService";
import { useHttpServerStore } from "../stores/httpServerStore";

/**
 * App-global bridge for the built-in HTTP server, mounted once alongside the
 * other event bridges (execution / workflow). It:
 *   1. loads the initial status / config / token-presence / request-log
 *      snapshot once on mount, and
 *   2. subscribes to the `http-server-log` Tauri event, appending each request
 *      summary to the store's capped live log.
 *
 * Modeled on {@link import("./useWorkflowBridge").useWorkflowBridge}: a single
 * `useEffect` that attaches the listener and returns its detach. The handler
 * reads the store action via `getState()` so the effect has no store deps and
 * runs exactly once.
 *
 * After the initial snapshot it also back-fills the server's UI-language: a
 * server started by AUTOSTART (during `setup`, before any window) captured no
 * language, so `/api/bootstrap` would return `language: null`. `syncLanguage`
 * pushes the current app language into the running server once — a no-op unless
 * the status reports the snapshot missing — so the browser web UI mirrors the
 * desktop locale without a manual restart.
 */
export function useHttpServerBridge(): void {
  useEffect(() => {
    // Initial snapshot, then back-fill the language for an autostarted server.
    // Sequenced so `syncLanguage` sees the freshly-loaded status.
    void useHttpServerStore
      .getState()
      .load()
      .then(() => useHttpServerStore.getState().syncLanguage());

    const unsubscribe = subscribeRequestLog((entry) => {
      useHttpServerStore.getState().appendLog(entry);
    });
    return () => {
      unsubscribe();
    };
  }, []);
}
