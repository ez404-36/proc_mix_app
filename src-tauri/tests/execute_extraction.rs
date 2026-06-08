//! Integration tests for output extraction in the executor.
//!
//! These tests fork real child processes via `spawn_execution` with an
//! `output_schema` set, listen on the `execution-event` Tauri event, and
//! assert the `result` event is emitted with the right payload AND in the
//! right ORDER: after every `stdout` line and before the terminal
//! `finished` event. That ordering is a hard contract the frontend relies
//! on to attach the structured result before marking the run done.
//!
//! Unix-only because the test commands are `bash -c 'echo …'`.

#![cfg(unix)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use procmix_lib::core::executor::{
    spawn_execution, ExecuteRequest, ExecutionEvent, ExecutorState, EXECUTION_EVENT,
};
use procmix_lib::storage::commands::{OutputFieldRecord, OutputSchemaRecord};
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

fn request_with_schema(script: &str, schema: OutputSchemaRecord) -> ExecuteRequest {
    ExecuteRequest {
        script: script.to_string(),
        shell: Some("bash".to_string()),
        args: None,
        working_dir: None,
        env: None,
        command_id: Some("cmd-extract".to_string()),
        execution_id: None,
        elevated: false,
        admin_password: None,
        variables: Vec::new(),
        variable_values: BTreeMap::new(),
        workflow_run_id: None,
        timeout_seconds: None,
        output_schema: Some(schema),
        capture_output: false,
        silent: false,
    }
}

#[tokio::test]
async fn result_event_emitted_after_stdout_and_before_finished() {
    let (app, state, events) = make_app();

    // keyValue schema: the script prints two pairs.
    let schema = OutputSchemaRecord {
        parser: "keyValue".into(),
        source: Some("stdout".into()),
        pattern: None,
        delimiter: Some("=".into()),
        has_header: None,
        fields: vec![OutputFieldRecord {
            name: "name".into(),
            path: None,
            group: None,
            column: None,
            index: None,
            description: None,
        }],
        pipeline: Vec::new(),
        return_field: Some("name".into()),
        sample: None,
    };
    let req = request_with_schema("printf 'name=alice\\nrole=admin\\n'", schema);

    spawn_execution(app, state, req)
        .await
        .expect("spawn_execution succeeded");

    let collected = wait_terminal(events, Duration::from_secs(5)).await;

    // Locate indices for ordering assertions.
    let result_idx = collected
        .iter()
        .position(|e| matches!(e, ExecutionEvent::Result { .. }))
        .expect("a result event was emitted");
    let finished_idx = collected
        .iter()
        .position(|e| matches!(e, ExecutionEvent::Finished { .. }))
        .expect("a finished event was emitted");
    let last_stdout_idx = collected
        .iter()
        .rposition(|e| matches!(e, ExecutionEvent::Stdout { .. }))
        .expect("at least one stdout event");

    assert!(
        last_stdout_idx < result_idx,
        "result must come AFTER the last stdout line ({last_stdout_idx} !< {result_idx})"
    );
    assert!(
        result_idx < finished_idx,
        "result must come BEFORE finished ({result_idx} !< {finished_idx})"
    );

    // Payload assertions.
    match &collected[result_idx] {
        ExecutionEvent::Result {
            fields,
            return_value,
            error,
            ..
        } => {
            assert!(error.is_none(), "extraction should succeed: {error:?}");
            assert_eq!(fields["name"], "alice");
            assert_eq!(*return_value, serde_json::json!("alice"));
        }
        other => panic!("expected Result, got {other:?}"),
    }
}

#[tokio::test]
async fn result_event_carries_error_on_invalid_json() {
    let (app, state, events) = make_app();

    let schema = OutputSchemaRecord {
        parser: "json".into(),
        source: Some("stdout".into()),
        pattern: None,
        delimiter: None,
        has_header: None,
        fields: Vec::new(),
        pipeline: Vec::new(),
        return_field: None,
        sample: None,
    };
    // Not JSON → extraction fails, but the command itself exits 0.
    let req = request_with_schema("echo 'this is not json'", schema);

    spawn_execution(app, state, req)
        .await
        .expect("spawn_execution succeeded");

    let collected = wait_terminal(events, Duration::from_secs(5)).await;

    let result = collected
        .iter()
        .find_map(|e| match e {
            ExecutionEvent::Result { error, .. } => Some(error.clone()),
            _ => None,
        })
        .expect("a result event was emitted");
    assert!(
        result.is_some(),
        "extraction error must be reported on the result event"
    );

    // The command still finished successfully — extraction is non-fatal.
    let exit = collected.iter().find_map(|e| match e {
        ExecutionEvent::Finished { exit_code, .. } => Some(*exit_code),
        _ => None,
    });
    assert_eq!(exit, Some(Some(0)), "command exits 0 despite extract error");
}

#[tokio::test]
async fn no_schema_emits_no_result_event() {
    let (app, state, events) = make_app();

    let mut req = request_with_schema(
        "echo hi",
        OutputSchemaRecord {
            parser: "raw".into(),
            source: None,
            pattern: None,
            delimiter: None,
            has_header: None,
            fields: Vec::new(),
            pipeline: Vec::new(),
            return_field: None,
            sample: None,
        },
    );
    // Override: NO schema → the run must not emit any result event.
    req.output_schema = None;

    spawn_execution(app, state, req)
        .await
        .expect("spawn_execution succeeded");

    let collected = wait_terminal(events, Duration::from_secs(5)).await;
    assert!(
        !collected
            .iter()
            .any(|e| matches!(e, ExecutionEvent::Result { .. })),
        "a run without a schema must not emit a result event"
    );
}
