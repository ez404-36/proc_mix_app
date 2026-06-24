//! Integration tests for the built-in HTTP API server (`core::http_server`).
//!
//! These drive the real `axum::Router` end-to-end via `tower`'s `oneshot`
//! (one request → one response) WITHOUT binding a TCP port and WITHOUT touching
//! the OS keychain: the configured Bearer token is injected through
//! `TokenSource::Fixed`, so the shared real keychain entry the running app uses
//! is never read or clobbered. The auth gate, command/workflow resolution, the
//! per-entity opt-in, and the real executor spawn are all exercised.
//!
//! Coverage:
//!   - request with a VALID token            → allowed
//!   - request with an INVALID / missing token → 401
//!   - running an API-ENABLED command         → 200/202, real process runs
//!   - running a NOT-enabled (or unknown) command → 404
//!   - edge cases: health is unauthenticated, slug-vs-id addressing, the
//!     `?wait=true` exit code, listing only exposes opted-in entities, an
//!     unknown route 404s, and a workflow run.
//!
//! Unix-only: the fixture commands are `bash`/`sh` scripts.

#![cfg(unix)]

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use axum::Router;
use procmix_lib::core::executor::ExecutorState;
use procmix_lib::core::http_server::router::{build_router, ApiState, TokenSource};
use procmix_lib::core::http_server::HttpServerState;
use procmix_lib::core::workflow::WorkflowExecutorState;
use procmix_lib::storage::commands::{self as storage_commands, CommandRecord, VariableSpec};
use procmix_lib::storage::http_server::HttpServerConfig;
use procmix_lib::storage::workflows::{
    self as storage_workflows, NodePosition, WorkflowEdgeRecord, WorkflowNodeRecord, WorkflowRecord,
};
use procmix_lib::storage::{init_pool, DbPool};
use serde_json::Value;
use tauri::test::{mock_builder, MockRuntime};
use tower::ServiceExt;

const TEST_TOKEN: &str = "test-token-12345";

/// Build a mock Tauri app handle for the executor (it needs an `AppHandle` to
/// emit events; we never assert on them here).
fn mock_app() -> tauri::AppHandle<MockRuntime> {
    mock_builder()
        .build(tauri::generate_context!())
        .expect("mock_builder build")
        .handle()
        .clone()
}

/// Create a fully-migrated, throwaway on-disk SQLite pool. `init_pool` runs the
/// schema + every `ensure_*` migration, so the `api_slug` / `api_enabled`
/// columns and their partial unique indexes exist. The tempdir is leaked for
/// the (short) lifetime of the test process — fine for a test.
async fn fresh_pool() -> DbPool {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("test.db");
    // Keep the dir alive for the whole test by leaking it.
    std::mem::forget(dir);
    init_pool(path).await.expect("init_pool")
}

/// Minimal API-addressable command. Every optional field defaulted; the caller
/// sets `api_enabled` / `api_slug` / `script` as needed.
fn command(id: &str, script: &str, api_slug: Option<&str>, api_enabled: bool) -> CommandRecord {
    CommandRecord {
        id: id.into(),
        name: format!("cmd-{id}"),
        name_key: None,
        description: None,
        description_key: None,
        icon: None,
        script: script.into(),
        shell: Some("bash".into()),
        args: None,
        working_dir: None,
        env: None,
        tags: Vec::new(),
        category_id: None,
        favorite: false,
        created_at: "2026-06-24T00:00:00Z".into(),
        updated_at: "2026-06-24T00:00:00Z".into(),
        last_run_at: None,
        run_count: 0,
        run_as_admin: false,
        variables: Vec::new(),
        timeout_seconds: None,
        output_schema: None,
        scope: None,
        workflow_id: None,
        target: None,
        api_slug: api_slug.map(Into::into),
        api_enabled,
    }
}

/// A start → command → end workflow exposed over the API.
fn workflow(id: &str, command_id: &str, api_slug: &str) -> WorkflowRecord {
    let node = |nid: &str, kind: &str, cmd: Option<&str>| WorkflowNodeRecord {
        id: nid.into(),
        kind: kind.into(),
        command_id: cmd.map(Into::into),
        label: None,
        condition: None,
        cases: Vec::new(),
        loop_config: None,
        retry: None,
        data: Vec::new(),
        variable_sources: std::collections::BTreeMap::new(),
        parser: None,
        text: None,
        join_node_id: None,
        position: NodePosition { x: 0.0, y: 0.0 },
    };
    let edge = |eid: &str, src: &str, tgt: &str| WorkflowEdgeRecord {
        id: eid.into(),
        source: src.into(),
        target: tgt.into(),
        branch: "out".into(),
    };
    WorkflowRecord {
        id: id.into(),
        name: format!("wf-{id}"),
        description: None,
        icon: None,
        nodes: vec![
            node("start", "start", None),
            node("step", "command", Some(command_id)),
            node("end", "end", None),
        ],
        edges: vec![edge("e1", "start", "step"), edge("e2", "step", "end")],
        tags: Vec::new(),
        category_id: None,
        favorite: false,
        created_at: "2026-06-24T00:00:00Z".into(),
        updated_at: "2026-06-24T00:00:00Z".into(),
        last_run_at: None,
        run_count: 0,
        api_slug: Some(api_slug.into()),
        api_enabled: true,
    }
}

/// Assemble the router with a FIXED token plus the shared `HttpServerState`, so
/// a test can both drive requests AND snapshot the resulting request log.
fn router_with_state(pool: DbPool, token: Option<&str>) -> (Router, Arc<HttpServerState>) {
    let server_state = Arc::new(HttpServerState::new());
    let state = ApiState {
        app: mock_app(),
        pool,
        executor_state: Arc::new(ExecutorState::new()),
        workflow_state: Arc::new(WorkflowExecutorState::new()),
        server_state: server_state.clone(),
        config: HttpServerConfig {
            enabled: true,
            port: 0,
            bind_lan: false,
            log_to_console: false,
        },
        token_source: TokenSource::Fixed(token.map(Into::into)),
    };
    (build_router(state), server_state)
}

/// Assemble the router with a FIXED token so the auth gate is deterministic and
/// keychain-free. `log_to_console` is forced off (silent runs) so a test run
/// doesn't try to stream into a non-existent console.
fn router_with_token(pool: DbPool, token: Option<&str>) -> Router {
    router_with_state(pool, token).0
}

/// A command with one sensitive variable (`token`) and one non-sensitive
/// (`name`), for redaction assertions.
fn command_with_vars(id: &str, api_slug: &str) -> CommandRecord {
    let mut cmd = command(id, "true", Some(api_slug), true);
    cmd.variables = vec![
        VariableSpec {
            name: "token".into(),
            default_value: None,
            prompt_at_runtime: false,
            description: None,
            sensitive: true,
        },
        VariableSpec {
            name: "name".into(),
            default_value: None,
            prompt_at_runtime: false,
            description: None,
            sensitive: false,
        },
    ];
    cmd
}

/// Read the History row for a run by its `execution_id`, returning
/// `(kind, status)` (e.g. `("commandRun", "succeeded")`). `None` when no row
/// exists. Used to assert that an API run is recorded and finalised.
async fn history_row(pool: &DbPool, execution_id: &str) -> Option<(String, String)> {
    use sqlx::Row;
    let row = sqlx::query(
        "SELECT kind, status FROM history_events WHERE execution_id = ? LIMIT 1",
    )
    .bind(execution_id)
    .fetch_optional(pool.as_ref())
    .await
    .unwrap();
    row.map(|r| {
        (
            r.try_get::<String, _>("kind").unwrap(),
            r.try_get::<Option<String>, _>("status")
                .unwrap()
                .unwrap_or_default(),
        )
    })
}

/// Send one request through the router. `ConnectInfo` is injected as an
/// extension because `oneshot` does not go through a real connection (the
/// handlers extract the peer addr for the rate limiter / request log).
async fn send(router: Router, req: Request<Body>) -> (StatusCode, Value) {
    let mut req = req;
    req.extensions_mut().insert(ConnectInfo(SocketAddr::new(
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        12345,
    )));
    let resp = router.oneshot(req).await.expect("router oneshot");
    let status = resp.status();
    let bytes = to_bytes(resp.into_body(), 1024 * 1024)
        .await
        .expect("read body");
    let json: Value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, json)
}

/// `POST /api/command/{reference}/run` request builder with an optional Bearer
/// header and optional `?wait=true`.
fn post_command_run(reference: &str, token: Option<&str>, wait: bool) -> Request<Body> {
    let uri = if wait {
        format!("/api/command/{reference}/run?wait=true")
    } else {
        format!("/api/command/{reference}/run")
    };
    let mut builder = Request::builder().method("POST").uri(uri);
    if let Some(t) = token {
        builder = builder.header("authorization", format!("Bearer {t}"));
    }
    builder.body(Body::empty()).expect("build request")
}

// ---------------------------------------------------------------------------
// Auth: valid vs invalid token
// ---------------------------------------------------------------------------

/// A request carrying the correct Bearer token reaches the handler (here: a
/// 404 for an unknown command — proving auth PASSED and we got past the gate).
#[tokio::test]
async fn valid_token_passes_auth() {
    let pool = fresh_pool().await;
    let router = router_with_token(pool, Some(TEST_TOKEN));
    let (status, body) = send(
        router,
        post_command_run("does-not-exist", Some(TEST_TOKEN), false),
    )
    .await;
    // Auth passed → we reach resolution, which 404s for a missing command.
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"], "notFound");
}

/// A request with the WRONG token is rejected at the gate with 401 and never
/// reaches command resolution.
#[tokio::test]
async fn invalid_token_is_rejected() {
    let pool = fresh_pool().await;
    let router = router_with_token(pool, Some(TEST_TOKEN));
    let (status, body) = send(
        router,
        post_command_run("anything", Some("wrong-token"), false),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "unauthorized");
}

/// A request with NO `Authorization` header is also 401.
#[tokio::test]
async fn missing_token_is_rejected() {
    let pool = fresh_pool().await;
    let router = router_with_token(pool, Some(TEST_TOKEN));
    let (status, body) = send(router, post_command_run("anything", None, false)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "unauthorized");
}

/// When the server has NO token configured at all, every authenticated request
/// fails closed with a distinct `noTokenConfigured` code (still 401).
#[tokio::test]
async fn no_token_configured_fails_closed() {
    let pool = fresh_pool().await;
    let router = router_with_token(pool, None);
    let (status, body) = send(
        router,
        post_command_run("anything", Some("whatever"), false),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "noTokenConfigured");
}

// ---------------------------------------------------------------------------
// Running allowed vs not-allowed commands
// ---------------------------------------------------------------------------

/// An API-ENABLED command can be run by slug. Without `?wait` the response is
/// `202 Accepted` with `status: "started"` and an execution id.
#[tokio::test]
async fn runs_api_enabled_command_async() {
    let pool = fresh_pool().await;
    storage_commands::upsert(&pool, &command("c1", "true", Some("deploy"), true))
        .await
        .unwrap();
    let router = router_with_token(pool, Some(TEST_TOKEN));

    let (status, body) = send(router, post_command_run("deploy", Some(TEST_TOKEN), false)).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(body["status"], "started");
    assert!(
        body["executionId"].as_str().is_some_and(|s| !s.is_empty()),
        "an execution id is returned: {body}"
    );
}

/// With `?wait=true`, the handler blocks until the process exits and returns
/// the terminal status + exit code. A command that exits 0 → succeeded.
#[tokio::test]
async fn runs_api_enabled_command_wait_returns_exit_code() {
    let pool = fresh_pool().await;
    storage_commands::upsert(&pool, &command("c1", "exit 0", Some("ok"), true))
        .await
        .unwrap();
    let router = router_with_token(pool, Some(TEST_TOKEN));

    let (status, body) = send(router, post_command_run("ok", Some(TEST_TOKEN), true)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "succeeded");
    assert_eq!(body["exitCode"], 0);
}

/// A non-zero exit is reported as `failed` with the real exit code.
#[tokio::test]
async fn waited_command_reports_nonzero_exit_as_failed() {
    let pool = fresh_pool().await;
    storage_commands::upsert(&pool, &command("c1", "exit 3", Some("boom"), true))
        .await
        .unwrap();
    let router = router_with_token(pool, Some(TEST_TOKEN));

    let (status, body) = send(router, post_command_run("boom", Some(TEST_TOKEN), true)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "failed");
    assert_eq!(body["exitCode"], 3);
}

/// A command that EXISTS but is NOT API-enabled is indistinguishable from a
/// non-existent one: 404. Opting in is the only gate.
#[tokio::test]
async fn does_not_run_disabled_command() {
    let pool = fresh_pool().await;
    storage_commands::upsert(&pool, &command("c1", "true", Some("secret"), false))
        .await
        .unwrap();
    let router = router_with_token(pool, Some(TEST_TOKEN));

    // By slug:
    let (status, body) = send(
        router.clone(),
        post_command_run("secret", Some(TEST_TOKEN), false),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"], "notFound");

    // …and by id (the fallback addressing) is equally blocked.
    let (status2, _) = send(router, post_command_run("c1", Some(TEST_TOKEN), false)).await;
    assert_eq!(status2, StatusCode::NOT_FOUND);
}

/// An entirely unknown reference 404s.
#[tokio::test]
async fn unknown_command_is_not_found() {
    let pool = fresh_pool().await;
    let router = router_with_token(pool, Some(TEST_TOKEN));
    let (status, _) = send(router, post_command_run("ghost", Some(TEST_TOKEN), false)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

/// `GET /api/health` is UNAUTHENTICATED — it must answer 200 with no token.
#[tokio::test]
async fn health_is_unauthenticated() {
    let pool = fresh_pool().await;
    let router = router_with_token(pool, Some(TEST_TOKEN));
    let req = Request::builder()
        .method("GET")
        .uri("/api/health")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send(router, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
}

/// An API-enabled command is also addressable by its raw `id` (slug is just the
/// preferred alias), and runs the same way.
#[tokio::test]
async fn command_addressable_by_id_fallback() {
    let pool = fresh_pool().await;
    // No slug at all — only id addressing is possible.
    storage_commands::upsert(&pool, &command("cmd-xyz", "exit 0", None, true))
        .await
        .unwrap();
    let router = router_with_token(pool, Some(TEST_TOKEN));

    let (status, body) = send(router, post_command_run("cmd-xyz", Some(TEST_TOKEN), true)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "succeeded");
}

/// `GET /api/commands` lists ONLY opted-in commands (the disabled one is hidden)
/// and requires auth.
#[tokio::test]
async fn list_commands_only_exposes_enabled() {
    let pool = fresh_pool().await;
    storage_commands::upsert(&pool, &command("c1", "true", Some("shown"), true))
        .await
        .unwrap();
    storage_commands::upsert(&pool, &command("c2", "true", Some("hidden"), false))
        .await
        .unwrap();
    let router = router_with_token(pool, Some(TEST_TOKEN));

    // Unauthenticated list is rejected.
    let unauth = Request::builder()
        .method("GET")
        .uri("/api/commands")
        .body(Body::empty())
        .unwrap();
    let (status_unauth, _) = send(router.clone(), unauth).await;
    assert_eq!(status_unauth, StatusCode::UNAUTHORIZED);

    // Authenticated list returns only the enabled command.
    let req = Request::builder()
        .method("GET")
        .uri("/api/commands")
        .header("authorization", format!("Bearer {TEST_TOKEN}"))
        .body(Body::empty())
        .unwrap();
    let (status, body) = send(router, req).await;
    assert_eq!(status, StatusCode::OK);
    let arr = body.as_array().expect("array body");
    assert_eq!(arr.len(), 1, "only the enabled command is listed: {body}");
    assert_eq!(arr[0]["apiSlug"], "shown");
}

/// An unknown route returns 404 (axum's fallback), not 401 — auth is per-route.
#[tokio::test]
async fn unknown_route_is_not_found() {
    let pool = fresh_pool().await;
    let router = router_with_token(pool, Some(TEST_TOKEN));
    let req = Request::builder()
        .method("GET")
        .uri("/api/nope")
        .body(Body::empty())
        .unwrap();
    let (status, _) = send(router, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

/// A GET on a POST-only run route is rejected with 405 Method Not Allowed.
#[tokio::test]
async fn wrong_method_on_run_route_is_405() {
    let pool = fresh_pool().await;
    storage_commands::upsert(&pool, &command("c1", "true", Some("deploy"), true))
        .await
        .unwrap();
    let router = router_with_token(pool, Some(TEST_TOKEN));
    let req = Request::builder()
        .method("GET")
        .uri("/api/command/deploy/run")
        .header("authorization", format!("Bearer {TEST_TOKEN}"))
        .body(Body::empty())
        .unwrap();
    let (status, _) = send(router, req).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
}

/// An API-enabled workflow runs end-to-end with `?wait=true`, driving its single
/// command node (which exits 0) to a `succeeded` terminal status.
#[tokio::test]
async fn runs_api_enabled_workflow_wait() {
    let pool = fresh_pool().await;
    // The workflow's node references a (local-scoped) command that exits 0.
    storage_commands::upsert(&pool, &command("wf-cmd", "exit 0", None, false))
        .await
        .unwrap();
    storage_workflows::upsert(&pool, &workflow("w1", "wf-cmd", "pipeline"))
        .await
        .unwrap();
    let router = router_with_token(pool, Some(TEST_TOKEN));

    let req = Request::builder()
        .method("POST")
        .uri("/api/workflow/pipeline/run?wait=true")
        .header("authorization", format!("Bearer {TEST_TOKEN}"))
        .body(Body::empty())
        .unwrap();
    let (status, body) = send(router, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "succeeded");
}

/// A not-enabled workflow is 404, exactly like a command.
#[tokio::test]
async fn does_not_run_disabled_workflow() {
    let pool = fresh_pool().await;
    storage_commands::upsert(&pool, &command("wf-cmd", "true", None, false))
        .await
        .unwrap();
    let mut wf = workflow("w1", "wf-cmd", "pipeline");
    wf.api_enabled = false;
    storage_workflows::upsert(&pool, &wf).await.unwrap();
    let router = router_with_token(pool, Some(TEST_TOKEN));

    let req = Request::builder()
        .method("POST")
        .uri("/api/workflow/pipeline/run")
        .header("authorization", format!("Bearer {TEST_TOKEN}"))
        .body(Body::empty())
        .unwrap();
    let (status, body) = send(router, req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"], "notFound");
}

/// A malformed `Authorization` header (not `Bearer …`) is treated as no
/// credential → 401, never a panic.
#[tokio::test]
async fn malformed_auth_header_is_rejected() {
    let pool = fresh_pool().await;
    let router = router_with_token(pool, Some(TEST_TOKEN));
    let req = Request::builder()
        .method("POST")
        .uri("/api/command/x/run")
        .header("authorization", "Basic abc123")
        .body(Body::empty())
        .unwrap();
    let (status, body) = send(router, req).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "unauthorized");
}

// ---------------------------------------------------------------------------
// Request log: time, IP, redacted body, and response are recorded
// ---------------------------------------------------------------------------

/// A command run logs the timestamp, sender IP, entity name, a REDACTED request
/// summary (sensitive `token` masked, non-sensitive `name` shown), and a
/// response summary — and the raw secret never appears anywhere in the entry.
#[tokio::test]
async fn request_log_records_metadata_and_redacts_secrets() {
    let pool = fresh_pool().await;
    storage_commands::upsert(&pool, &command_with_vars("c1", "deploy"))
        .await
        .unwrap();
    let (router, server_state) = router_with_state(pool, Some(TEST_TOKEN));

    let req = Request::builder()
        .method("POST")
        .uri("/api/command/deploy/run?wait=true")
        .header("authorization", format!("Bearer {TEST_TOKEN}"))
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"variables":{"token":"s3cr3t","name":"alice"}}"#,
        ))
        .unwrap();
    let (status, _) = send(router, req).await;
    assert_eq!(status, StatusCode::OK);

    let log = server_state.request_log.snapshot();
    let entry = log.last().expect("a request was logged");

    // Time + IP.
    assert!(!entry.ts.is_empty(), "timestamp recorded");
    assert!(entry.remote_addr.starts_with("127.0.0.1:"), "sender IP recorded");
    // Entity name.
    assert_eq!(entry.entity_name.as_deref(), Some("cmd-c1"));
    // Redacted request body: secret masked, non-secret shown.
    let req_summary = entry.request_summary.as_deref().expect("request summary");
    assert!(req_summary.contains("token=***"), "secret masked: {req_summary}");
    assert!(req_summary.contains("name=alice"), "non-secret shown: {req_summary}");
    assert!(!req_summary.contains("s3cr3t"), "raw secret must not appear");
    // Response summary.
    let resp_summary = entry.response_summary.as_deref().expect("response summary");
    assert!(resp_summary.contains("status=succeeded"), "got: {resp_summary}");

    // Defence in depth: the secret appears in NO field of the serialised entry.
    let json = serde_json::to_string(entry).unwrap();
    assert!(!json.contains("s3cr3t"), "secret leaked into the log entry: {json}");
}

/// A 404 (unknown command) still logs time, IP, and an error response summary,
/// with no request summary (resolution failed before a body summary is built).
#[tokio::test]
async fn request_log_records_errors() {
    let pool = fresh_pool().await;
    let (router, server_state) = router_with_state(pool, Some(TEST_TOKEN));

    let (status, _) =
        send(router, post_command_run("ghost", Some(TEST_TOKEN), false)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let log = server_state.request_log.snapshot();
    let entry = log.last().expect("a request was logged");
    assert!(!entry.ts.is_empty());
    assert!(entry.remote_addr.starts_with("127.0.0.1:"));
    assert_eq!(
        entry.response_summary.as_deref(),
        Some("error=notFound")
    );
    // The logged path carries the REAL reference, not the `:reference` template.
    assert_eq!(entry.path, "/api/command/ghost/run");
}

/// An auth rejection (wrong token) still logs the REAL request path with the
/// slug the caller used — so a 401 in the log shows what was being called.
#[tokio::test]
async fn request_log_path_shows_real_slug_on_auth_failure() {
    let pool = fresh_pool().await;
    storage_commands::upsert(&pool, &command("c1", "true", Some("deploy"), true))
        .await
        .unwrap();
    let (router, server_state) = router_with_state(pool, Some(TEST_TOKEN));

    let (status, _) =
        send(router, post_command_run("deploy", Some("wrong-token"), false)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let entry = server_state
        .request_log
        .snapshot()
        .pop()
        .expect("a request was logged");
    assert_eq!(entry.path, "/api/command/deploy/run", "real slug logged on 401");
    assert_eq!(entry.response_summary.as_deref(), Some("error=unauthorized"));
}

// ---------------------------------------------------------------------------
// History: API-triggered runs are recorded AND finalised in the backend
// ---------------------------------------------------------------------------

/// A waited command run is recorded in History as a `commandRun` and finalised
/// to a terminal status (`succeeded`) entirely in the backend — no UI needed.
#[tokio::test]
async fn command_run_recorded_and_finalised_in_history() {
    let pool = fresh_pool().await;
    storage_commands::upsert(&pool, &command("c1", "exit 0", Some("ok"), true))
        .await
        .unwrap();
    let router = router_with_token(pool.clone(), Some(TEST_TOKEN));

    let (status, body) = send(router, post_command_run("ok", Some(TEST_TOKEN), true)).await;
    assert_eq!(status, StatusCode::OK);
    let exec_id = body["executionId"].as_str().expect("execution id").to_string();

    let (kind, run_status) = history_row(&pool, &exec_id)
        .await
        .expect("a history row was written");
    assert_eq!(kind, "commandRun");
    assert_eq!(run_status, "succeeded", "finalised to terminal status");
}

/// A non-zero command run is finalised as `failed` in History.
#[tokio::test]
async fn failed_command_run_finalised_as_failed_in_history() {
    let pool = fresh_pool().await;
    storage_commands::upsert(&pool, &command("c1", "exit 7", Some("boom"), true))
        .await
        .unwrap();
    let router = router_with_token(pool.clone(), Some(TEST_TOKEN));

    let (_, body) = send(router, post_command_run("boom", Some(TEST_TOKEN), true)).await;
    let exec_id = body["executionId"].as_str().unwrap().to_string();

    let (_, run_status) = history_row(&pool, &exec_id).await.unwrap();
    assert_eq!(run_status, "failed");
}

/// A waited workflow run is recorded as a `workflowRun` and finalised to a
/// terminal status in History.
#[tokio::test]
async fn workflow_run_recorded_and_finalised_in_history() {
    let pool = fresh_pool().await;
    storage_commands::upsert(&pool, &command("wf-cmd", "exit 0", None, false))
        .await
        .unwrap();
    storage_workflows::upsert(&pool, &workflow("w1", "wf-cmd", "pipeline"))
        .await
        .unwrap();
    let router = router_with_token(pool.clone(), Some(TEST_TOKEN));

    let req = Request::builder()
        .method("POST")
        .uri("/api/workflow/pipeline/run?wait=true")
        .header("authorization", format!("Bearer {TEST_TOKEN}"))
        .body(Body::empty())
        .unwrap();
    let (status, body) = send(router, req).await;
    assert_eq!(status, StatusCode::OK);
    let exec_id = body["executionId"].as_str().expect("execution id").to_string();

    let (kind, run_status) = history_row(&pool, &exec_id)
        .await
        .expect("a workflow history row was written");
    assert_eq!(kind, "workflowRun");
    assert_eq!(run_status, "succeeded");
}
