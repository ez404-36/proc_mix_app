//! Integration tests for the workflow execution engine.
//!
//! Like `execute_with_variables.rs`, these tests cross the real OS
//! boundary: they fork actual child processes through the executor and
//! listen on the real Tauri event channels. We deliberately do NOT mock
//! the executor→engine boundary — the whole point of the completion
//! channel is exercised by running a real `bash -c 'exit N'` and
//! asserting the engine picked the branch matching N.
//!
//! Unix-only because the test commands are `bash` invocations. Windows
//! would need a PowerShell-flavoured spec.

#![cfg(unix)]

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use procmix_lib::core::executor::{
    spawn_execution_with_completion, ExecuteRequest, ExecutorState, NodeOutcome, TerminalStatus,
};
use procmix_lib::core::workflow::{
    cancel_workflow, execute_workflow, WorkflowEvent, WorkflowExecutorState, WORKFLOW_EVENT,
};
use procmix_lib::storage::commands::{
    CommandRecord, OutputFieldRecord, OutputSchemaRecord, VariableSpec,
};
use procmix_lib::storage::workflows::{
    NodePosition, WorkflowEdgeRecord, WorkflowNodeRecord, WorkflowRecord,
};
use tauri::test::mock_builder;
use tauri::Listener;

/// Build a mock Tauri app plus a fresh executor + workflow state and a
/// `workflow-event` collector. Returns the handle, both states, and the
/// shared event Vec.
#[allow(clippy::type_complexity)]
fn make_app() -> (
    tauri::AppHandle<tauri::test::MockRuntime>,
    Arc<ExecutorState>,
    Arc<WorkflowExecutorState>,
    Arc<Mutex<Vec<WorkflowEvent>>>,
) {
    let app = mock_builder()
        .build(tauri::generate_context!())
        .expect("mock_builder build");
    let handle = app.handle().clone();
    let executor_state = Arc::new(ExecutorState::new());
    let workflow_state = Arc::new(WorkflowExecutorState::new());
    let events: Arc<Mutex<Vec<WorkflowEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let events_for_listener = events.clone();
    handle.listen(WORKFLOW_EVENT, move |ev| {
        if let Ok(parsed) = serde_json::from_str::<WorkflowEvent>(ev.payload()) {
            events_for_listener.lock().unwrap().push(parsed);
        }
    });
    (handle, executor_state, workflow_state, events)
}

/// Poll the collected workflow events until a terminal one appears or
/// the timeout fires, then return the full slice.
async fn wait_workflow_terminal(
    events: Arc<Mutex<Vec<WorkflowEvent>>>,
    timeout: Duration,
) -> Vec<WorkflowEvent> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        {
            let guard = events.lock().unwrap();
            let terminal = guard.iter().any(|e| {
                matches!(
                    e,
                    WorkflowEvent::WorkflowFinished { .. }
                        | WorkflowEvent::WorkflowCancelled { .. }
                        | WorkflowEvent::WorkflowError { .. }
                )
            });
            if terminal {
                return guard.clone();
            }
        }
        if std::time::Instant::now() >= deadline {
            return events.lock().unwrap().clone();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Minimal `CommandRecord` running a fixed shell script. Every optional
/// field is defaulted so tests only specify what they care about.
fn command(id: &str, script: &str) -> CommandRecord {
    CommandRecord {
        id: id.into(),
        name: format!("name-{id}"),
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
        created_at: "2026-05-29T00:00:00Z".into(),
        updated_at: "2026-05-29T00:00:00Z".into(),
        last_run_at: None,
        run_count: 0,
        run_as_admin: false,
        variables: Vec::new(),
        timeout_seconds: None,
        output_schema: None,
    }
}

/// `CommandRecord` declaring a single `${who}` variable with the given
/// default (None = no default, so a value MUST be supplied or the run
/// fails). The script exits 0 only when `${who}` substitutes to `world`,
/// so the workflow engine's `NodeFinished` exit code proves the value
/// reached the executor and was substituted.
fn command_with_var(id: &str, default: Option<&str>) -> CommandRecord {
    let mut cmd = command(id, "[ \"${who}\" = \"world\" ]");
    cmd.variables = vec![VariableSpec {
        name: "who".into(),
        default_value: default.map(Into::into),
        description: None,
        sensitive: false,
    }];
    cmd
}

fn node(id: &str, kind: &str, command_id: Option<&str>) -> WorkflowNodeRecord {
    WorkflowNodeRecord {
        id: id.into(),
        kind: kind.into(),
        command_id: command_id.map(Into::into),
        label: None,
        position: NodePosition { x: 0.0, y: 0.0 },
    }
}

fn edge(id: &str, source: &str, target: &str, branch: &str) -> WorkflowEdgeRecord {
    WorkflowEdgeRecord {
        id: id.into(),
        source: source.into(),
        target: target.into(),
        branch: branch.into(),
    }
}

/// start → condition(test) → then → end_ok
///                         → else → end_fail
///
/// The `test` command's exit code is supplied by the caller via its
/// script, so a single fixture exercises both branches.
fn branching_workflow(test_command_id: &str) -> WorkflowRecord {
    WorkflowRecord {
        id: "wf-branch".into(),
        name: "branch".into(),
        description: None,
        icon: None,
        nodes: vec![
            node("start", "start", None),
            node("cond", "condition", Some(test_command_id)),
            node("end_ok", "end", None),
            node("end_fail", "end", None),
        ],
        edges: vec![
            edge("e_start", "start", "cond", "out"),
            edge("e_then", "cond", "end_ok", "then"),
            edge("e_else", "cond", "end_fail", "else"),
        ],
        tags: Vec::new(),
        category_id: None,
        favorite: false,
        created_at: "2026-05-29T00:00:00Z".into(),
        updated_at: "2026-05-29T00:00:00Z".into(),
        last_run_at: None,
        run_count: 0,
    }
}

/// start → command(test) → end. Used by the cancellation test with a
/// long-running `sleep` command so the cancel signal lands mid-run.
fn linear_workflow(command_id: &str) -> WorkflowRecord {
    WorkflowRecord {
        id: "wf-linear".into(),
        name: "linear".into(),
        description: None,
        icon: None,
        nodes: vec![
            node("start", "start", None),
            node("step", "command", Some(command_id)),
            node("end", "end", None),
        ],
        edges: vec![
            edge("e_start", "start", "step", "out"),
            edge("e_step", "step", "end", "out"),
        ],
        tags: Vec::new(),
        category_id: None,
        favorite: false,
        created_at: "2026-05-29T00:00:00Z".into(),
        updated_at: "2026-05-29T00:00:00Z".into(),
        last_run_at: None,
        run_count: 0,
    }
}

#[tokio::test]
async fn cancel_mid_run_emits_workflow_cancelled() {
    let (app, exec_state, wf_state, events) = make_app();

    let mut commands = HashMap::new();
    // Long sleep so the run is reliably in-flight when we cancel.
    commands.insert("slow".to_string(), command("slow", "sleep 30"));

    let run_id = execute_workflow(
        app,
        exec_state,
        wf_state.clone(),
        linear_workflow("slow"),
        commands,
        HashMap::new(),
        false,
    )
    .await
    .expect("execute_workflow kicks off");

    // Wait until the node has actually started (so the child exists and
    // is registered) before cancelling, otherwise the cancel could race
    // ahead of the spawn.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let started = events
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, WorkflowEvent::NodeStarted { .. }));
        if started || std::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    cancel_workflow(wf_state, run_id)
        .await
        .expect("cancel succeeds");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;
    assert!(
        collected
            .iter()
            .any(|e| matches!(e, WorkflowEvent::WorkflowCancelled { .. })),
        "expected a cancelled event, events were: {collected:?}"
    );
    // A cancelled run must NOT also report finished.
    assert!(
        !collected
            .iter()
            .any(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. })),
        "cancelled run must not also finish"
    );
}

#[tokio::test]
async fn condition_exit_zero_takes_then_branch() {
    let (app, exec_state, wf_state, events) = make_app();

    let mut commands = HashMap::new();
    commands.insert("test-cmd".to_string(), command("test-cmd", "exit 0"));

    execute_workflow(
        app,
        exec_state,
        wf_state,
        branching_workflow("test-cmd"),
        commands,
        HashMap::new(),
        false,
    )
    .await
    .expect("execute_workflow kicks off");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;

    // The branch annotation must point at the `then` edge.
    let branch = collected
        .iter()
        .find_map(|e| match e {
            WorkflowEvent::BranchTaken {
                branch, edge_id, ..
            } => Some((branch.clone(), edge_id.clone())),
            _ => None,
        })
        .expect("a branchTaken event arrived");
    assert_eq!(branch.0, "then");
    assert_eq!(branch.1, "e_then");

    assert!(
        collected
            .iter()
            .any(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. })),
        "workflow should finish, events were: {collected:?}"
    );
}

#[tokio::test]
async fn condition_non_zero_takes_else_branch() {
    let (app, exec_state, wf_state, events) = make_app();

    let mut commands = HashMap::new();
    commands.insert("test-cmd".to_string(), command("test-cmd", "exit 3"));

    execute_workflow(
        app,
        exec_state,
        wf_state,
        branching_workflow("test-cmd"),
        commands,
        HashMap::new(),
        false,
    )
    .await
    .expect("execute_workflow kicks off");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;

    let branch = collected
        .iter()
        .find_map(|e| match e {
            WorkflowEvent::BranchTaken {
                branch, edge_id, ..
            } => Some((branch.clone(), edge_id.clone())),
            _ => None,
        })
        .expect("a branchTaken event arrived");
    assert_eq!(branch.0, "else");
    assert_eq!(branch.1, "e_else");

    // The condition node's exit code must be reported as 3.
    let exit = collected.iter().find_map(|e| match e {
        WorkflowEvent::NodeFinished { exit_code, .. } => Some(*exit_code),
        _ => None,
    });
    assert_eq!(exit, Some(Some(3)));

    assert!(collected
        .iter()
        .any(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. })));
}

#[tokio::test]
async fn unknown_command_emits_workflow_error() {
    let (app, exec_state, wf_state, events) = make_app();

    // No command resolved for the node's commandId.
    let commands: HashMap<String, CommandRecord> = HashMap::new();

    execute_workflow(
        app,
        exec_state,
        wf_state,
        branching_workflow("missing-cmd"),
        commands,
        HashMap::new(),
        false,
    )
    .await
    .expect("execute_workflow kicks off even with an unresolved command");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;
    let err = collected.iter().find_map(|e| match e {
        WorkflowEvent::WorkflowError { message, .. } => Some(message.clone()),
        _ => None,
    });
    let msg = err.expect("a workflowError event arrived");
    assert!(
        msg.contains("unknown command"),
        "error should mention the unknown command, got: {msg}"
    );
}

#[tokio::test]
async fn no_start_node_emits_workflow_error() {
    let (app, exec_state, wf_state, events) = make_app();

    let mut wf = branching_workflow("test-cmd");
    // Strip the start node so the runner rejects the graph.
    wf.nodes.retain(|n| n.kind != "start");
    let mut commands = HashMap::new();
    commands.insert("test-cmd".to_string(), command("test-cmd", "exit 0"));

    execute_workflow(
        app,
        exec_state,
        wf_state,
        wf,
        commands,
        HashMap::new(),
        false,
    )
    .await
    .expect("execute_workflow kicks off");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;
    assert!(
        collected.iter().any(|e| matches!(
            e,
            WorkflowEvent::WorkflowError { message, .. } if message.contains("no start node")
        )),
        "expected a no-start error, events were: {collected:?}"
    );
}

#[tokio::test]
async fn node_substitutes_supplied_variable_value() {
    let (app, exec_state, wf_state, events) = make_app();

    // Command's `${who}` has NO default — before this fix the workflow run
    // would fail with `missingVariable`. We supply the value per-node.
    let mut commands = HashMap::new();
    commands.insert("var-cmd".to_string(), command_with_var("var-cmd", None));

    // The command node in `linear_workflow` has id "step".
    let mut node_values: HashMap<String, BTreeMap<String, String>> = HashMap::new();
    let mut step_values = BTreeMap::new();
    step_values.insert("who".to_string(), "world".to_string());
    node_values.insert("step".to_string(), step_values);

    execute_workflow(
        app,
        exec_state,
        wf_state,
        linear_workflow("var-cmd"),
        commands,
        node_values,
        false,
    )
    .await
    .expect("execute_workflow kicks off");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;

    // The command exits 0 only if `${who}` substituted to "world".
    let exit = collected.iter().find_map(|e| match e {
        WorkflowEvent::NodeFinished { exit_code, .. } => Some(*exit_code),
        _ => None,
    });
    assert_eq!(
        exit,
        Some(Some(0)),
        "supplied variable should substitute → exit 0, events were: {collected:?}"
    );
    assert!(
        collected
            .iter()
            .any(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. })),
        "workflow should finish, events were: {collected:?}"
    );
}

#[tokio::test]
async fn node_falls_back_to_variable_default_when_no_value_supplied() {
    let (app, exec_state, wf_state, events) = make_app();

    // Command's `${who}` defaults to "world", and we supply NO per-node
    // value — the executor must fall back to the spec default.
    let mut commands = HashMap::new();
    commands.insert(
        "var-cmd".to_string(),
        command_with_var("var-cmd", Some("world")),
    );

    execute_workflow(
        app,
        exec_state,
        wf_state,
        linear_workflow("var-cmd"),
        commands,
        HashMap::new(),
        false,
    )
    .await
    .expect("execute_workflow kicks off");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;

    let exit = collected.iter().find_map(|e| match e {
        WorkflowEvent::NodeFinished { exit_code, .. } => Some(*exit_code),
        _ => None,
    });
    assert_eq!(
        exit,
        Some(Some(0)),
        "spec default should substitute → exit 0, events were: {collected:?}"
    );
}

// ----------------------------------------------------------------------
// Executor completion-channel tests.
//
// These lock the additive `spawn_execution_with_completion` contract:
// the optional channel must fire EXACTLY ONCE with the correct outcome
// on finish (exit 0 and non-zero) and on error. (Cancel is covered by
// the engine's branch tests indirectly and by the executor's own
// kill-tree tests; a standalone cancel race here would be flaky.)
// ----------------------------------------------------------------------

fn echo_request(script: &str) -> ExecuteRequest {
    ExecuteRequest {
        script: script.into(),
        shell: Some("bash".into()),
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
    }
}

#[tokio::test]
async fn completion_channel_reports_finished_exit_zero() {
    let app = mock_builder()
        .build(tauri::generate_context!())
        .expect("mock build");
    let state = Arc::new(ExecutorState::new());
    let (tx, rx) = tokio::sync::oneshot::channel::<NodeOutcome>();

    spawn_execution_with_completion(
        app.handle().clone(),
        state,
        echo_request("exit 0"),
        Some(tx),
    )
    .await
    .expect("spawn ok");

    let outcome = tokio::time::timeout(Duration::from_secs(5), rx)
        .await
        .expect("completion arrives before timeout")
        .expect("sender not dropped");
    assert_eq!(outcome.status, TerminalStatus::Finished);
    assert_eq!(outcome.exit_code, Some(0));
}

#[tokio::test]
async fn completion_channel_reports_finished_non_zero() {
    let app = mock_builder()
        .build(tauri::generate_context!())
        .expect("mock build");
    let state = Arc::new(ExecutorState::new());
    let (tx, rx) = tokio::sync::oneshot::channel::<NodeOutcome>();

    spawn_execution_with_completion(
        app.handle().clone(),
        state,
        echo_request("exit 7"),
        Some(tx),
    )
    .await
    .expect("spawn ok");

    let outcome = tokio::time::timeout(Duration::from_secs(5), rx)
        .await
        .expect("completion arrives before timeout")
        .expect("sender not dropped");
    assert_eq!(outcome.status, TerminalStatus::Finished);
    assert_eq!(outcome.exit_code, Some(7));
}

#[tokio::test]
async fn completion_channel_is_optional_none_does_not_panic() {
    // A `None` channel (every legacy caller via `spawn_execution`) must
    // run to completion without any completion signalling. We just
    // assert the spawn returns an id and the process is allowed to run.
    let app = mock_builder()
        .build(tauri::generate_context!())
        .expect("mock build");
    let state = Arc::new(ExecutorState::new());
    let id =
        spawn_execution_with_completion(app.handle().clone(), state, echo_request("exit 0"), None)
            .await
            .expect("spawn ok");
    assert!(!id.is_empty());
    // Give the waiter a moment to reap so the test doesn't leak a child.
    tokio::time::sleep(Duration::from_millis(300)).await;
}

/// Data-flow: node A extracts a `who` field from its stdout; node B
/// consumes it as `${who}`. B's script exits 0 only when the value
/// substituted to `world`, proving the extracted field reached the next
/// node's variable values via the engine's carry.
#[tokio::test]
async fn extracted_field_flows_into_next_node_variable() {
    let (app, exec_state, wf_state, events) = make_app();

    // Producer: prints JSON; a json schema extracts `who` from `.name`.
    let mut producer = command("producer", "echo '{\"name\":\"world\"}'");
    producer.output_schema = Some(OutputSchemaRecord {
        parser: "json".into(),
        source: Some("stdout".into()),
        pattern: None,
        delimiter: None,
        has_header: None,
        fields: vec![OutputFieldRecord {
            name: "who".into(),
            path: Some("name".into()),
            group: None,
            column: None,
            index: None,
            description: None,
        }],
        pipeline: Vec::new(),
        return_field: Some("who".into()),
        sample: None,
    });

    // Consumer: succeeds iff `${who}` substituted to `world`. Declares the
    // variable with NO default, so the only way it can be `world` is via
    // the upstream data-flow carry.
    let mut consumer = command("consumer", "[ \"${who}\" = \"world\" ]");
    consumer.variables = vec![VariableSpec {
        name: "who".into(),
        default_value: None,
        description: None,
        sensitive: false,
    }];

    let mut commands = HashMap::new();
    commands.insert("producer".to_string(), producer);
    commands.insert("consumer".to_string(), consumer);

    // start → A(producer) → B(consumer) → end
    let workflow = WorkflowRecord {
        id: "wf-dataflow".into(),
        name: "dataflow".into(),
        description: None,
        icon: None,
        nodes: vec![
            node("start", "start", None),
            node("a", "command", Some("producer")),
            node("b", "command", Some("consumer")),
            node("end", "end", None),
        ],
        edges: vec![
            edge("e_start", "start", "a", "out"),
            edge("e_ab", "a", "b", "out"),
            edge("e_be", "b", "end", "out"),
        ],
        tags: Vec::new(),
        category_id: None,
        favorite: false,
        created_at: "2026-05-29T00:00:00Z".into(),
        updated_at: "2026-05-29T00:00:00Z".into(),
        last_run_at: None,
        run_count: 0,
    };

    execute_workflow(
        app,
        exec_state,
        wf_state,
        workflow,
        commands,
        HashMap::new(),
        false,
    )
    .await
    .expect("execute_workflow kicks off");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;

    // Node B (consumer) must finish with exit 0 — i.e. it saw who=world.
    let b_exit = collected.iter().find_map(|e| match e {
        WorkflowEvent::NodeFinished {
            node_id, exit_code, ..
        } if node_id == "b" => Some(*exit_code),
        _ => None,
    });
    assert_eq!(
        b_exit,
        Some(Some(0)),
        "consumer must see the extracted ${{who}}=world via data-flow, events: {collected:?}"
    );

    assert!(
        collected
            .iter()
            .any(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. })),
        "workflow should finish"
    );
}

/// A node's own per-node variable value must WIN over a same-named field
/// carried from the predecessor (priority: user/prompt > data-flow).
#[tokio::test]
async fn node_variable_value_overrides_data_flow_field() {
    let (app, exec_state, wf_state, events) = make_app();

    let mut producer = command("producer", "echo '{\"name\":\"fromUpstream\"}'");
    producer.output_schema = Some(OutputSchemaRecord {
        parser: "json".into(),
        source: Some("stdout".into()),
        pattern: None,
        delimiter: None,
        has_header: None,
        fields: vec![OutputFieldRecord {
            name: "who".into(),
            path: Some("name".into()),
            group: None,
            column: None,
            index: None,
            description: None,
        }],
        pipeline: Vec::new(),
        return_field: Some("who".into()),
        sample: None,
    });

    // Consumer succeeds only if `${who}` is the OVERRIDE value, not the
    // upstream `fromUpstream`.
    let mut consumer = command("consumer", "[ \"${who}\" = \"override\" ]");
    consumer.variables = vec![VariableSpec {
        name: "who".into(),
        default_value: None,
        description: None,
        sensitive: false,
    }];

    let mut commands = HashMap::new();
    commands.insert("producer".to_string(), producer);
    commands.insert("consumer".to_string(), consumer);

    let workflow = WorkflowRecord {
        id: "wf-override".into(),
        name: "override".into(),
        description: None,
        icon: None,
        nodes: vec![
            node("start", "start", None),
            node("a", "command", Some("producer")),
            node("b", "command", Some("consumer")),
            node("end", "end", None),
        ],
        edges: vec![
            edge("e_start", "start", "a", "out"),
            edge("e_ab", "a", "b", "out"),
            edge("e_be", "b", "end", "out"),
        ],
        tags: Vec::new(),
        category_id: None,
        favorite: false,
        created_at: "2026-05-29T00:00:00Z".into(),
        updated_at: "2026-05-29T00:00:00Z".into(),
        last_run_at: None,
        run_count: 0,
    };

    // Per-node override for node B: who=override.
    let mut node_values = HashMap::new();
    let mut b_values = BTreeMap::new();
    b_values.insert("who".to_string(), "override".to_string());
    node_values.insert("b".to_string(), b_values);

    execute_workflow(
        app,
        exec_state,
        wf_state,
        workflow,
        commands,
        node_values,
        false,
    )
    .await
    .expect("execute_workflow kicks off");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;

    let b_exit = collected.iter().find_map(|e| match e {
        WorkflowEvent::NodeFinished {
            node_id, exit_code, ..
        } if node_id == "b" => Some(*exit_code),
        _ => None,
    });
    assert_eq!(
        b_exit,
        Some(Some(0)),
        "per-node value must override the data-flow field, events: {collected:?}"
    );
}
