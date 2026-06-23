//! Integration tests for variable resolution in the executor.
//!
//! These tests fork real child processes via `spawn_execution`, listen
//! on the `execution-event` Tauri event, and assert the substituted
//! script ran exactly as expected. We deliberately do NOT mock the
//! parser→executor boundary — past failures (see failures.md) showed
//! that mocked tests around the IPC layer happily passed while the
//! real wire shape was broken.
//!
//! Unix-only because the test command itself is `bash -c 'echo …'`.
//! Windows would need a separate PowerShell-flavoured spec.

#![cfg(unix)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use procmix_lib::core::executor::{
    spawn_execution, ExecuteRequest, ExecutionEvent, ExecutionTarget, ExecutorError, ExecutorState,
    EXECUTION_EVENT,
};
use procmix_lib::storage::commands::VariableSpec;
use tauri::test::mock_builder;
use tauri::Listener;

/// Build a mock Tauri app with a fresh `ExecutorState` and an
/// `execution-event` listener that pushes every received event into a
/// shared Vec. Returns the app handle, the executor state, and the
/// collector.
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
        let payload = ev.payload();
        if let Ok(parsed) = serde_json::from_str::<ExecutionEvent>(payload) {
            events_for_listener.lock().unwrap().push(parsed);
        }
    });
    (handle, state, events)
}

/// Poll the collected events until a terminal one (Finished / Error /
/// Cancelled) appears, or the timeout fires. Returns the full slice so
/// callers can introspect stdout lines.
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

#[tokio::test]
async fn echo_substitutes_variable_from_values_and_runs_successfully() {
    let (app, state, events) = make_app();

    let mut values = BTreeMap::new();
    values.insert("who".to_string(), "world".to_string());

    let req = ExecuteRequest {
        script: "echo \"hi ${who}\"".to_string(),
        shell: Some("bash".to_string()),
        args: None,
        working_dir: None,
        env: None,
        command_id: None,
        execution_id: None,
        elevated: false,
        admin_password: None,
        variables: Vec::new(),
        variable_values: values,
        workflow_run_id: None,
        timeout_seconds: None,
        output_schema: None,
        capture_output: false,
        silent: false,
        target: ExecutionTarget::Local,
        ssh_password: None,
    };

    let id = spawn_execution(app, state, req)
        .await
        .expect("spawn_execution succeeded");
    assert!(!id.is_empty(), "execution id is non-empty");

    let collected = wait_terminal(events, Duration::from_secs(5)).await;
    let finished = collected
        .iter()
        .find_map(|e| match e {
            ExecutionEvent::Finished { exit_code, .. } => Some(*exit_code),
            _ => None,
        })
        .expect("Finished event arrived before timeout");
    assert_eq!(finished, Some(0), "echo should exit 0");

    let stdout: String = collected
        .iter()
        .filter_map(|e| match e {
            ExecutionEvent::Stdout { line, .. } => Some(line.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        stdout.contains("hi world"),
        "stdout should contain substituted text, got: {stdout:?}"
    );
}

#[tokio::test]
async fn missing_variable_without_default_returns_typed_error_and_does_not_spawn() {
    let (app, state, events) = make_app();

    let req = ExecuteRequest {
        script: "echo ${missing}".to_string(),
        shell: Some("bash".to_string()),
        args: None,
        working_dir: None,
        env: None,
        command_id: None,
        execution_id: None,
        elevated: false,
        admin_password: None,
        // No spec for `missing`, no value supplied — must error before spawn.
        variables: vec![VariableSpec {
            name: "other".to_string(),
            default_value: Some("ignored".to_string()),
            prompt_at_runtime: false,
            description: None,
            sensitive: false,
        }],
        variable_values: BTreeMap::new(),
        workflow_run_id: None,
        timeout_seconds: None,
        output_schema: None,
        capture_output: false,
        silent: false,
        target: ExecutionTarget::Local,
        ssh_password: None,
    };

    let err = spawn_execution(app, state, req)
        .await
        .expect_err("spawn_execution should fail with a typed error");

    // The error is a JSON-encoded `ExecutorError` — parse it and assert
    // the code is `missingVariable` (the JS bridge dispatches on this).
    let parsed: ExecutorError =
        serde_json::from_str(&err).expect("error string is valid ExecutorError JSON");
    assert_eq!(parsed.code, "missingVariable");
    assert!(
        parsed.message.contains("missing"),
        "message should mention missing variable, got: {}",
        parsed.message
    );

    // Give any (errant) child process a moment to emit anything — if a
    // process WAS spawned despite the error, the listener would catch
    // its events. The list must remain empty.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let collected = events.lock().unwrap().clone();
    assert!(
        collected.is_empty(),
        "no execution events should be emitted when resolution fails, got {} events",
        collected.len()
    );
}

#[tokio::test]
async fn variable_default_value_is_used_when_no_value_supplied() {
    let (app, state, events) = make_app();

    let req = ExecuteRequest {
        script: "echo \"greetings ${who}\"".to_string(),
        shell: Some("bash".to_string()),
        args: None,
        working_dir: None,
        env: None,
        command_id: None,
        execution_id: None,
        elevated: false,
        admin_password: None,
        // Spec carries a default, caller supplies no value — default wins.
        variables: vec![VariableSpec {
            name: "who".to_string(),
            default_value: Some("everyone".to_string()),
            prompt_at_runtime: false,
            description: None,
            sensitive: false,
        }],
        variable_values: BTreeMap::new(),
        workflow_run_id: None,
        timeout_seconds: None,
        output_schema: None,
        capture_output: false,
        silent: false,
        target: ExecutionTarget::Local,
        ssh_password: None,
    };

    spawn_execution(app, state, req).await.expect("spawn ok");
    let collected = wait_terminal(events, Duration::from_secs(5)).await;
    let stdout: String = collected
        .iter()
        .filter_map(|e| match e {
            ExecutionEvent::Stdout { line, .. } => Some(line.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        stdout.contains("greetings everyone"),
        "spec default should be used, stdout was: {stdout:?}"
    );
}
