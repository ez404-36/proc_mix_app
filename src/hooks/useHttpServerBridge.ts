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
 */
export function useHttpServerBridge(): void {
  useEffect(() => {
    // Initial snapshot (fire-and-forget; the store records any error itself).
    void useHttpServerStore.getState().load();

    const unsubscribe = subscribeRequestLog((entry) => {
      useHttpServerStore.getState().appendLog(entry);
    });
    return () => {
      unsubscribe();
    };
  }, []);
}
