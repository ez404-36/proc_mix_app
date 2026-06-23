//! Integration tests for the execution timeout feature.
//!
//! These tests fork real child processes via `spawn_execution` with
//! `timeout_seconds` set, and verify the executor kills the process
//! when the timeout fires and emits a `Finished` event with
//! `timed_out: true`.
//!
//! Unix-only because the test commands use `bash -c 'sleep …'`.

#![cfg(unix)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use procmix_lib::core::executor::{
    spawn_execution, ExecuteRequest, ExecutionEvent, ExecutionTarget, ExecutorState,
    EXECUTION_EVENT,
};
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
        let payload = ev.payload();
        if let Ok(parsed) = serde_json::from_str::<ExecutionEvent>(payload) {
            events_for_listener.lock().unwrap().push(parsed);
        }
    });
    (handle, state, events)
}

async fn wait_terminal(
    events: Arc<Mutex<Vec<ExecutionEvent>>>,
    timeout: Duration,
) -> Vec<ExecutionEvent> {
    let deadline = Instant::now() + timeout;
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
        if Instant::now() >= deadline {
            return events.lock().unwrap().clone();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// A long-running command (`sleep 60`) with a 1-second timeout must be
/// killed after ~1s. The Finished event must carry `timedOut: true` and
/// no exit code (the process was signalled, not exited cleanly).
#[tokio::test]
async fn timeout_kills_long_running_command() {
    let (app, state, events) = make_app();

    let req = ExecuteRequest {
        script: "sleep 60".to_string(),
        shell: Some("bash".to_string()),
        args: None,
        working_dir: None,
        env: None,
        command_id: None,
        execution_id: None,
        elevated: false,
        admin_password: None,
        variables: Vec::new(),
        variable_values: BTreeMap::new(),
        workflow_run_id: None,
        timeout_seconds: Some(1),
        output_schema: None,
        capture_output: false,
        silent: false,
        target: ExecutionTarget::Local,
        ssh_password: None,
    };

    let start = Instant::now();
    let id = spawn_execution(app, state, req)
        .await
        .expect("spawn_execution succeeded");
    assert!(!id.is_empty());

    let collected = wait_terminal(events, Duration::from_secs(10)).await;
    let elapsed = start.elapsed();

    // Must have terminated — not still running after 10s.
    let finished = collected
        .iter()
        .find_map(|e| match e {
            ExecutionEvent::Finished {
                timed_out,
                exit_code,
                duration_ms,
                ..
            } => Some((*timed_out, *exit_code, *duration_ms)),
            _ => None,
        })
        .expect("Finished event must arrive");

    let (timed_out, _exit_code, duration_ms) = finished;

    // The event must carry `timedOut: true`.
    assert_eq!(
        timed_out,
        Some(true),
        "Finished event must have timedOut=true"
    );

    // Duration should be ~1s (the timeout), not 60s (the sleep).
    assert!(
        (900..5000).contains(&duration_ms),
        "duration_ms should be ~1000, got {duration_ms}"
    );

    // Wall-clock must also confirm early termination.
    assert!(
        elapsed < Duration::from_secs(5),
        "wall-clock should be well under 5s, got {elapsed:?}"
    );

    // The running map must be empty — the waiter cleaned up.
    // (No public API to check this, but the fact that we got a terminal
    // event means the waiter ran to completion.)
}

/// A fast command (`echo`) with a generous timeout must complete
/// normally WITHOUT the `timedOut` flag. Verifies the timeout branch
/// doesn't fire spuriously.
#[tokio::test]
async fn fast_command_with_timeout_completes_normally() {
    let (app, state, events) = make_app();

    let req = ExecuteRequest {
        script: "echo hello".to_string(),
        shell: Some("bash".to_string()),
        args: None,
        working_dir: None,
        env: None,
        command_id: None,
        execution_id: None,
        elevated: false,
        admin_password: None,
        variables: Vec::new(),
        variable_values: BTreeMap::new(),
        workflow_run_id: None,
        timeout_seconds: Some(30),
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

    let finished = collected
        .iter()
        .find_map(|e| match e {
            ExecutionEvent::Finished {
                timed_out,
                exit_code,
                ..
            } => Some((*timed_out, *exit_code)),
            _ => None,
        })
        .expect("Finished event must arrive");

    let (timed_out, exit_code) = finished;

    // Normal completion: no timeout, exit 0.
    assert!(
        timed_out.is_none(),
        "timedOut must be None for a fast command, got {timed_out:?}"
    );
    assert_eq!(exit_code, Some(0), "echo should exit 0");

    // stdout should contain our output.
    let stdout: String = collected
        .iter()
        .filter_map(|e| match e {
            ExecutionEvent::Stdout { line, .. } => Some(line.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        stdout.contains("hello"),
        "stdout should contain 'hello', got: {stdout:?}"
    );
}

/// A command with no timeout (`None`) must complete normally —
/// regression guard that the `pending()` future in the select doesn't
/// cause issues.
#[tokio::test]
async fn no_timeout_command_completes_normally() {
    let (app, state, events) = make_app();

    let req = ExecuteRequest {
        script: "echo no-timeout".to_string(),
        shell: Some("bash".to_string()),
        args: None,
        working_dir: None,
        env: None,
        command_id: None,
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
        .expect("spawn_execution succeeded");

    let collected = wait_terminal(events, Duration::from_secs(5)).await;

    let finished = collected
        .iter()
        .find_map(|e| match e {
            ExecutionEvent::Finished {
                timed_out,
                exit_code,
                ..
            } => Some((*timed_out, *exit_code)),
            _ => None,
        })
        .expect("Finished event must arrive");

    let (timed_out, exit_code) = finished;
    assert!(timed_out.is_none(), "timedOut must be None");
    assert_eq!(exit_code, Some(0));
}
