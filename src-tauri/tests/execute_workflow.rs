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
    spawn_execution_with_completion, ExecuteRequest, ExecutionTarget, ExecutorState, NodeOutcome,
    TerminalStatus,
};
use procmix_lib::core::workflow::{
    cancel_workflow, execute_workflow, execute_workflow_from, WorkflowEvent, WorkflowExecutorState,
    WORKFLOW_EVENT,
};
use procmix_lib::core::workflow_condition::{Condition, Op, Subject};
use procmix_lib::storage::commands::{
    CommandRecord, OutputFieldRecord, OutputSchemaRecord, VariableSpec,
};
use procmix_lib::storage::workflows::{
    DataAssignmentRecord, DataSourceRecord, LoopConfigRecord, NodePosition, RetryConfigRecord,
    SwitchCaseRecord, WorkflowEdgeRecord, WorkflowNodeRecord, WorkflowRecord,
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
        scope: None,
        workflow_id: None,
        target: None,
        api_slug: None,
        api_enabled: false,
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
        prompt_at_runtime: false,
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
        api_slug: None,
        api_enabled: false,
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
        api_slug: None,
        api_enabled: false,
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
        target: ExecutionTarget::Local,
        ssh_password: None,
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
        max_columns: None,
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
        prompt_at_runtime: false,
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
        api_slug: None,
        api_enabled: false,
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
        max_columns: None,
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
        prompt_at_runtime: false,
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
        api_slug: None,
        api_enabled: false,
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

// ---- §3 switch end-to-end --------------------------------------------------

/// A `switch` node whose test command's exit code drives the case selection:
///
/// start → switch(test) ── case:zero → end_zero
///                       ├─ case:low  → end_low
///                       └─ default   → end_default
///
/// `case:zero` matches `exitCode == 0`, `case:low` matches `exitCode < 10`.
/// The `default` edge catches everything else.
fn switch_workflow(test_command_id: &str) -> WorkflowRecord {
    let switch_node = WorkflowNodeRecord {
        id: "sw".into(),
        kind: "switch".into(),
        command_id: Some(test_command_id.into()),
        label: None,
        condition: None,
        cases: vec![
            SwitchCaseRecord {
                id: "zero".into(),
                condition: Condition {
                    subject: Subject::ExitCode,
                    op: Op::Eq,
                    value: "0".into(),
                },
            },
            SwitchCaseRecord {
                id: "low".into(),
                condition: Condition {
                    subject: Subject::ExitCode,
                    op: Op::Lt,
                    value: "10".into(),
                },
            },
        ],
        loop_config: None,
        retry: None,
        data: Vec::new(),
        variable_sources: std::collections::BTreeMap::new(),
        parser: None,
        text: None,
        join_node_id: None,
        position: NodePosition { x: 0.0, y: 0.0 },
    };
    WorkflowRecord {
        id: "wf-switch".into(),
        name: "switch".into(),
        description: None,
        icon: None,
        nodes: vec![
            node("start", "start", None),
            switch_node,
            node("end_zero", "end", None),
            node("end_low", "end", None),
            node("end_default", "end", None),
        ],
        edges: vec![
            edge("e_start", "start", "sw", "out"),
            edge("e_zero", "sw", "end_zero", "case:zero"),
            edge("e_low", "sw", "end_low", "case:low"),
            edge("e_default", "sw", "end_default", "default"),
        ],
        tags: Vec::new(),
        category_id: None,
        favorite: false,
        created_at: "2026-05-29T00:00:00Z".into(),
        updated_at: "2026-05-29T00:00:00Z".into(),
        last_run_at: None,
        run_count: 0,
        api_slug: None,
        api_enabled: false,
    }
}

/// Run the switch fixture with a test command exiting `code`, returning the
/// `(branch, edgeId)` from the emitted `branchTaken` event.
async fn run_switch_with_exit(code: i32) -> (String, String) {
    let (app, exec_state, wf_state, events) = make_app();
    let mut commands = HashMap::new();
    commands.insert(
        "test-cmd".to_string(),
        command("test-cmd", &format!("exit {code}")),
    );

    execute_workflow(
        app,
        exec_state,
        wf_state,
        switch_workflow("test-cmd"),
        commands,
        HashMap::new(),
        false,
    )
    .await
    .expect("execute_workflow kicks off");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;
    assert!(
        collected
            .iter()
            .any(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. })),
        "switch run should finish, events were: {collected:?}"
    );
    collected
        .iter()
        .find_map(|e| match e {
            WorkflowEvent::BranchTaken {
                branch, edge_id, ..
            } => Some((branch.clone(), edge_id.clone())),
            _ => None,
        })
        .expect("a branchTaken event arrived")
}

#[tokio::test]
async fn switch_takes_first_matching_case() {
    // exit 0 matches `case:zero` (the first case), not `case:low`.
    let (branch, edge_id) = run_switch_with_exit(0).await;
    assert_eq!(branch, "case:zero");
    assert_eq!(edge_id, "e_zero");
}

#[tokio::test]
async fn switch_matches_later_case_when_first_fails() {
    // exit 5 fails `case:zero` (== 0) but matches `case:low` (< 10).
    let (branch, edge_id) = run_switch_with_exit(5).await;
    assert_eq!(branch, "case:low");
    assert_eq!(edge_id, "e_low");
}

#[tokio::test]
async fn switch_falls_through_to_default_branch() {
    // exit 42 matches no case → the `default` edge is taken.
    let (branch, edge_id) = run_switch_with_exit(42).await;
    assert_eq!(branch, "default");
    assert_eq!(edge_id, "e_default");
}

// ---- §4 loop end-to-end ----------------------------------------------------

/// A counted loop running a body command N times:
///
/// start → loop ──body→ step(cmd) ──out→ loop   (back-edge)
///              └─done→ end
///
/// The body's `out` edge targets the loop node again, so the loop is
/// re-entered until its `count` is reached, then `done` exits.
fn counted_loop_workflow(body_command_id: &str, count: u32, max: u32) -> WorkflowRecord {
    let loop_node = WorkflowNodeRecord {
        id: "lp".into(),
        kind: "loop".into(),
        command_id: None,
        label: None,
        condition: None,
        cases: Vec::new(),
        loop_config: Some(LoopConfigRecord {
            count: Some(count),
            while_condition: None,
            max_iterations: max,
        }),
        retry: None,
        data: Vec::new(),
        variable_sources: std::collections::BTreeMap::new(),
        parser: None,
        text: None,
        join_node_id: None,
        position: NodePosition { x: 0.0, y: 0.0 },
    };
    WorkflowRecord {
        id: "wf-loop".into(),
        name: "loop".into(),
        description: None,
        icon: None,
        nodes: vec![
            node("start", "start", None),
            loop_node,
            node("step", "command", Some(body_command_id)),
            node("end", "end", None),
        ],
        edges: vec![
            edge("e_start", "start", "lp", "out"),
            edge("e_body", "lp", "step", "body"),
            edge("e_back", "step", "lp", "out"),
            edge("e_done", "lp", "end", "done"),
        ],
        tags: Vec::new(),
        category_id: None,
        favorite: false,
        created_at: "2026-05-29T00:00:00Z".into(),
        updated_at: "2026-05-29T00:00:00Z".into(),
        last_run_at: None,
        run_count: 0,
        api_slug: None,
        api_enabled: false,
    }
}

#[tokio::test]
async fn loop_runs_body_exactly_count_times() {
    let (app, exec_state, wf_state, events) = make_app();
    let mut commands = HashMap::new();
    commands.insert("body".to_string(), command("body", "true"));

    execute_workflow(
        app,
        exec_state,
        wf_state,
        counted_loop_workflow("body", 3, 100),
        commands,
        HashMap::new(),
        false,
    )
    .await
    .expect("execute_workflow kicks off");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;

    // The body command (node "step") must have finished exactly 3 times.
    let body_runs = collected
        .iter()
        .filter(|e| matches!(e, WorkflowEvent::NodeFinished { node_id, .. } if node_id == "step"))
        .count();
    assert_eq!(
        body_runs, 3,
        "body should run 3 times, events: {collected:?}"
    );

    // Iteration events are 1-based and contiguous up to 3.
    let iterations: Vec<u32> = collected
        .iter()
        .filter_map(|e| match e {
            WorkflowEvent::LoopIteration { iteration, .. } => Some(*iteration),
            _ => None,
        })
        .collect();
    assert_eq!(iterations, vec![1, 2, 3]);

    // The loop must finish via the `done` branch.
    assert!(collected.iter().any(|e| matches!(
        e,
        WorkflowEvent::BranchTaken { branch, .. } if branch == "done"
    )));
    assert!(collected
        .iter()
        .any(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. })));
}

#[tokio::test]
async fn loop_aborts_with_error_when_max_iterations_exceeded() {
    // count (10) exceeds max_iterations (3): the hard cap must stop the run
    // with a workflow error rather than letting it run all 10.
    let (app, exec_state, wf_state, events) = make_app();
    let mut commands = HashMap::new();
    commands.insert("body".to_string(), command("body", "true"));

    execute_workflow(
        app,
        exec_state,
        wf_state,
        counted_loop_workflow("body", 10, 3),
        commands,
        HashMap::new(),
        false,
    )
    .await
    .expect("execute_workflow kicks off");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;

    // Body ran at most max_iterations (3) times, never the requested 10.
    let body_runs = collected
        .iter()
        .filter(|e| matches!(e, WorkflowEvent::NodeFinished { node_id, .. } if node_id == "step"))
        .count();
    assert_eq!(
        body_runs, 3,
        "body capped at max_iterations, events: {collected:?}"
    );

    // The run ends in a workflow error (the LoopLimit), not a clean finish.
    assert!(
        collected
            .iter()
            .any(|e| matches!(e, WorkflowEvent::WorkflowError { .. })),
        "expected a workflow error from LoopLimit, events: {collected:?}"
    );
    assert!(
        !collected
            .iter()
            .any(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. })),
        "a LoopLimit run must not also finish cleanly"
    );
}

// ---- §5 try/catch + retry end-to-end ---------------------------------------

/// A try node routing on the final attempt's outcome:
///
/// start → try(cmd, retry) ──ok→ end_ok
///                          └catch→ end_catch
fn try_workflow(test_command_id: &str, retries: u32) -> WorkflowRecord {
    let try_node = WorkflowNodeRecord {
        id: "tr".into(),
        kind: "try".into(),
        command_id: Some(test_command_id.into()),
        label: None,
        condition: None,
        cases: Vec::new(),
        loop_config: None,
        retry: Some(RetryConfigRecord {
            retries,
            // Tiny backoff keeps the test fast while still exercising the
            // (cancellable) sleep path between attempts.
            backoff_ms: Some(10),
        }),
        data: Vec::new(),
        variable_sources: std::collections::BTreeMap::new(),
        parser: None,
        text: None,
        join_node_id: None,
        position: NodePosition { x: 0.0, y: 0.0 },
    };
    WorkflowRecord {
        id: "wf-try".into(),
        name: "try".into(),
        description: None,
        icon: None,
        nodes: vec![
            node("start", "start", None),
            try_node,
            node("end_ok", "end", None),
            node("end_catch", "end", None),
        ],
        edges: vec![
            edge("e_start", "start", "tr", "out"),
            edge("e_ok", "tr", "end_ok", "ok"),
            edge("e_catch", "tr", "end_catch", "catch"),
        ],
        tags: Vec::new(),
        category_id: None,
        favorite: false,
        created_at: "2026-05-29T00:00:00Z".into(),
        updated_at: "2026-05-29T00:00:00Z".into(),
        last_run_at: None,
        run_count: 0,
        api_slug: None,
        api_enabled: false,
    }
}

#[tokio::test]
async fn try_takes_ok_branch_on_first_success() {
    let (app, exec_state, wf_state, events) = make_app();
    let mut commands = HashMap::new();
    commands.insert("cmd".to_string(), command("cmd", "exit 0"));

    execute_workflow(
        app,
        exec_state,
        wf_state,
        try_workflow("cmd", 3),
        commands,
        HashMap::new(),
        false,
    )
    .await
    .expect("execute_workflow kicks off");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;

    // Succeeded first try → `ok` branch, no retries emitted.
    assert!(collected
        .iter()
        .any(|e| matches!(e, WorkflowEvent::BranchTaken { branch, .. } if branch == "ok")));
    assert!(
        !collected
            .iter()
            .any(|e| matches!(e, WorkflowEvent::NodeRetry { .. })),
        "a first-try success must not retry"
    );
    assert!(collected
        .iter()
        .any(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. })));
}

#[tokio::test]
async fn try_takes_catch_branch_after_exhausting_retries() {
    let (app, exec_state, wf_state, events) = make_app();
    let mut commands = HashMap::new();
    // Always fails: 1 initial + 2 retries = 3 attempts, then `catch`.
    commands.insert("cmd".to_string(), command("cmd", "exit 1"));

    execute_workflow(
        app,
        exec_state,
        wf_state,
        try_workflow("cmd", 2),
        commands,
        HashMap::new(),
        false,
    )
    .await
    .expect("execute_workflow kicks off");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;

    // The command ran 3 times (initial + 2 retries).
    let runs = collected
        .iter()
        .filter(|e| matches!(e, WorkflowEvent::NodeFinished { node_id, .. } if node_id == "tr"))
        .count();
    assert_eq!(runs, 3, "1 initial + 2 retries, events: {collected:?}");

    // Two `nodeRetry` events, for attempts 2 and 3.
    let attempts: Vec<u32> = collected
        .iter()
        .filter_map(|e| match e {
            WorkflowEvent::NodeRetry { attempt, .. } => Some(*attempt),
            _ => None,
        })
        .collect();
    assert_eq!(attempts, vec![2, 3]);

    // Exhausted → `catch`, and the run still finishes (catch is a normal exit).
    assert!(collected
        .iter()
        .any(|e| matches!(e, WorkflowEvent::BranchTaken { branch, .. } if branch == "catch")));
    assert!(collected
        .iter()
        .any(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. })));
}

#[tokio::test]
async fn try_succeeds_on_a_later_retry() {
    let (app, exec_state, wf_state, events) = make_app();

    // A command that fails until a temp counter file reaches 3, then succeeds.
    // Each attempt appends a byte and counts; on the 3rd it exits 0. This
    // proves the retry loop re-runs the command and stops on first success.
    let marker = std::env::temp_dir().join(format!("procmix-try-{}", uuid_like()));
    let script = format!(
        "n=$(cat '{m}' 2>/dev/null | wc -c); echo -n x >> '{m}'; [ \"$n\" -ge 2 ]",
        m = marker.display()
    );
    let mut commands = HashMap::new();
    commands.insert("cmd".to_string(), command("cmd", &script));

    execute_workflow(
        app,
        exec_state,
        wf_state,
        try_workflow("cmd", 5),
        commands,
        HashMap::new(),
        false,
    )
    .await
    .expect("execute_workflow kicks off");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;
    let _ = std::fs::remove_file(&marker);

    // Failed twice (counter 0,1) then succeeded on the 3rd attempt → `ok`.
    let runs = collected
        .iter()
        .filter(|e| matches!(e, WorkflowEvent::NodeFinished { node_id, .. } if node_id == "tr"))
        .count();
    assert_eq!(
        runs, 3,
        "two failures then a success, events: {collected:?}"
    );
    assert!(collected
        .iter()
        .any(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. })));
}

#[tokio::test]
async fn data_node_pulls_exit_code_from_previous_command() {
    // start → cmd(exit 7) → data{ code = ExitCode } → check(${code}==7) → end.
    // Proves a data node reads its predecessor's outcome (exit code) and that
    // the pulled value flows into the next command via data-flow.
    let (app, exec_state, wf_state, events) = make_app();
    let mut commands = HashMap::new();
    commands.insert("seven".to_string(), command("seven", "exit 7"));
    commands.insert(
        "check".to_string(),
        command("check", r#"[ "${code}" = "7" ]"#),
    );

    let data_node = WorkflowNodeRecord {
        id: "set".into(),
        kind: "data".into(),
        command_id: None,
        label: None,
        condition: None,
        cases: Vec::new(),
        loop_config: None,
        retry: None,
        data: vec![DataAssignmentRecord {
            name: "code".into(),
            value: String::new(),
            source: Some(DataSourceRecord::ExitCode),
        }],
        variable_sources: std::collections::BTreeMap::new(),
        parser: None,
        text: None,
        join_node_id: None,
        position: NodePosition { x: 0.0, y: 0.0 },
    };
    let workflow = WorkflowRecord {
        id: "wf-data-src".into(),
        name: "data-src".into(),
        description: None,
        icon: None,
        nodes: vec![
            node("start", "start", None),
            node("cmd", "command", Some("seven")),
            data_node,
            node("check", "command", Some("check")),
            node("end", "end", None),
        ],
        edges: vec![
            edge("e_start", "start", "cmd", "out"),
            edge("e_cmd", "cmd", "set", "out"),
            edge("e_set", "set", "check", "out"),
            edge("e_check", "check", "end", "out"),
        ],
        tags: Vec::new(),
        category_id: None,
        favorite: false,
        created_at: "2026-05-29T00:00:00Z".into(),
        updated_at: "2026-05-29T00:00:00Z".into(),
        last_run_at: None,
        run_count: 0,
        api_slug: None,
        api_enabled: false,
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

    // `check` exits 0 only if `${code}` substituted to "7" — i.e. the data
    // node pulled the previous command's exit code into the carry.
    let check_exit = collected.iter().find_map(|e| match e {
        WorkflowEvent::NodeFinished {
            node_id, exit_code, ..
        } if node_id == "check" => Some(*exit_code),
        _ => None,
    });
    assert_eq!(
        check_exit,
        Some(Some(0)),
        "data node must pull the prev command's exit code, events: {collected:?}"
    );
    assert!(collected
        .iter()
        .any(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. })));
}

/// Cheap unique-ish suffix for the temp marker file (avoids pulling uuid into
/// the test's direct deps; collisions across a single test run are impossible).
fn uuid_like() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos()
}

// ---- §6 condition predicate + data node end-to-end -------------------------

/// A condition node carrying a stdout `contains` predicate:
///
/// start → condition(cmd, predicate) ──then→ end_then
///                                    └─else→ end_else
///
/// The predicate is the SOLE brancher — the command exits 0 either way, so a
/// branch other than what the exit code alone implies proves the predicate ran.
fn predicated_condition_workflow(test_command_id: &str, predicate: Condition) -> WorkflowRecord {
    let cond_node = WorkflowNodeRecord {
        id: "cond".into(),
        kind: "condition".into(),
        command_id: Some(test_command_id.into()),
        label: None,
        condition: Some(predicate),
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
    WorkflowRecord {
        id: "wf-cond-pred".into(),
        name: "cond-pred".into(),
        description: None,
        icon: None,
        nodes: vec![
            node("start", "start", None),
            cond_node,
            node("end_then", "end", None),
            node("end_else", "end", None),
        ],
        edges: vec![
            edge("e_start", "start", "cond", "out"),
            edge("e_then", "cond", "end_then", "then"),
            edge("e_else", "cond", "end_else", "else"),
        ],
        tags: Vec::new(),
        category_id: None,
        favorite: false,
        created_at: "2026-05-29T00:00:00Z".into(),
        updated_at: "2026-05-29T00:00:00Z".into(),
        last_run_at: None,
        run_count: 0,
        api_slug: None,
        api_enabled: false,
    }
}

#[tokio::test]
async fn condition_predicate_branches_on_stdout_not_exit_code() {
    let (app, exec_state, wf_state, events) = make_app();
    let mut commands = HashMap::new();
    // Exits 0 (so the exit-code default would be `then`) but prints SKIP.
    commands.insert("cmd".to_string(), command("cmd", "echo SKIP; exit 0"));

    // Predicate: stdout contains "DEPLOY" — false here, so `else` despite exit 0.
    let predicate = Condition {
        subject: Subject::Stdout,
        op: Op::Contains,
        value: "DEPLOY".into(),
    };

    execute_workflow(
        app,
        exec_state,
        wf_state,
        predicated_condition_workflow("cmd", predicate),
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
            WorkflowEvent::BranchTaken { branch, .. } => Some(branch.clone()),
            _ => None,
        })
        .expect("a branchTaken event arrived");
    // The predicate (stdout) won over the exit-code default.
    assert_eq!(branch, "else", "events: {collected:?}");
    assert!(collected
        .iter()
        .any(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. })));
}

#[tokio::test]
async fn data_node_assignment_flows_into_downstream_command() {
    let (app, exec_state, wf_state, events) = make_app();

    // The data node sets `who=world`; the downstream command exits 0 only when
    // `${who}` substitutes to `world`, proving the assignment reached it.
    let mut commands = HashMap::new();
    commands.insert("check".to_string(), command_with_var("check", None));

    let data_node = WorkflowNodeRecord {
        id: "set".into(),
        kind: "data".into(),
        command_id: None,
        label: None,
        condition: None,
        cases: Vec::new(),
        loop_config: None,
        retry: None,
        data: vec![DataAssignmentRecord {
            name: "who".into(),
            value: "world".into(),
            source: None,
        }],
        variable_sources: std::collections::BTreeMap::new(),
        parser: None,
        text: None,
        join_node_id: None,
        position: NodePosition { x: 0.0, y: 0.0 },
    };
    let workflow = WorkflowRecord {
        id: "wf-data".into(),
        name: "data".into(),
        description: None,
        icon: None,
        nodes: vec![
            node("start", "start", None),
            data_node,
            node("check", "command", Some("check")),
            node("end", "end", None),
        ],
        edges: vec![
            edge("e_start", "start", "set", "out"),
            edge("e_set", "set", "check", "out"),
            edge("e_check", "check", "end", "out"),
        ],
        tags: Vec::new(),
        category_id: None,
        favorite: false,
        created_at: "2026-05-29T00:00:00Z".into(),
        updated_at: "2026-05-29T00:00:00Z".into(),
        last_run_at: None,
        run_count: 0,
        api_slug: None,
        api_enabled: false,
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

    // The downstream command (node "check") must have exited 0 — only possible
    // if the data node's `who=world` reached it via data-flow.
    let check_exit = collected.iter().find_map(|e| match e {
        WorkflowEvent::NodeFinished {
            node_id, exit_code, ..
        } if node_id == "check" => Some(*exit_code),
        _ => None,
    });
    assert_eq!(
        check_exit,
        Some(Some(0)),
        "data assignment must reach the command, events: {collected:?}"
    );
    assert!(collected
        .iter()
        .any(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. })));
}

#[tokio::test]
async fn data_node_variable_survives_an_intermediate_command_node() {
    // A `data` node sets `who=world`; an intermediate command runs (replacing
    // the transient data_flow with ITS own fields); a LATER command reads `who`
    // via a `dataVar` source. Proves a data-node variable is usable in ANY
    // downstream node, not just the immediate successor.
    let (app, exec_state, wf_state, events) = make_app();

    let mut commands = HashMap::new();
    // Intermediate node: a plain command that succeeds and extracts nothing.
    commands.insert("noop".to_string(), command("noop", "true"));
    // Final node: exits 0 only when `${who}` substitutes to "world".
    commands.insert("check".to_string(), command_with_var("check", None));

    let set_node = WorkflowNodeRecord {
        id: "set".into(),
        kind: "data".into(),
        command_id: None,
        label: None,
        condition: None,
        cases: Vec::new(),
        loop_config: None,
        retry: None,
        data: vec![DataAssignmentRecord {
            name: "who".into(),
            value: "world".into(),
            source: None,
        }],
        variable_sources: std::collections::BTreeMap::new(),
        parser: None,
        text: None,
        join_node_id: None,
        position: NodePosition { x: 0.0, y: 0.0 },
    };
    // The final command binds its `who` variable to the data-node variable.
    let check_node = WorkflowNodeRecord {
        id: "check".into(),
        kind: "command".into(),
        command_id: Some("check".into()),
        label: None,
        condition: None,
        cases: Vec::new(),
        loop_config: None,
        retry: None,
        data: Vec::new(),
        variable_sources: std::collections::BTreeMap::from([(
            "who".to_string(),
            DataSourceRecord::DataVar { name: "who".into() },
        )]),
        parser: None,
        text: None,
        join_node_id: None,
        position: NodePosition { x: 0.0, y: 0.0 },
    };
    let workflow = WorkflowRecord {
        id: "wf-data-persist".into(),
        name: "data-persist".into(),
        description: None,
        icon: None,
        nodes: vec![
            node("start", "start", None),
            set_node,
            node("mid", "command", Some("noop")),
            check_node,
            node("end", "end", None),
        ],
        edges: vec![
            edge("e_start", "start", "set", "out"),
            edge("e_set", "set", "mid", "out"),
            edge("e_mid", "mid", "check", "out"),
            edge("e_check", "check", "end", "out"),
        ],
        tags: Vec::new(),
        category_id: None,
        favorite: false,
        created_at: "2026-05-29T00:00:00Z".into(),
        updated_at: "2026-05-29T00:00:00Z".into(),
        last_run_at: None,
        run_count: 0,
        api_slug: None,
        api_enabled: false,
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
    let check_exit = collected.iter().find_map(|e| match e {
        WorkflowEvent::NodeFinished {
            node_id, exit_code, ..
        } if node_id == "check" => Some(*exit_code),
        _ => None,
    });
    assert_eq!(
        check_exit,
        Some(Some(0)),
        "data-node var must survive the intermediate command, events: {collected:?}"
    );
}

/// start → step1(cmd) → step2(cmd) → end. Two command nodes so a node-scoped
/// run can prove it executes the chosen node + downstream, NOT the upstream.
fn two_step_workflow(command_id: &str) -> WorkflowRecord {
    WorkflowRecord {
        id: "wf-two".into(),
        name: "two".into(),
        description: None,
        icon: None,
        nodes: vec![
            node("start", "start", None),
            node("step1", "command", Some(command_id)),
            node("step2", "command", Some(command_id)),
            node("end", "end", None),
        ],
        edges: vec![
            edge("e_start", "start", "step1", "out"),
            edge("e_1", "step1", "step2", "out"),
            edge("e_2", "step2", "end", "out"),
        ],
        tags: Vec::new(),
        category_id: None,
        favorite: false,
        created_at: "2026-05-29T00:00:00Z".into(),
        updated_at: "2026-05-29T00:00:00Z".into(),
        last_run_at: None,
        run_count: 0,
        api_slug: None,
        api_enabled: false,
    }
}

#[tokio::test]
async fn run_from_node_executes_chosen_node_and_downstream_only() {
    let (app, exec_state, wf_state, events) = make_app();

    let mut commands = HashMap::new();
    commands.insert("ok-cmd".to_string(), command("ok-cmd", "true"));

    // Run starting at the SECOND command node, seeding its input.
    execute_workflow_from(
        app,
        exec_state,
        wf_state,
        two_step_workflow("ok-cmd"),
        commands,
        HashMap::new(),
        "step2".to_string(),
        Some("seeded input".to_string()),
    )
    .await
    .expect("execute_workflow_from kicks off");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;

    let started: Vec<&str> = collected
        .iter()
        .filter_map(|e| match e {
            WorkflowEvent::NodeStarted { node_id, .. } => Some(node_id.as_str()),
            _ => None,
        })
        .collect();

    // The chosen node ran…
    assert!(
        started.contains(&"step2"),
        "step2 should run, events: {collected:?}"
    );
    // …but the UPSTREAM node did NOT (the run started at step2).
    assert!(
        !started.contains(&"step1"),
        "step1 must NOT run for a node-scoped run from step2, events: {collected:?}"
    );
    assert!(
        collected
            .iter()
            .any(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. })),
        "node-scoped run should finish, events: {collected:?}"
    );
}

#[tokio::test]
async fn run_from_node_with_unknown_node_emits_error() {
    let (app, exec_state, wf_state, events) = make_app();

    let mut commands = HashMap::new();
    commands.insert("ok-cmd".to_string(), command("ok-cmd", "true"));

    execute_workflow_from(
        app,
        exec_state,
        wf_state,
        two_step_workflow("ok-cmd"),
        commands,
        HashMap::new(),
        "does-not-exist".to_string(),
        None,
    )
    .await
    .expect("execute_workflow_from kicks off even for a bad node id");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;
    assert!(
        collected
            .iter()
            .any(|e| matches!(e, WorkflowEvent::WorkflowError { .. })),
        "an unknown start node should surface a workflow error, events: {collected:?}"
    );
}

#[tokio::test]
async fn run_from_final_command_node_runs_only_it() {
    // Running from the LAST command node (whose `out` goes straight to `end`)
    // executes that one node and finishes — the realistic "run the final node"
    // case. The earlier node must NOT run.
    let (app, exec_state, wf_state, events) = make_app();

    let mut commands = HashMap::new();
    commands.insert("ok-cmd".to_string(), command("ok-cmd", "true"));

    execute_workflow_from(
        app,
        exec_state,
        wf_state,
        two_step_workflow("ok-cmd"),
        commands,
        HashMap::new(),
        "step2".to_string(), // the final command node before `end`
        None,
    )
    .await
    .expect("execute_workflow_from kicks off");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;
    let started: Vec<&str> = collected
        .iter()
        .filter_map(|e| match e {
            WorkflowEvent::NodeStarted { node_id, .. } => Some(node_id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        started,
        vec!["step2"],
        "only the final command node should run, events: {collected:?}"
    );
    assert!(collected
        .iter()
        .any(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. })));
}

#[tokio::test]
async fn run_from_end_node_is_a_clean_noop() {
    // Starting at an `end` node halts immediately: no node runs, but the run
    // finishes cleanly (not an error). The editor hides this action for `end`,
    // but the engine must still degrade gracefully if asked.
    let (app, exec_state, wf_state, events) = make_app();

    let mut commands = HashMap::new();
    commands.insert("ok-cmd".to_string(), command("ok-cmd", "true"));

    execute_workflow_from(
        app,
        exec_state,
        wf_state,
        two_step_workflow("ok-cmd"),
        commands,
        HashMap::new(),
        "end".to_string(),
        Some("ignored".to_string()),
    )
    .await
    .expect("execute_workflow_from kicks off");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;
    assert!(
        !collected
            .iter()
            .any(|e| matches!(e, WorkflowEvent::NodeStarted { .. })),
        "no node should run when starting at `end`, events: {collected:?}"
    );
    assert!(
        collected
            .iter()
            .any(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. })),
        "starting at `end` should finish cleanly, events: {collected:?}"
    );
}

#[tokio::test]
async fn run_from_node_with_no_seed_input_still_runs() {
    // A node legitimately may have no example input. Running it with `None`
    // seed must execute normally (the command falls back to its own defaults).
    let (app, exec_state, wf_state, events) = make_app();

    let mut commands = HashMap::new();
    commands.insert("ok-cmd".to_string(), command("ok-cmd", "true"));

    execute_workflow_from(
        app,
        exec_state,
        wf_state,
        two_step_workflow("ok-cmd"),
        commands,
        HashMap::new(),
        "step1".to_string(),
        None, // no input data
    )
    .await
    .expect("execute_workflow_from kicks off");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;
    let step1_exit = collected.iter().find_map(|e| match e {
        WorkflowEvent::NodeFinished {
            node_id, exit_code, ..
        } if node_id == "step1" => Some(*exit_code),
        _ => None,
    });
    assert_eq!(
        step1_exit,
        Some(Some(0)),
        "a node with no seed input should still run to completion, events: {collected:?}"
    );
    assert!(collected
        .iter()
        .any(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. })));
}

#[tokio::test]
async fn run_from_data_node_consumes_the_seed_as_raw_output() {
    // A `data` node as the ENTRY point reads the seed via a `rawOutput` source,
    // proving the seed feeds non-command entry nodes too. The data node copies
    // the seed into `${who}`; the downstream command exits 0 only when `${who}`
    // substituted to "world".
    let (app, exec_state, wf_state, events) = make_app();

    let mut commands = HashMap::new();
    commands.insert("check".to_string(), command_with_var("check", None));

    let data_node = WorkflowNodeRecord {
        id: "set".into(),
        kind: "data".into(),
        command_id: None,
        label: None,
        condition: None,
        cases: Vec::new(),
        loop_config: None,
        retry: None,
        data: vec![DataAssignmentRecord {
            name: "who".into(),
            value: String::new(),
            // Pull from the previous node's raw output — here, the seed.
            source: Some(DataSourceRecord::RawOutput),
        }],
        variable_sources: std::collections::BTreeMap::new(),
        parser: None,
        text: None,
        join_node_id: None,
        position: NodePosition { x: 0.0, y: 0.0 },
    };
    let workflow = WorkflowRecord {
        id: "wf-data-seed".into(),
        name: "data-seed".into(),
        description: None,
        icon: None,
        nodes: vec![
            node("start", "start", None),
            data_node,
            node("check", "command", Some("check")),
            node("end", "end", None),
        ],
        edges: vec![
            edge("e_start", "start", "set", "out"),
            edge("e_set", "set", "check", "out"),
            edge("e_check", "check", "end", "out"),
        ],
        tags: Vec::new(),
        category_id: None,
        favorite: false,
        created_at: "2026-05-29T00:00:00Z".into(),
        updated_at: "2026-05-29T00:00:00Z".into(),
        last_run_at: None,
        run_count: 0,
        api_slug: None,
        api_enabled: false,
    };

    execute_workflow_from(
        app,
        exec_state,
        wf_state,
        workflow,
        commands,
        HashMap::new(),
        "set".to_string(),
        Some("world".to_string()), // the seed becomes `${who}`
    )
    .await
    .expect("execute_workflow_from kicks off");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;
    let check_exit = collected.iter().find_map(|e| match e {
        WorkflowEvent::NodeFinished {
            node_id, exit_code, ..
        } if node_id == "check" => Some(*exit_code),
        _ => None,
    });
    assert_eq!(
        check_exit,
        Some(Some(0)),
        "the seed must reach the data node's rawOutput → ${{who}}, events: {collected:?}"
    );
}

// ---- fork/join (parallel) end-to-end ---------------------------------------

/// A `parallel` fork node with `n` command branches, optionally bound to a
/// `join` barrier:
///
/// start → fork ── branch:0 → b0 → (join | end0)
///              ├─ branch:1 → b1 → (join | end1)
///              └─ …
/// join → end                                      (only when `with_join`)
///
/// With `with_join == true` every branch's `out` edge targets the single
/// `join` node, and `join`'s `out` edge targets a single `end`. With
/// `with_join == false` each branch flows to its OWN `end` and the fork carries
/// no `joinNodeId`.
fn fork_workflow(branch_command_ids: &[&str], with_join: bool) -> WorkflowRecord {
    let mut nodes: Vec<WorkflowNodeRecord> = vec![node("start", "start", None)];

    let fork = WorkflowNodeRecord {
        join_node_id: if with_join {
            Some("join".to_string())
        } else {
            None
        },
        ..node("fork", "parallel", None)
    };
    nodes.push(fork);

    let mut edges = vec![edge("e_start", "start", "fork", "out")];

    for (i, cmd_id) in branch_command_ids.iter().enumerate() {
        let bnode = format!("b{i}");
        nodes.push(node(&bnode, "command", Some(cmd_id)));
        edges.push(edge(
            &format!("e_fork_{i}"),
            "fork",
            &bnode,
            &format!("branch:{i}"),
        ));
        if with_join {
            edges.push(edge(&format!("e_b{i}_join"), &bnode, "join", "out"));
        } else {
            let endn = format!("end{i}");
            nodes.push(node(&endn, "end", None));
            edges.push(edge(&format!("e_b{i}_end"), &bnode, &endn, "out"));
        }
    }

    if with_join {
        nodes.push(node("join", "join", None));
        nodes.push(node("end", "end", None));
        edges.push(edge("e_join_end", "join", "end", "out"));
    }

    WorkflowRecord {
        id: "wf-fork".into(),
        name: "fork".into(),
        description: None,
        icon: None,
        nodes,
        edges,
        tags: Vec::new(),
        category_id: None,
        favorite: false,
        created_at: "2026-05-29T00:00:00Z".into(),
        updated_at: "2026-05-29T00:00:00Z".into(),
        last_run_at: None,
        run_count: 0,
        api_slug: None,
        api_enabled: false,
    }
}

#[tokio::test]
async fn fork_three_branches_join_then_end_finishes_once() {
    let (app, exec_state, wf_state, events) = make_app();
    let mut commands = HashMap::new();
    commands.insert("b0".to_string(), command("b0", "true"));
    commands.insert("b1".to_string(), command("b1", "true"));
    commands.insert("b2".to_string(), command("b2", "true"));

    execute_workflow(
        app,
        exec_state,
        wf_state,
        fork_workflow(&["b0", "b1", "b2"], true),
        commands,
        HashMap::new(),
        false,
    )
    .await
    .expect("execute_workflow kicks off");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;

    // All three branch commands ran exactly once.
    for nid in ["b0", "b1", "b2"] {
        let runs = collected
            .iter()
            .filter(|e| matches!(e, WorkflowEvent::NodeFinished { node_id, .. } if node_id == nid))
            .count();
        assert_eq!(
            runs, 1,
            "branch {nid} should run once, events: {collected:?}"
        );
    }

    // The run finishes EXACTLY once (the post-join continuation must not fire
    // per branch).
    let finishes = collected
        .iter()
        .filter(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. }))
        .count();
    assert_eq!(finishes, 1, "exactly one finish, events: {collected:?}");
    assert!(
        !collected
            .iter()
            .any(|e| matches!(e, WorkflowEvent::WorkflowError { .. })),
        "no error expected"
    );
}

#[tokio::test]
async fn fork_without_join_each_branch_runs_to_its_own_end() {
    let (app, exec_state, wf_state, events) = make_app();
    let mut commands = HashMap::new();
    commands.insert("b0".to_string(), command("b0", "true"));
    commands.insert("b1".to_string(), command("b1", "true"));

    execute_workflow(
        app,
        exec_state,
        wf_state,
        fork_workflow(&["b0", "b1"], false),
        commands,
        HashMap::new(),
        false,
    )
    .await
    .expect("execute_workflow kicks off");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;

    for nid in ["b0", "b1"] {
        assert!(
            collected.iter().any(
                |e| matches!(e, WorkflowEvent::NodeFinished { node_id, .. } if node_id == nid)
            ),
            "branch {nid} should run, events: {collected:?}"
        );
    }
    // The whole run finishes once all branches reach their own `end`.
    assert!(
        collected
            .iter()
            .any(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. })),
        "run should finish once all branches end, events: {collected:?}"
    );
}

#[tokio::test]
async fn fork_single_branch_fast_path_behaves_sequentially() {
    // One branch ⇒ fast path (no JoinSet). The branch runs and, with a bound
    // join, the post-join continuation fires once.
    let (app, exec_state, wf_state, events) = make_app();
    let mut commands = HashMap::new();
    commands.insert("b0".to_string(), command("b0", "true"));

    execute_workflow(
        app,
        exec_state,
        wf_state,
        fork_workflow(&["b0"], true),
        commands,
        HashMap::new(),
        false,
    )
    .await
    .expect("execute_workflow kicks off");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;

    let runs = collected
        .iter()
        .filter(|e| matches!(e, WorkflowEvent::NodeFinished { node_id, .. } if node_id == "b0"))
        .count();
    assert_eq!(runs, 1, "single branch runs once, events: {collected:?}");
    let finishes = collected
        .iter()
        .filter(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. }))
        .count();
    assert_eq!(finishes, 1, "exactly one finish, events: {collected:?}");
}

#[tokio::test]
async fn fork_error_in_one_branch_aborts_others_and_errors() {
    // One branch fails immediately while a sibling sleeps; the failure must
    // abort the sibling and surface a workflow error (not hang).
    let (app, exec_state, wf_state, events) = make_app();
    let mut commands = HashMap::new();
    // A non-zero exit alone is NOT an engine error (it would just route `out`),
    // so make the failing branch a MISSING command, which is a real graph fault
    // the engine raises as a WorkflowError mid-branch.
    commands.insert("slow".to_string(), command("slow", "sleep 30"));
    // "boom" is intentionally absent from the map → UnknownCommand on branch 1.

    execute_workflow(
        app,
        exec_state,
        wf_state,
        fork_workflow(&["slow", "boom"], true),
        commands,
        HashMap::new(),
        false,
    )
    .await
    .expect("execute_workflow kicks off");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;

    assert!(
        collected
            .iter()
            .any(|e| matches!(e, WorkflowEvent::WorkflowError { .. })),
        "a failing branch must surface a workflow error, events: {collected:?}"
    );
    assert!(
        !collected
            .iter()
            .any(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. })),
        "a faulted fork must not also finish, events: {collected:?}"
    );
}

#[tokio::test]
async fn fork_cancel_mid_flight_cancels_all_branches() {
    // Two long-sleeping branches; cancelling mid-flight must reap both children
    // and report cancelled, not finished.
    let (app, exec_state, wf_state, events) = make_app();
    let mut commands = HashMap::new();
    commands.insert("s0".to_string(), command("s0", "sleep 30"));
    commands.insert("s1".to_string(), command("s1", "sleep 30"));

    let run_id = execute_workflow(
        app,
        exec_state,
        wf_state.clone(),
        fork_workflow(&["s0", "s1"], true),
        commands,
        HashMap::new(),
        false,
    )
    .await
    .expect("execute_workflow kicks off");

    // Wait until both branch nodes have started so the children exist.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let started = events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, WorkflowEvent::NodeStarted { .. }))
            .count();
        if started >= 2 || std::time::Instant::now() >= deadline {
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
        "fork cancel should report cancelled, events: {collected:?}"
    );
    assert!(
        !collected
            .iter()
            .any(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. })),
        "a cancelled fork must not also finish"
    );
}

#[tokio::test]
async fn fork_post_join_continuation_runs_a_following_command_once() {
    // start → fork(2) → join → after(command) → end.
    // Proves the parent path resumes from join's `out` edge exactly once.
    let (app, exec_state, wf_state, events) = make_app();
    let mut commands = HashMap::new();
    commands.insert("b0".to_string(), command("b0", "true"));
    commands.insert("b1".to_string(), command("b1", "true"));
    commands.insert("after".to_string(), command("after", "true"));

    // Build the join fixture, then re-point join → after → end.
    let mut wf = fork_workflow(&["b0", "b1"], true);
    wf.nodes.push(node("after", "command", Some("after")));
    // Replace the join→end edge with join→after, and add after→end.
    wf.edges.retain(|e| e.id != "e_join_end");
    wf.edges.push(edge("e_join_after", "join", "after", "out"));
    wf.edges.push(edge("e_after_end", "after", "end", "out"));

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

    let after_runs = collected
        .iter()
        .filter(|e| matches!(e, WorkflowEvent::NodeFinished { node_id, .. } if node_id == "after"))
        .count();
    assert_eq!(
        after_runs, 1,
        "the post-join command runs exactly once, events: {collected:?}"
    );
    assert!(collected
        .iter()
        .any(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. })));
}

#[tokio::test]
async fn bound_join_branch_ending_before_join_errors_and_skips_post_join() {
    // A bound-join fork where ONE branch dead-ends at its OWN `end` instead of
    // converging at the join. The engine must FAULT (BranchEndedBeforeJoin)
    // rather than silently running the join + everything after it.
    //
    // start → fork ── branch:0 → b0 → join
    //              └─ branch:1 → b1 → stray_end   (never reaches join)
    // join → after(command) → end
    let (app, exec_state, wf_state, events) = make_app();
    let mut commands = HashMap::new();
    commands.insert("b0".to_string(), command("b0", "true"));
    commands.insert("b1".to_string(), command("b1", "true"));
    commands.insert("after".to_string(), command("after", "true"));

    let mut wf = fork_workflow(&["b0", "b1"], true);
    // Re-point branch 1's `out` edge from `join` to a fresh `stray_end`.
    wf.nodes.push(node("stray_end", "end", None));
    wf.edges.retain(|e| e.id != "e_b1_join");
    wf.edges.push(edge("e_b1_stray", "b1", "stray_end", "out"));
    // Add a post-join tail so we can prove it does NOT run.
    wf.nodes.push(node("after", "command", Some("after")));
    wf.edges.retain(|e| e.id != "e_join_end");
    wf.edges.push(edge("e_join_after", "join", "after", "out"));
    wf.edges.push(edge("e_after_end", "after", "end", "out"));

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
        collected
            .iter()
            .any(|e| matches!(e, WorkflowEvent::WorkflowError { .. })),
        "a branch ending before its bound join must surface a workflow error, events: {collected:?}"
    );
    assert!(
        !collected
            .iter()
            .any(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. })),
        "a faulted fork must not also finish, events: {collected:?}"
    );
    // The post-join tail must NOT have run — the barrier was violated.
    assert!(
        !collected.iter().any(
            |e| matches!(e, WorkflowEvent::NodeFinished { node_id, .. } if node_id == "after")
        ),
        "the post-join command must not run when the barrier is violated, events: {collected:?}"
    );
}

#[tokio::test]
async fn unbound_fork_branch_ending_at_own_end_still_finishes_ok() {
    // Regression for Fix 1: with NO bound join (`stop_at == None`) a branch
    // reaching its own `end` is the LEGITIMATE finish and must NOT error.
    let (app, exec_state, wf_state, events) = make_app();
    let mut commands = HashMap::new();
    commands.insert("b0".to_string(), command("b0", "true"));
    commands.insert("b1".to_string(), command("b1", "true"));

    execute_workflow(
        app,
        exec_state,
        wf_state,
        fork_workflow(&["b0", "b1"], false),
        commands,
        HashMap::new(),
        false,
    )
    .await
    .expect("execute_workflow kicks off");

    let collected = wait_workflow_terminal(events, Duration::from_secs(10)).await;

    assert!(
        collected
            .iter()
            .any(|e| matches!(e, WorkflowEvent::WorkflowFinished { .. })),
        "an unbound fork whose branches end at their own end must finish, events: {collected:?}"
    );
    assert!(
        !collected
            .iter()
            .any(|e| matches!(e, WorkflowEvent::WorkflowError { .. })),
        "no error expected for an unbound fork, events: {collected:?}"
    );
}
