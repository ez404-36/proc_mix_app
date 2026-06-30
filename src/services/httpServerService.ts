// Typed wrappers around the built-in HTTP server's Tauri commands.
//
// `invoke` is confined to this service layer (project convention): components
// and stores call these functions, never `invoke` directly. The Bearer token
// VALUE crosses IPC exactly once — as the return of {@link regenerateApiToken}.
// Status queries return only a boolean; the auth middleware reads the value
// in-process. See `docs/http-server.md`.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  HttpServerConfig,
  HttpServerStatus,
  RequestLogEntry,
} from "../types/httpServer";

/**
 * Tauri event carrying a single {@link RequestLogEntry} per request. Must match
 * `core::http_server::log::HTTP_SERVER_LOG_EVENT` exactly.
 */
export const HTTP_SERVER_LOG_EVENT = "http-server-log";

/** Live status of the server (running flag + the bind it would/does use). */
export async function getHttpServerStatus(): Promise<HttpServerStatus> {
  return invoke<HttpServerStatus>("http_server_status");
}

/**
 * Start the server using the persisted config. Rejects with an error whose
 * message starts with `PORT_IN_USE:` when the configured port is taken.
 *
 * `uiLanguage` is the current app language (e.g. `"ru"`), snapshotted by the
 * backend so the browser-served web UI mirrors the desktop app's language at
 * start time. Omit it to leave the served locale to the web UI's default.
 */
export async function startHttpServer(uiLanguage?: string): Promise<void> {
  await invoke("start_http_server", { uiLanguage });
}

/**
 * Back-fill the UI-language snapshot of an already-running server WITHOUT a
 * restart. The autostart path starts the server before any window exists, so it
 * captures no language and `GET /api/bootstrap` returns `language: null`. The
 * frontend calls this once it mounts (when the status reports the snapshot is
 * missing) so the browser web UI mirrors the desktop locale. A no-op when the
 * server is stopped.
 */
export async function setHttpServerLanguage(uiLanguage?: string): Promise<void> {
  await invoke("set_http_server_language", { uiLanguage });
}

/** Stop the server. Idempotent — stopping when not running succeeds. */
export async function stopHttpServer(): Promise<void> {
  await invoke("stop_http_server");
}

/** Read the persisted server config (token excluded — keychain-only). */
export async function getHttpServerConfig(): Promise<HttpServerConfig> {
  return invoke<HttpServerConfig>("get_http_server_config");
}

/**
 * Persist a new server config. The backend validates the port (rejecting with
 * an `INVALID_PORT:` message) and reconciles the running state: it restarts the
 * server on the new port/bind when `enabled`, or stops it otherwise. A bind
 * conflict on (re)start rejects with a `PORT_IN_USE:` message.
 */
export async function setHttpServerConfig(
  config: HttpServerConfig,
  uiLanguage?: string,
): Promise<void> {
  await invoke("set_http_server_config", { config, uiLanguage });
}

/** Whether an API token is currently stored in the keychain. */
export async function getApiTokenStatus(): Promise<boolean> {
  return invoke<boolean>("api_token_status");
}

/**
 * Generate a fresh API token, store it, and return the plaintext value ONCE
 * for display/copy. Overwrites any existing token. The value is never
 * retrievable again over IPC.
 */
export async function regenerateApiToken(): Promise<string> {
  return invoke<string>("regenerate_api_token");
}

/** Remove the stored API token. Idempotent. */
export async function clearApiToken(): Promise<void> {
  await invoke("clear_api_token");
}

/** Snapshot the in-memory request log (most-recent requests, oldest first). */
export async function listRequestLog(): Promise<RequestLogEntry[]> {
  return invoke<RequestLogEntry[]>("list_request_log");
}

/**
 * Clear the in-memory request log shown in the panel. The persistent
 * `http-server.log` file (audit trail) is left untouched.
 */
export async function clearRequestLog(): Promise<void> {
  await invoke("clear_request_log");
}

/**
 * Subscribe to live request-log events. Invokes `handler` with each
 * {@link RequestLogEntry} the backend emits per request, so an open panel
 * updates without polling.
 *
 * Returns a cleanup function that detaches the listener. The Tauri listener is
 * attached asynchronously; the returned cleanup awaits and detaches it safely
 * even if called before attachment completes.
 */
export function subscribeRequestLog(
  handler: (entry: RequestLogEntry) => void,
): () => void {
  const unlistenPromise = listen<RequestLogEntry>(
    HTTP_SERVER_LOG_EVENT,
    (event) => handler(event.payload),
  );
  unlistenPromise.catch((err) => {
    console.error("http-server-log listener failed to attach:", err);
  });
  return () => {
    void unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
  };
}
