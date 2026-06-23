//! Integration tests for the post-audit security hardening of the executor.
//!
//! - M1: a `sensitive` variable's resolved value must be redacted in the
//!   streamed `stdout`/`stderr` events (and therefore in anything the frontend
//!   derives from them, including history).
//! - M3: a command whose `working_dir` does not exist must fail fast with the
//!   `INVALID_WORKING_DIR:` sentinel BEFORE any child is spawned.
//!
//! Unix-only because the test commands are `bash -c 'echo …'`.

#![cfg(unix)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use procmix_lib::core::executor::{
    spawn_execution, ExecuteRequest, ExecutionEvent, ExecutionTarget, ExecutorState,
    ERR_INVALID_WORKING_DIR,
    EXECUTION_EVENT,
};
use procmix_lib::storage::commands::VariableSpec;
use tauri::test::mock_builder;
use tauri::Listener;

fn make_app() -> (
    tauri::AppHandle<tauri::test::MockRuntime>,
    Arc<ExecutorState>,
    Arc<Mutex<Vec<ExecutionEvent>>>,
) {
    let app = mock_builder()
        .build(tauri::generate_context!())
        .expect("mock_builder build");
    let handle = app.handle().clone();
    let state = Arc::new(ExecutorState::new());
    let events: Arc<Mutex<Vec<ExecutionEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let events_for_listener = events.clone();
    handle.listen(EXECUTION_EVENT, move |ev| {
        if let Ok(parsed) = serde_json::from_str::<ExecutionEvent>(ev.payload()) {
            events_for_listener.lock().unwrap().push(parsed);
        }
    });
    (handle, state, events)
}

async fn wait_terminal(
    events: Arc<Mutex<Vec<ExecutionEvent>>>,
    timeout: Duration,
) -> Vec<ExecutionEvent> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        {
            let guard = events.lock().unwrap();
            let has_terminal = guard.iter().any(|e| {
                matches!(
                    e,
                    ExecutionEvent::Finished { .. }
                        | ExecutionEvent::Error { .. }
                        | ExecutionEvent::Cancelled { .. }
                )
            });
            if has_terminal {
                return guard.clone();
            }
        }
        if std::time::Instant::now() >= deadline {
            return events.lock().unwrap().clone();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn stdout_lines(events: &[ExecutionEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match e {
            ExecutionEvent::Stdout { line, .. } => Some(line.clone()),
            _ => None,
        })
        .collect()
}

/// M1: a command that echoes the value of a `sensitive` variable must NOT leak
/// that value in the streamed stdout — it is replaced with `***`.
#[tokio::test]
async fn sensitive_variable_value_is_redacted_in_stdout() {
    let (app, state, events) = make_app();

    let mut values = BTreeMap::new();
    values.insert("token".to_string(), "s3cr3t-token".to_string());

    let req = ExecuteRequest {
        script: "echo using ${token} now".to_string(),
        shell: Some("bash".to_string()),
        args: None,
        working_dir: None,
        env: None,
        command_id: Some("cmd-secret".to_string()),
        execution_id: None,
        elevated: false,
        admin_password: None,
        variables: vec![VariableSpec {
            name: "token".into(),
            default_value: None,
            prompt_at_runtime: false,
            description: None,
            sensitive: true,
        }],
        variable_values: values,
        workflow_run_id: None,
        timeout_seconds: None,
        output_schema: None,
        capture_output: false,
        silent: false,
        target: ExecutionTarget::Local,
        ssh_password: None,
    };

    spawn_execution(app, state, req)
        .await
        .expect("spawn_execution succeeded");

    let collected = wait_terminal(events, Duration::from_secs(5)).await;
    let lines = stdout_lines(&collected);
    let joined = lines.join("\n");

    assert!(
        !joined.contains("s3cr3t-token"),
        "sensitive value leaked in stdout: {joined:?}"
    );
    assert!(
        joined.contains("***"),
        "expected redaction placeholder in stdout: {joined:?}"
    );
}

/// M1 negative: a NON-sensitive variable value passes through unchanged.
#[tokio::test]
async fn non_sensitive_variable_value_is_not_redacted() {
    let (app, state, events) = make_app();

    let mut values = BTreeMap::new();
    values.insert("name".to_string(), "alice".to_string());

    let req = ExecuteRequest {
        script: "echo hello ${name}".to_string(),
        shell: Some("bash".to_string()),
        args: None,
        working_dir: None,
        env: None,
        command_id: Some("cmd-plain".to_string()),
        execution_id: None,
        elevated: false,
        admin_password: None,
        variables: vec![VariableSpec {
            name: "name".into(),
            default_value: None,
            prompt_at_runtime: false,
            description: None,
            sensitive: false,
        }],
        variable_values: values,
        workflow_run_id: None,
        timeout_seconds: None,
        output_schema: None,
        capture_output: false,
        silent: false,
        target: ExecutionTarget::Local,
        ssh_password: None,
    };

    spawn_execution(app, state, req)
        .await
        .expect("spawn_execution succeeded");

    let collected = wait_terminal(events, Duration::from_secs(5)).await;
    let joined = stdout_lines(&collected).join("\n");
    assert!(
        joined.contains("alice"),
        "non-sensitive value should appear verbatim: {joined:?}"
    );
}

/// M3: a non-existent `working_dir` must be rejected before spawn with the
/// `INVALID_WORKING_DIR:` sentinel, and no child process should run.
#[tokio::test]
async fn nonexistent_working_dir_fails_fast() {
    let (app, state, events) = make_app();

    let req = ExecuteRequest {
        script: "echo should-not-run".to_string(),
        shell: Some("bash".to_string()),
        args: None,
        working_dir: Some("/this/path/does/not/exist/procmix".into()),
        env: None,
        command_id: Some("cmd-baddir".to_string()),
        execution_id: None,
        elevated: false,
        admin_password: None,
        variables: Vec::new(),
        variable_values: BTreeMap::new(),
        workflow_run_id: None,
        timeout_seconds: None,
        output_schema: None,
        capture_output: false,
        silent: false,
        target: ExecutionTarget::Local,
        ssh_password: None,
    };

    let result = spawn_execution(app, state, req).await;
    let err = result.expect_err("spawn must fail for a non-existent working_dir");
    assert!(
        err.starts_with(ERR_INVALID_WORKING_DIR),
        "expected INVALID_WORKING_DIR sentinel, got: {err}"
    );

    // No execution events at all: the failure is pre-spawn, so the command
    // never ran.
    let collected = wait_terminal(events, Duration::from_millis(300)).await;
    assert!(
        collected.is_empty(),
        "no events should be emitted for a pre-spawn failure, got: {collected:?}"
    );
}

/// M3: an existing `working_dir` runs normally (regression guard so the new
/// validation doesn't reject valid directories).
#[tokio::test]
async fn existing_working_dir_runs() {
    let (app, state, events) = make_app();

    let req = ExecuteRequest {
        script: "pwd".to_string(),
        shell: Some("bash".to_string()),
        args: None,
        working_dir: Some("/tmp".into()),
        env: None,
        command_id: Some("cmd-gooddir".to_string()),
        execution_id: None,
        elevated: false,
        admin_password: None,
        variables: Vec::new(),
        variable_values: BTreeMap::new(),
        workflow_run_id: None,
        timeout_seconds: None,
        output_schema: None,
        capture_output: false,
        silent: false,
        target: ExecutionTarget::Local,
        ssh_password: None,
    };

    spawn_execution(app, state, req)
        .await
        .expect("spawn_execution should succeed for an existing dir");

    let collected = wait_terminal(events, Duration::from_secs(5)).await;
    let finished = collected
        .iter()
        .any(|e| matches!(e, ExecutionEvent::Finished { .. }));
    assert!(finished, "command in a valid dir should finish");
}
