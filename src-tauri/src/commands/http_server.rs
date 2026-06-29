//! Built-in HTTP server commands (v0.10.0) + API-token management.
//!
//! Manage the optional REST API server and its keychain-backed Bearer token.
//! The token VALUE crosses IPC only ONCE — as the return of
//! `regenerate_api_token` (for display/copy). Status queries return only a
//! boolean; the auth middleware reads the value in-process. See
//! `core::http_server` and docs/http-server.md.
//!
//! The API-token wrappers surface keychain errors through
//! [`super::to_ipc_err`], which produces the same string as the previous
//! inline `.map_err(|e| e.to_string())`.

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::core::http_server::{self, HttpServerState};
use crate::security::api_token;
use crate::storage::http_server as storage_http_server;
use crate::storage::DbPool;

use super::to_ipc_err;

/// Live status of the HTTP server: whether it is running, the bind it was
/// started with, and the addresses other machines can reach it at. Read by the
/// header mini-panel.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpServerStatus {
    pub running: bool,
    pub port: u16,
    pub bind_lan: bool,
    /// The `procmix.local` mDNS hostname (without trailing dot) when the server
    /// is running and an mDNS announcement is active; `None` otherwise. The UI
    /// shows `http://{mdnsHost}:{port}` as the friendly LAN address.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mdns_host: Option<String>,
    /// The machine's LAN IPv4 (e.g. `192.168.1.42`) when running and detected;
    /// `None` otherwise. The UI shows `http://{lanAddress}:{port}` as a reliable
    /// fallback for networks where mDNS is filtered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lan_address: Option<String>,
}

#[tauri::command]
pub async fn http_server_status(
    state: State<'_, Arc<HttpServerState>>,
    pool: State<'_, DbPool>,
) -> Result<HttpServerStatus, String> {
    let running = state.is_running().await;
    // When running, report the LIVE bind; otherwise reflect the persisted
    // config so the UI shows what a start would use.
    let cfg = match state.running_config().await {
        Some(cfg) => cfg,
        None => storage_http_server::load(pool.inner()).await?,
    };
    // LAN address + mDNS hostname are shown whenever a LAN IPv4 is detected, so
    // the UI can preview the network addresses BEFORE the server is started
    // (not only while running). While running we use the IP the live instance
    // actually announced mDNS on; while stopped we detect the current LAN IP
    // directly (the interface exists regardless of the server). The hostname is
    // reported without its trailing dot for display.
    let lan_ip = if running {
        state.lan_ip().await
    } else {
        http_server::mdns::detect_lan_ipv4()
    };
    let lan_address = lan_ip.map(|ip| ip.to_string());
    let mdns_host = lan_ip.map(|_| {
        http_server::mdns::MDNS_HOSTNAME
            .trim_end_matches('.')
            .to_string()
    });
    Ok(HttpServerStatus {
        running,
        port: cfg.port,
        bind_lan: cfg.bind_lan,
        mdns_host,
        lan_address,
    })
}

/// Start the server using the persisted config. A bind failure (e.g.
/// `PORT_IN_USE`) surfaces as a typed error string.
#[tauri::command]
pub async fn start_http_server(
    app: AppHandle,
    state: State<'_, Arc<HttpServerState>>,
    pool: State<'_, DbPool>,
    // The current app UI language (e.g. `"ru"`), passed by the frontend so the
    // browser-served web UI mirrors it. Snapshotted at start; not persisted.
    ui_language: Option<String>,
) -> Result<(), String> {
    let cfg = storage_http_server::load(pool.inner()).await?;
    http_server::start(&app, state.inner(), cfg, ui_language).await
}

/// Stop the server. Idempotent.
#[tauri::command]
pub async fn stop_http_server(state: State<'_, Arc<HttpServerState>>) -> Result<(), String> {
    http_server::stop(state.inner()).await;
    Ok(())
}

/// Read the persisted server config (token excluded — it is keychain-only).
#[tauri::command]
pub async fn get_http_server_config(
    pool: State<'_, DbPool>,
) -> Result<storage_http_server::HttpServerConfig, String> {
    storage_http_server::load(pool.inner()).await
}

/// Persist a new server config and reconcile the LIVE server.
///
/// The reconcile decision is based on whether the server is ACTUALLY running
/// right now — not on the persisted `enabled` flag, which only records the
/// autostart intent for the next launch and can diverge from reality (the user
/// may have started/stopped the server manually from the panel without flipping
/// `enabled`). So:
///   - currently running → restart with the new config (`start` stops the old
///     instance first), making a port / bind / console-log change take effect
///     immediately without a manual stop+start;
///   - currently stopped → only persist; a settings edit must not silently
///     spin up a server the user had stopped.
///
/// The port is validated before the DB write (an invalid port returns
/// `INVALID_PORT:` and the row is untouched).
#[tauri::command]
pub async fn set_http_server_config(
    app: AppHandle,
    state: State<'_, Arc<HttpServerState>>,
    pool: State<'_, DbPool>,
    config: storage_http_server::HttpServerConfig,
    // The current app UI language, re-snapshotted on the auto-restart so the web
    // UI's locale stays in sync after a config change. `None` leaves the served
    // locale to the web UI's default.
    ui_language: Option<String>,
) -> Result<(), String> {
    // Hold the config-operation lock across the WHOLE save + reconcile so a
    // concurrent writer (e.g. launch-time `autostart_if_enabled`, or another
    // settings toggle firing near-simultaneously) cannot interleave its own
    // save/reconcile between ours. Without this the persisted `enabled` flag and
    // the live running state could diverge: two `save()`s race on the single
    // SQLite row while each makes a `is_running` check-then-act decision on a
    // stale snapshot. The guard serialises both writers end-to-end.
    let _op = state.config_lock().await;
    storage_http_server::save(pool.inner(), &config).await?;
    if state.is_running().await {
        // Auto-restart on the new config. `start` stops the running instance
        // first, so this is an atomic restart that picks up the new port/bind/
        // console-log/web-UI setting.
        http_server::start(&app, state.inner(), config, ui_language).await?;
    }
    Ok(())
}

/// Whether an API token is currently stored.
#[tauri::command]
pub fn api_token_status() -> Result<bool, String> {
    api_token::has().map_err(to_ipc_err)
}

/// Generate a fresh API token, store it, and return the plaintext value ONCE
/// for the UI to display/copy. Overwrites any existing token.
#[tauri::command]
pub fn regenerate_api_token() -> Result<String, String> {
    api_token::generate().map_err(to_ipc_err)
}

/// Remove the stored API token. Idempotent.
#[tauri::command]
pub fn clear_api_token() -> Result<(), String> {
    api_token::clear().map_err(to_ipc_err)
}

/// Snapshot the in-memory request log (most-recent requests) for the live UI.
#[tauri::command]
pub async fn list_request_log(
    state: State<'_, Arc<HttpServerState>>,
) -> Result<Vec<http_server::log::RequestLogEntry>, String> {
    Ok(state.request_log.snapshot())
}

/// Clear the in-memory request log shown in the panel. The persistent
/// `http-server.log` file (audit trail) is intentionally left untouched.
#[tauri::command]
pub async fn clear_request_log(state: State<'_, Arc<HttpServerState>>) -> Result<(), String> {
    state.request_log.clear();
    Ok(())
}
