// Built-in HTTP API server.
//
// An OPTIONAL, opt-in REST server that runs saved commands and workflows over
// HTTP (`POST /api/command/{ref}/run`, `POST /api/workflow/{ref}/run`) through
// the SAME headless path the Scheduler uses, so an API run lands in History and
// (when enabled) the live console. It lives entirely in Rust — a webview cannot
// host it because the window may be hidden/closed to tray.
//
// Security posture (see docs/http-server.md):
//   - Bearer token REQUIRED on every route except `GET /api/health`; the token
//     lives only in the OS keychain (`security::api_token`), never in SQLite,
//     events, or logs. Comparison is constant-time; repeated 401s are rate-
//     limited per IP.
//   - Binds `127.0.0.1` by DEFAULT; LAN exposure (`0.0.0.0`) is an explicit,
//     warned opt-in.
//   - Per-entity opt-in: a command/workflow is invisible to the API until its
//     `api_enabled` flag is set.
//
// Lifecycle: `start` binds the configured address and spawns the axum task with
// graceful shutdown via `Notify`; `stop` signals shutdown and awaits the task;
// `restart` is stop-then-start. All are idempotent and serialised by the state
// mutex so two starts can't race to bind the port.

pub mod auth;
pub mod handlers;
pub mod log;
pub mod mdns;
pub mod router;
pub mod state;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use tauri::{AppHandle, Manager, Runtime};
use tokio::net::TcpListener;
use tokio::sync::Notify;

use crate::core::executor::ExecutorState;
use crate::core::workflow::WorkflowExecutorState;
use crate::storage::http_server::{self, HttpServerConfig};
use crate::storage::DbPool;

pub use state::HttpServerState;

use router::ApiState;

/// Stable error code returned when the configured port is already in use, so
/// the frontend can show a precise "change the port" hint (mirrors the
/// `INVALID_CRON` / `PORT_IN_USE` convention).
pub const ERR_PORT_IN_USE: &str = "PORT_IN_USE";

/// Filename of the request log under the app log directory.
const LOG_FILE_NAME: &str = "http-server.log";

/// Start the HTTP server with `config`. Idempotent: if already running, it is
/// stopped first (so a port/bind change takes effect). On a bind failure for an
/// in-use port, returns [`ERR_PORT_IN_USE`]; other bind errors return their
/// message. On success the axum task runs until [`stop`] signals shutdown.
pub async fn start<R: Runtime>(
    app: &AppHandle<R>,
    state: &Arc<HttpServerState>,
    config: HttpServerConfig,
) -> Result<(), String> {
    // Stop any existing instance first so a restart with a new port/bind does
    // not leave the old listener bound.
    stop(state).await;

    let ip: IpAddr = if config.bind_lan {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED) // 0.0.0.0 — LAN
    } else {
        IpAddr::V4(Ipv4Addr::LOCALHOST) // 127.0.0.1
    };
    let addr = SocketAddr::new(ip, config.port);

    // Bind synchronously so a port conflict surfaces here (before the task is
    // spawned) as a typed error the command can return.
    let listener = TcpListener::bind(addr).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            format!("{ERR_PORT_IN_USE}: port {} is already in use", config.port)
        } else {
            format!("failed to bind http server to {addr}: {e}")
        }
    })?;

    // Point the request-log file sink at the app log dir (best-effort).
    if let Ok(log_dir) = app.path().app_log_dir() {
        let _ = std::fs::create_dir_all(&log_dir);
        state.request_log.set_log_path(log_dir.join(LOG_FILE_NAME));
    }

    let api_state = ApiState {
        app: app.clone(),
        pool: app.state::<DbPool>().inner().clone(),
        executor_state: app.state::<Arc<ExecutorState>>().inner().clone(),
        workflow_state: app.state::<Arc<WorkflowExecutorState>>().inner().clone(),
        server_state: state.clone(),
        config: config.clone(),
        // Production always reads the token from the OS keychain.
        token_source: router::TokenSource::Keychain,
    };
    let app_router = router::build_router(api_state);

    let shutdown = Arc::new(Notify::new());
    let shutdown_task = shutdown.clone();

    // Spawn on Tauri's managed runtime (the setup hook has no ambient Tokio
    // reactor), exactly like the scheduler loop.
    let handle = tauri::async_runtime::spawn(async move {
        // `into_make_service_with_connect_info` makes the peer `SocketAddr`
        // available to handlers via `ConnectInfo` (used for the per-IP rate
        // limit and the request log).
        let service = app_router.into_make_service_with_connect_info::<SocketAddr>();
        let server = axum::serve(listener, service).with_graceful_shutdown(async move {
            shutdown_task.notified().await;
        });
        if let Err(e) = server.await {
            tracing::error!("http_server: serve error: {e}");
        }
    });

    // Announce `procmix.local` + the `_http._tcp` service over mDNS so other
    // machines on the subnet can reach the server by name. Always attempted
    // (per the feature spec), best-effort: a missing LAN address or mDNS
    // responder just means no announcement — the server still runs. The A
    // record points at the LAN IP, so on a localhost-only bind a remote client
    // resolves the name but can't connect (intended).
    let lan_ip = mdns::detect_lan_ipv4();
    let announcement = lan_ip.and_then(|ip| mdns::MdnsAnnouncement::start(ip, config.port));

    state
        .set_running(handle, shutdown, config, announcement, lan_ip)
        .await;
    Ok(())
}

/// Stop the running server (if any): signal graceful shutdown and await the
/// task's exit. Idempotent — a no-op when not running.
pub async fn stop(state: &Arc<HttpServerState>) {
    if let Some(handle) = state.take_for_stop().await {
        // `take_for_stop` already pulsed the shutdown Notify; await the task.
        let _ = handle.await;
    }
}

/// Autostart the server during `setup` when the persisted config has it
/// enabled. Best-effort: a bind failure (e.g. port in use at launch) is logged
/// and swallowed so the app always finishes starting. Called AFTER
/// `app.manage(pool)` so the pool / executor states exist.
pub async fn autostart_if_enabled<R: Runtime>(app: &AppHandle<R>, state: &Arc<HttpServerState>) {
    let pool = app.state::<DbPool>().inner().clone();
    let config = match http_server::load(&pool).await {
        Ok(cfg) => cfg,
        Err(e) => {
            tracing::error!("http_server: failed to load config on startup: {e}");
            return;
        }
    };
    if !config.enabled {
        return;
    }
    if let Err(e) = start(app, state, config).await {
        tracing::error!("http_server: autostart failed: {e}");
    }
}
