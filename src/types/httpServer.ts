// Types for the built-in HTTP API server feature.
//
// These mirror the Rust DTOs crossing the IPC boundary (camelCase):
//   - `HttpServerConfig` ↔ `storage::http_server::HttpServerConfig`
//   - `HttpServerStatus` ↔ `commands::HttpServerStatus`
//   - `RequestLogEntry`  ↔ `core::http_server::log::RequestLogEntry`
//
// The Bearer token is deliberately NOT part of any of these — it lives only in
// the OS keychain on the Rust side and crosses IPC exactly once (as the return
// of `regenerateApiToken`). See `docs/http-server.md`.

/**
 * Persisted configuration of the built-in HTTP server. The token is excluded
 * by design (keychain-only). `port` is validated server-side into
 * `[1024, 65535]`; an out-of-range value rejects with an `INVALID_PORT:` error.
 */
export interface HttpServerConfig {
  /** Whether the server should be running (and autostart on launch). */
  enabled: boolean;
  /** TCP port to bind. */
  port: number;
  /** `false` = bind 127.0.0.1 only (default); `true` = bind 0.0.0.0 (LAN). */
  bindLan: boolean;
  /**
   * `true` (default) = an API-triggered run streams to the live console;
   * `false` = runs are silent (recorded in History only).
   */
  logToConsole: boolean;
  /**
   * `false` (default) = REST API only; `true` = also serve the browser-served
   * read-only web UI ("reduced ProcMix") over the same port. Off by default so
   * the API-only posture is unchanged for existing installs.
   */
  serveWebUi: boolean;
}

/**
 * Live status of the server, returned by `httpServerStatus`. Reports the bind
 * the server is actually running with (or, when stopped, the persisted config
 * that a start would use).
 */
export interface HttpServerStatus {
  running: boolean;
  port: number;
  bindLan: boolean;
  /**
   * The `procmix.local` mDNS hostname (no trailing dot) when running and an
   * mDNS announcement is active. Other machines on the same subnet can reach
   * the server at `http://{mdnsHost}:{port}` (macOS/Windows resolve `.local`
   * out of the box; Linux needs avahi). Absent when stopped or undetected.
   */
  mdnsHost?: string;
  /**
   * The machine's LAN IPv4 (e.g. `192.168.1.42`) when running and detected.
   * `http://{lanAddress}:{port}` is the reliable fallback when mDNS is filtered
   * on the network. Absent when stopped or the machine has no LAN address.
   */
  lanAddress?: string;
  /**
   * `true` when the server is running but its UI-language snapshot (served to
   * the browser web UI via `/api/bootstrap`) is absent — the autostart path
   * starts the server before any window exists, so no language is captured. The
   * bridge back-fills the live language once via `setHttpServerLanguage` when
   * this is set. Always `false` when the server is stopped.
   */
  languageSnapshotMissing: boolean;
}

/**
 * One request summary from the server's in-memory request log. Metadata only —
 * never carries the token, request body, or any variable value. Emitted live on
 * the `http-server-log` Tauri event and snapshot-readable via `listRequestLog`.
 */
export interface RequestLogEntry {
  /** RFC 3339 timestamp of when the request completed. */
  ts: string;
  /** HTTP method (`GET` / `POST`). */
  method: string;
  /** Matched route path (e.g. `/api/command/{ref}/run`). */
  path: string;
  /** Final HTTP status code. */
  status: number;
  /** Peer socket address (`ip:port`), or `"-"` when unavailable. */
  remoteAddr: string;
  /** Resolved entity display name, when the request addressed a known entity. */
  entityName?: string;
  /**
   * Redacted, single-line summary of the request body (`wait=true; name=alice;
   * token=***`). Sensitive variable values are already masked to `***` on the
   * Rust side; a raw secret never reaches the frontend. Absent for requests
   * with no meaningful body.
   */
  requestSummary?: string;
  /**
   * Summary of the server's response (`status=succeeded exitCode=0`,
   * `error=notFound`, …). Never contains stdout or secrets.
   */
  responseSummary?: string;
}
