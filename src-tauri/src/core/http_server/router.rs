// axum router + auth middleware for the built-in HTTP API.
//
// Wires the transport-agnostic handlers (`handlers.rs`) and auth logic
// (`auth.rs`) into an `axum::Router`. The shared `ApiState` carries everything
// a handler needs (app handle, pool, executor states, live config, request
// log + rate limiter). Every `/api/*` route except `GET /api/health` passes
// through `require_auth`, which checks the Bearer token against the keychain
// and enforces the per-IP 401 rate limit.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Runtime};

use crate::core::executor::ExecutorState;
use crate::core::workflow::WorkflowExecutorState;
use crate::storage::http_server::HttpServerConfig;
use crate::storage::DbPool;

use super::auth::{self, AuthOutcome};
use super::handlers::{self, ApiError, CommandRunBody, WorkflowRunBody};
use super::log::RequestLogEntry;
use super::state::HttpServerState;

/// Where the auth middleware reads the configured Bearer token from.
///
/// Production always uses [`TokenSource::Keychain`], which reads
/// `security::api_token` fresh on each request (so a regenerate takes effect
/// without a restart). [`TokenSource::Fixed`] exists ONLY for integration tests:
/// it lets the router be exercised end-to-end with a known token WITHOUT
/// touching — and possibly clobbering — the real OS keychain entry the running
/// app shares. There is no public constructor for `Fixed` outside the crate's
/// own test code path; `start()` always wires `Keychain`.
#[derive(Clone)]
pub enum TokenSource {
    /// Read the token from the OS keychain on every request (production).
    Keychain,
    /// A fixed token (`Some`) or "no token configured" (`None`) — tests only.
    Fixed(Option<String>),
}

impl TokenSource {
    /// Resolve the currently-configured token. Keychain reads run on a blocking
    /// task (keyring is synchronous); the fixed variant is returned directly.
    async fn resolve(&self) -> Option<String> {
        match self {
            TokenSource::Keychain => {
                tokio::task::spawn_blocking(|| crate::security::api_token::get().ok().flatten())
                    .await
                    .ok()
                    .flatten()
            }
            TokenSource::Fixed(token) => token.clone(),
        }
    }
}

/// Everything a handler needs, cloned (cheaply, all `Arc`/`Clone`) into each
/// request. Generic over the Tauri `Runtime` so the test harness can use the
/// mock runtime.
///
/// `Clone` is implemented by hand rather than derived: a derived `Clone` would
/// add an `R: Clone` bound, but `AppHandle<R>` is `Clone` for every `R: Runtime`
/// regardless, so the manual impl keeps the bound at just `Runtime`.
pub struct ApiState<R: Runtime> {
    pub app: AppHandle<R>,
    pub pool: DbPool,
    pub executor_state: Arc<ExecutorState>,
    pub workflow_state: Arc<WorkflowExecutorState>,
    pub server_state: Arc<HttpServerState>,
    pub config: HttpServerConfig,
    /// How the auth middleware obtains the configured token. Always
    /// [`TokenSource::Keychain`] in production (see [`super::start`]).
    pub token_source: TokenSource,
}

impl<R: Runtime> Clone for ApiState<R> {
    fn clone(&self) -> Self {
        Self {
            app: self.app.clone(),
            pool: self.pool.clone(),
            executor_state: self.executor_state.clone(),
            workflow_state: self.workflow_state.clone(),
            server_state: self.server_state.clone(),
            config: self.config.clone(),
            token_source: self.token_source.clone(),
        }
    }
}

/// Build the API router with all routes and shared state.
///
/// When `state.config.serve_web_ui` is on, a catch-all fallback serves the
/// embedded browser web UI (B5) for every non-`/api` path — OUTSIDE the Bearer
/// guard (the login page must load tokenless), but still behind the
/// DNS-rebinding `Host` check. When off, no fallback is mounted and an unknown
/// path 404s, leaving the server API-only and byte-identical to before.
pub fn build_router<R: Runtime>(state: ApiState<R>) -> Router {
    let serve_web_ui = state.config.serve_web_ui;
    let router = Router::new()
        .route("/api/health", get(health))
        .route("/api/bootstrap", get(bootstrap::<R>))
        .route("/api/whoami", get(whoami::<R>))
        .route("/api/commands", get(list_commands::<R>))
        .route("/api/workflows", get(list_workflows::<R>))
        .route("/api/command/:reference", get(get_command::<R>))
        .route("/api/workflow/:reference", get(get_workflow::<R>))
        .route("/api/command/:reference/run", post(run_command::<R>))
        .route("/api/workflow/:reference/run", post(run_workflow::<R>))
        .route("/api/history", get(get_history::<R>))
        .route("/api/run/:executionId", get(get_run::<R>));

    let router = if serve_web_ui {
        router.fallback(super::static_assets::serve_web_asset::<R>)
    } else {
        router
    };

    router.with_state(state)
}

/// Query string for the run endpoints (`?wait=true`).
#[derive(Debug, Default, Deserialize)]
struct RunQuery {
    #[serde(default)]
    wait: bool,
}

/// Query string for `GET /api/history` (`?page=&pageSize=`). 1-based page;
/// `page_size` is clamped by the storage layer. Defaults: page 1, 20 rows.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryQuery {
    #[serde(default = "default_page")]
    page: u32,
    #[serde(default = "default_page_size")]
    page_size: u32,
}

impl Default for HistoryQuery {
    fn default() -> Self {
        Self {
            page: default_page(),
            page_size: default_page_size(),
        }
    }
}

fn default_page() -> u32 {
    1
}

fn default_page_size() -> u32 {
    20
}

/// Unauthenticated liveness probe. Returns only that the server is up — no
/// data, no entity list — so it is safe without a token.
async fn health() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({ "status": "ok" })))
}

/// Unauthenticated bootstrap for the browser web UI (B7). Returns the non-secret
/// startup configuration the SPA needs BEFORE the user logs in — currently just
/// the UI `language` snapshot captured when the server started, so the web UI's
/// locale mirrors the desktop app's language at start time. Carries no entity
/// data and no token, so it is safe without auth (like `/api/health`). A missing
/// snapshot (autostart path) yields `language: null` and the SPA falls back to
/// its built-in default.
async fn bootstrap<R: Runtime>(State(state): State<ApiState<R>>) -> impl IntoResponse {
    let language = state.server_state.ui_language().await;
    (StatusCode::OK, Json(json!({ "language": language })))
}

/// Lightweight token check for the web UI's login. Runs ONLY the auth guard
/// (Bearer + Host + rate limit) and returns `{ "ok": true }` on success — it
/// does no DB work and exposes no entity data, so the SPA can validate the
/// entered token without fetching the whole command list. A bad / missing token
/// or forbidden host is rejected by the guard exactly like any other
/// authenticated route.
async fn whoami<R: Runtime>(
    State(state): State<ApiState<R>>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    if let Some(resp) = guard(&state, &headers, addr, "/api/whoami", "GET").await {
        return resp;
    }
    let resp = (StatusCode::OK, Json(json!({ "ok": true }))).into_response();
    log_request(
        &state,
        addr,
        "GET",
        "/api/whoami",
        resp.status(),
        LogDetail::default(),
    );
    resp
}

async fn list_commands<R: Runtime>(
    State(state): State<ApiState<R>>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    if let Some(resp) = guard(&state, &headers, addr, "/api/commands", "GET").await {
        return resp;
    }
    let result = handlers::list_api_commands(&state.pool).await;
    let (resp, _) =
        finish(result.map(|items| (StatusCode::OK, Json(json!(items)).into_response())));
    log_request(
        &state,
        addr,
        "GET",
        "/api/commands",
        resp.status(),
        LogDetail::default(),
    );
    resp
}

async fn list_workflows<R: Runtime>(
    State(state): State<ApiState<R>>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    if let Some(resp) = guard(&state, &headers, addr, "/api/workflows", "GET").await {
        return resp;
    }
    let result = handlers::list_api_workflows(&state.pool).await;
    let (resp, _) =
        finish(result.map(|items| (StatusCode::OK, Json(json!(items)).into_response())));
    log_request(
        &state,
        addr,
        "GET",
        "/api/workflows",
        resp.status(),
        LogDetail::default(),
    );
    resp
}

async fn run_command<R: Runtime>(
    State(state): State<ApiState<R>>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(reference): Path<String>,
    Query(q): Query<RunQuery>,
    body: Option<Json<CommandRunBody>>,
) -> Response {
    // Log the REAL path with the slug/id the caller used (not the `:reference`
    // route template). The reference is a slug or id — never a secret — so it's
    // safe to record, including on an auth rejection.
    let path = format!("/api/command/{reference}/run");
    if let Some(resp) = guard(&state, &headers, addr, &path, "POST").await {
        return resp;
    }
    let mut body = body.map(|Json(b)| b).unwrap_or_default();
    body.wait = body.wait || q.wait;

    let result = handlers::run_command(
        &state.app,
        &state.pool,
        &state.executor_state,
        &reference,
        body,
        state.config.log_to_console,
    )
    .await;

    let (resp, detail) = match result {
        Ok(outcome) => {
            let status = if outcome.response.status == "started" {
                StatusCode::ACCEPTED
            } else {
                StatusCode::OK
            };
            let detail = LogDetail {
                entity_name: Some(outcome.entity_name),
                request_summary: Some(outcome.request_summary),
                response_summary: Some(response_summary(&outcome.response)),
            };
            (
                (status, Json(json!(outcome.response))).into_response(),
                detail,
            )
        }
        Err(e) => (api_error_response(&e), error_detail(&e)),
    };
    log_request(&state, addr, "POST", &path, resp.status(), detail);
    resp
}

async fn run_workflow<R: Runtime>(
    State(state): State<ApiState<R>>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(reference): Path<String>,
    Query(q): Query<RunQuery>,
    body: Option<Json<WorkflowRunBody>>,
) -> Response {
    // Real path with the slug/id the caller used (see `run_command`).
    let path = format!("/api/workflow/{reference}/run");
    if let Some(resp) = guard(&state, &headers, addr, &path, "POST").await {
        return resp;
    }
    let mut body = body.map(|Json(b)| b).unwrap_or_default();
    body.wait = body.wait || q.wait;

    let result = handlers::run_workflow(
        &state.app,
        &state.pool,
        &state.executor_state,
        &state.workflow_state,
        &reference,
        body,
        state.config.log_to_console,
    )
    .await;

    let (resp, detail) = match result {
        Ok(outcome) => {
            let status = if outcome.response.status == "started" {
                StatusCode::ACCEPTED
            } else {
                StatusCode::OK
            };
            let detail = LogDetail {
                entity_name: Some(outcome.entity_name),
                request_summary: Some(outcome.request_summary),
                response_summary: Some(response_summary(&outcome.response)),
            };
            (
                (status, Json(json!(outcome.response))).into_response(),
                detail,
            )
        }
        Err(e) => (api_error_response(&e), error_detail(&e)),
    };
    log_request(&state, addr, "POST", &path, resp.status(), detail);
    resp
}

async fn get_command<R: Runtime>(
    State(state): State<ApiState<R>>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(reference): Path<String>,
) -> Response {
    let path = format!("/api/command/{reference}");
    if let Some(resp) = guard(&state, &headers, addr, &path, "GET").await {
        return resp;
    }
    let result = handlers::get_api_command(&state.pool, &reference).await;
    let (resp, _) =
        finish(result.map(|rec| (StatusCode::OK, Json(json!(rec)).into_response())));
    log_request(&state, addr, "GET", &path, resp.status(), LogDetail::default());
    resp
}

async fn get_workflow<R: Runtime>(
    State(state): State<ApiState<R>>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(reference): Path<String>,
) -> Response {
    let path = format!("/api/workflow/{reference}");
    if let Some(resp) = guard(&state, &headers, addr, &path, "GET").await {
        return resp;
    }
    let result = handlers::get_api_workflow(&state.pool, &reference).await;
    let (resp, _) =
        finish(result.map(|rec| (StatusCode::OK, Json(json!(rec)).into_response())));
    log_request(&state, addr, "GET", &path, resp.status(), LogDetail::default());
    resp
}

async fn get_history<R: Runtime>(
    State(state): State<ApiState<R>>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(q): Query<HistoryQuery>,
) -> Response {
    if let Some(resp) = guard(&state, &headers, addr, "/api/history", "GET").await {
        return resp;
    }
    let result = handlers::list_api_history(&state.pool, q.page, q.page_size).await;
    let (resp, _) =
        finish(result.map(|page| (StatusCode::OK, Json(json!(page)).into_response())));
    log_request(
        &state,
        addr,
        "GET",
        "/api/history",
        resp.status(),
        LogDetail::default(),
    );
    resp
}

async fn get_run<R: Runtime>(
    State(state): State<ApiState<R>>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Path(execution_id): Path<String>,
) -> Response {
    let path = format!("/api/run/{execution_id}");
    if let Some(resp) = guard(&state, &headers, addr, &path, "GET").await {
        return resp;
    }
    let result = handlers::get_run_status(&state.pool, &execution_id).await;
    let (resp, _) =
        finish(result.map(|run| (StatusCode::OK, Json(json!(run)).into_response())));
    log_request(&state, addr, "GET", &path, resp.status(), LogDetail::default());
    resp
}

/// Authenticate a request. Returns `Some(response)` when the request must be
/// rejected (rate-limited / unauthorized / no token); `None` when it may
/// proceed. A rejection is itself logged.
async fn guard<R: Runtime>(
    state: &ApiState<R>,
    headers: &HeaderMap,
    addr: SocketAddr,
    path: &str,
    method: &str,
) -> Option<Response> {
    let ip = addr.ip();

    // DNS-rebinding gate: reject any request whose `Host` header is not one we
    // legitimately serve (loopback names, or the bound LAN IP when exposed).
    // A browser page on an attacker domain that rebinds DNS to 127.0.0.1 cannot
    // forge `Host`, so this stops it reaching the API even with a stolen token.
    // `/api/health` is unauthenticated and never calls `guard`, so it is
    // unaffected.
    let host_header = headers.get("host").and_then(|v| v.to_str().ok());
    let lan_ip = state.server_state.lan_ip().await;
    if !auth::is_host_allowed(
        host_header,
        state.config.port,
        state.config.bind_lan,
        lan_ip,
    ) {
        let resp = forbidden_host_response();
        log_request(
            state,
            addr,
            method,
            path,
            resp.status(),
            auth_detail("forbiddenHost"),
        );
        return Some(resp);
    }

    // Brute-force gate first: a flooded IP is rejected without even comparing
    // the token (and without leaking whether the token would have matched).
    if state.server_state.is_rate_limited(ip).await {
        let resp = unauthorized_response();
        log_request(
            state,
            addr,
            method,
            path,
            resp.status(),
            auth_detail("rateLimited"),
        );
        return Some(resp);
    }

    let presented = headers.get("authorization").and_then(|v| v.to_str().ok());
    let presented = auth::extract_bearer(presented);

    // The configured token is read fresh on each request (so a regenerate takes
    // effect immediately, no restart). Production reads the keychain; tests
    // inject a fixed value via `TokenSource::Fixed`.
    let configured = state.token_source.resolve().await;

    match auth::verify(presented, configured.as_deref()) {
        AuthOutcome::Ok => None,
        AuthOutcome::Unauthorized => {
            state.server_state.record_auth_failure(ip).await;
            let resp = unauthorized_response();
            log_request(
                state,
                addr,
                method,
                path,
                resp.status(),
                auth_detail("unauthorized"),
            );
            Some(resp)
        }
        AuthOutcome::NoTokenConfigured => {
            let resp = (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "noTokenConfigured" })),
            )
                .into_response();
            log_request(
                state,
                addr,
                method,
                path,
                resp.status(),
                auth_detail("noTokenConfigured"),
            );
            Some(resp)
        }
    }
}

fn unauthorized_response() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "unauthorized" })),
    )
        .into_response()
}

/// Response for a request whose `Host` header is not one this server serves
/// (DNS-rebinding defence). `403 Forbidden` rather than `401`: it is not an
/// auth-credential problem, and it must not be retried with a different token.
fn forbidden_host_response() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "error": "forbiddenHost" })),
    )
        .into_response()
}

/// Map an [`ApiError`] to its HTTP response.
fn api_error_response(e: &ApiError) -> Response {
    match e {
        ApiError::NotFound => {
            (StatusCode::NOT_FOUND, Json(json!({ "error": "notFound" }))).into_response()
        }
        ApiError::MissingVariable(name) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missingVariable", "variable": name })),
        )
            .into_response(),
        ApiError::RunFailed(_) => (
            // The internal error string may carry detail we do not want to leak
            // to an API client, so the body is a generic code.
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "runFailed" })),
        )
            .into_response(),
    }
}

/// Collapse a `Result<(StatusCode, Response)>` handler result into a single
/// response, mapping an `ApiError` to its HTTP form.
fn finish(result: Result<(StatusCode, Response), ApiError>) -> (Response, ()) {
    match result {
        Ok((_, resp)) => (resp, ()),
        Err(e) => (api_error_response(&e), ()),
    }
}

/// Optional per-request log detail assembled by a handler: the resolved entity
/// name, the pre-redacted request summary, and the response summary. All three
/// are `None` for requests that don't produce them (GET lists, auth failures).
#[derive(Default)]
struct LogDetail {
    entity_name: Option<String>,
    request_summary: Option<String>,
    response_summary: Option<String>,
}

/// One-line summary of a successful run response for the log (no secrets — the
/// response never carries stdout or a variable value).
fn response_summary(run: &handlers::RunResponse) -> String {
    match run.exit_code {
        Some(code) => format!("status={} exitCode={code}", run.status),
        None => format!("status={}", run.status),
    }
}

/// Log detail for a failed run: a `response_summary` naming the error code, no
/// entity name (resolution may have failed). The `MissingVariable` name is a
/// variable NAME, never a value, so it is safe to log.
fn error_detail(e: &ApiError) -> LogDetail {
    let response_summary = match e {
        ApiError::NotFound => "error=notFound".to_string(),
        ApiError::MissingVariable(name) => format!("error=missingVariable variable={name}"),
        ApiError::RunFailed(_) => "error=runFailed".to_string(),
    };
    LogDetail {
        entity_name: None,
        request_summary: None,
        response_summary: Some(response_summary),
    }
}

/// Log detail for an auth rejection: just a `response_summary` naming the
/// reason code (`unauthorized` / `rateLimited` / `noTokenConfigured`).
fn auth_detail(reason: &str) -> LogDetail {
    LogDetail {
        entity_name: None,
        request_summary: None,
        response_summary: Some(format!("error={reason}")),
    }
}

/// Record one request into the server's request log (ring + event + file).
fn log_request<R: Runtime>(
    state: &ApiState<R>,
    addr: SocketAddr,
    method: &str,
    path: &str,
    status: StatusCode,
    detail: LogDetail,
) {
    let entry = RequestLogEntry {
        ts: chrono::Utc::now().to_rfc3339(),
        method: method.to_string(),
        path: path.to_string(),
        status: status.as_u16(),
        remote_addr: addr.to_string(),
        entity_name: detail.entity_name,
        request_summary: detail.request_summary,
        response_summary: detail.response_summary,
    };
    state.server_state.request_log.record(&state.app, entry);
}
