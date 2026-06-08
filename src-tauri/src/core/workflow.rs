// Workflow execution engine.
//
// Traverses a persisted workflow graph (`storage::workflows::WorkflowRecord`)
// node by node, running each `command` node through the existing sandboxed
// executor (`executor::spawn_execution_with_completion`) and selecting the
// next edge from the command's exit code. Graph-level progress is streamed
// to the frontend on the `workflow-event` channel; the per-node command runs
// continue to emit their own `execution-event`s, so the OutputPanel keeps
// working unchanged.
//
// The engine does NOT touch storage: the command layer resolves the
// referenced `CommandRecord`s and passes them in as a map. This keeps the
// runner a pure function of (graph, commands, executor) and lets the
// integration tests drive it without a database.
//
// SECURITY: every command runs through `executor::spawn_execution_with_completion`,
// never `Command::new` directly — the sandbox, variable resolution, and
// elevated-spawn handling all live in the executor and are reused verbatim.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::{oneshot, Mutex};

use crate::core::executor::{self, ExecuteRequest, ExecutorState, NodeOutcome, TerminalStatus};
use crate::storage::commands::CommandRecord;
use crate::storage::workflows::{WorkflowEdgeRecord, WorkflowNodeRecord, WorkflowRecord};

pub const WORKFLOW_EVENT: &str = "workflow-event";

/// Hard cap on the number of nodes a single run may visit. Defends
/// against cycles in a malformed graph (the editor should prevent them,
/// but a hand-edited DB or a future bug must not hang the runner). A
/// well-formed MVP workflow is far smaller than this; exceeding it is
/// treated as a `Cycle` error.
const MAX_STEPS: usize = 10_000;

/// Branch discriminator on an edge. Mirrors the TS `WorkflowEdgeBranch`
/// union and the `branch` string stored on `WorkflowEdgeRecord`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Branch {
    Out,
    Then,
    Else,
}

impl Branch {
    fn as_str(self) -> &'static str {
        match self {
            Branch::Out => "out",
            Branch::Then => "then",
            Branch::Else => "else",
        }
    }
}

/// Node kind, parsed from the `kind` string on `WorkflowNodeRecord`. The
/// storage layer keeps `kind` a plain string; the runner owns the typed
/// interpretation (see `storage::workflows` module docs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NodeKind {
    Start,
    Command,
    Condition,
    End,
}

impl NodeKind {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "start" => Some(NodeKind::Start),
            "command" => Some(NodeKind::Command),
            "condition" => Some(NodeKind::Condition),
            "end" => Some(NodeKind::End),
            _ => None,
        }
    }
}

/// Typed error surfaced by the workflow runner. These describe graph
/// problems detected before or during traversal; each maps to a
/// `WorkflowEvent::WorkflowError` emitted to the UI with the rendered
/// message. Uses `thiserror` per the project error-handling convention.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum WorkflowError {
    #[error("workflow has no start node")]
    NoStart,
    #[error("workflow has more than one start node")]
    MultipleStarts,
    #[error("node {0} references unknown command {1}")]
    UnknownCommand(String, String),
    #[error("command node {0} has no commandId")]
    MissingCommandId(String),
    #[error("edge {0} points at unknown node {1}")]
    DanglingEdge(String, String),
    #[error("node {0} has unknown kind {1}")]
    UnknownNodeKind(String, String),
    #[error("condition node {0} is missing its {1} branch")]
    MissingBranch(String, String),
    #[error("command node {0} has no outgoing edge")]
    NoOutgoingEdge(String),
    #[error("workflow exceeded the maximum step count (possible cycle)")]
    Cycle,
    #[error("failed to spawn command for node {0}: {1}")]
    Spawn(String, String),
    #[error("command execution for node {0} failed to report an outcome")]
    LostOutcome(String),
    /// Internal sentinel: traversal stopped because the user cancelled
    /// the run (or an in-flight node was cancelled). Never rendered to
    /// the user as an error — `execute_workflow` maps it to the
    /// `WorkflowCancelled` event. Kept as an error variant so the `?`
    /// operator can short-circuit traversal uniformly.
    #[error("workflow cancelled")]
    Cancelled,
}

/// Graph-level progress events streamed on the `workflow-event` channel.
/// The wire shape mirrors the TS `WorkflowEvent` union in
/// `src/types/workflow.ts` EXACTLY — `#[serde(tag = "kind")]` with
/// camelCase field names. The wire-format tests at the bottom of this
/// module lock that contract.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all_fields = "camelCase", tag = "kind")]
pub enum WorkflowEvent {
    #[serde(rename = "nodeStarted")]
    NodeStarted {
        run_id: String,
        workflow_id: String,
        node_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        execution_id: Option<String>,
    },
    #[serde(rename = "nodeFinished")]
    NodeFinished {
        run_id: String,
        workflow_id: String,
        node_id: String,
        exit_code: Option<i32>,
    },
    #[serde(rename = "branchTaken")]
    BranchTaken {
        run_id: String,
        workflow_id: String,
        node_id: String,
        branch: String,
        edge_id: String,
    },
    #[serde(rename = "workflowFinished")]
    WorkflowFinished {
        run_id: String,
        workflow_id: String,
        duration_ms: u64,
    },
    #[serde(rename = "workflowCancelled")]
    WorkflowCancelled { run_id: String, workflow_id: String },
    #[serde(rename = "workflowError")]
    WorkflowError {
        run_id: String,
        workflow_id: String,
        message: String,
    },
}

/// Per-run cancellation handle stored in [`WorkflowExecutorState`].
struct WorkflowRunningEntry {
    cancel_tx: Option<oneshot::Sender<()>>,
}

/// Managed state holding the in-flight workflow runs keyed by run id.
/// Mirrors `ExecutorState`'s structure (an `Arc<Mutex<HashMap<..>>>`)
/// so cancellation is a lock-take-send, exactly like `cancel_execution`.
pub struct WorkflowExecutorState {
    running: Arc<Mutex<HashMap<String, WorkflowRunningEntry>>>,
}

impl WorkflowExecutorState {
    pub fn new() -> Self {
        Self {
            running: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl Default for WorkflowExecutorState {
    fn default() -> Self {
        Self::new()
    }
}

fn emit<R: Runtime>(app: &AppHandle<R>, event: &WorkflowEvent) {
    if let Err(err) = app.emit(WORKFLOW_EVENT, event) {
        eprintln!("failed to emit workflow event: {err}");
    }
}

/// Emit a `workflow-event` only when the run is NOT silent. A silent (planned
/// cron) fire suppresses every graph-level event; the run is recorded in
/// history instead of streaming to the live console.
fn emit_unless_silent<R: Runtime>(app: &AppHandle<R>, silent: bool, event: &WorkflowEvent) {
    if !silent {
        emit(app, event);
    }
}

/// Build an `ExecuteRequest` for a `command` node from its resolved
/// `CommandRecord`. Mirrors the JS-side request assembly in
/// `src/utils/executor.ts` (shell, args, working dir, env, variables,
/// elevated flag) so a node runs identically to a direct library run.
///
/// `execution_id` is supplied by the runner so it can correlate the
/// `nodeStarted` event with the underlying `execution-event` stream.
///
/// `variable_values` carries the per-node values the command layer
/// collected on the frontend (`triggerWorkflowRun` →
/// `resolveVariableValues`, which merges spec defaults and prompts the
/// user for any no-default variable). The executor still falls back to
/// each spec's `default_value` for any variable not present in this map,
/// so a node with all-defaulted variables works with an empty map. A
/// variable with neither a supplied value nor a default makes the
/// executor return a typed `missingVariable` error, which the runner
/// surfaces as a node spawn failure — a genuine misconfiguration.
fn build_request(
    cmd: &CommandRecord,
    execution_id: String,
    workflow_run_id: String,
    variable_values: BTreeMap<String, String>,
    silent: bool,
) -> ExecuteRequest {
    let env = cmd
        .env
        .as_ref()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect());
    ExecuteRequest {
        script: cmd.script.clone(),
        shell: cmd.shell.clone(),
        args: cmd.args.clone(),
        working_dir: cmd.working_dir.as_ref().map(Into::into),
        env,
        command_id: Some(cmd.id.clone()),
        execution_id: Some(execution_id),
        // Resolve elevation like the UI/library path (`executor.ts`): the
        // persisted flag OR a script whose LEADING command is an inline-
        // escalation tool. A workflow node is spawned by the backend
        // runner (no UI elevation resolution), so without this a `sudo …`
        // node with `run_as_admin = false` runs on the non-elevated path
        // and the inline sudo dies with "a terminal is required to read the
        // password". Keychain fallback applies (`admin_password: None`).
        elevated: cmd.run_as_admin
            || crate::core::utility_help::detect_admin_escalation(&cmd.script),
        admin_password: None,
        variables: cmd.variables.clone(),
        variable_values,
        // Tag the node's execution with the workflow run id so every
        // `execution-event` it emits routes into the aggregated workflow
        // process on the frontend instead of a standalone terminal entry.
        workflow_run_id: Some(workflow_run_id),
        timeout_seconds: cmd.timeout_seconds,
        // Forward the command's output schema so the executor extracts the
        // node's stdout and reports the structured fields back via the
        // completion channel — the runner threads them into the next
        // node's variable values (data-flow).
        output_schema: cmd.output_schema.clone(),
        // v1 captures workflow output via the per-node completion channel /
        // workflow events, not the scheduler's history-capture path, so the
        // node itself does not request `capture_output`.
        capture_output: false,
        // A SILENT (planned) workflow fire suppresses every node's
        // `execution-event` too — without this, a planned fire would still
        // stream each node's stdout to the live console even though the
        // workflow-level events are suppressed.
        silent,
    }
}

/// Locate the single start node, returning its index in `nodes`.
fn find_start(nodes: &[WorkflowNodeRecord]) -> Result<usize, WorkflowError> {
    let mut found: Option<usize> = None;
    for (i, n) in nodes.iter().enumerate() {
        let kind = NodeKind::parse(&n.kind)
            .ok_or_else(|| WorkflowError::UnknownNodeKind(n.id.clone(), n.kind.clone()))?;
        if kind == NodeKind::Start {
            if found.is_some() {
                return Err(WorkflowError::MultipleStarts);
            }
            found = Some(i);
        }
    }
    found.ok_or(WorkflowError::NoStart)
}

/// Find the edge leaving `node_id` on the given branch, validating that
/// its target exists. Returns `(edge_id, target_node_id)`.
fn edge_for_branch(
    edges: &[WorkflowEdgeRecord],
    node_index: &HashMap<String, usize>,
    node_id: &str,
    branch: Branch,
) -> Result<Option<(String, String)>, WorkflowError> {
    for e in edges {
        if e.source == node_id && e.branch == branch.as_str() {
            if !node_index.contains_key(&e.target) {
                return Err(WorkflowError::DanglingEdge(e.id.clone(), e.target.clone()));
            }
            return Ok(Some((e.id.clone(), e.target.clone())));
        }
    }
    Ok(None)
}

/// The two run-scoped identifiers a node execution is tagged with: the
/// workflow run id (groups every node's output into one process / progress
/// run) and the workflow id (echoed back on each event). Bundled so
/// `run_command_node` stays under clippy's argument-count limit and the
/// pair is passed atomically.
#[derive(Clone, Copy)]
struct RunContext<'a> {
    run_id: &'a str,
    workflow_id: &'a str,
    /// When `true`, suppress every `workflow-event` and per-node
    /// `execution-event` for this run (planned cron fire). Threaded into
    /// `build_request` so the node's executor run is silent too.
    silent: bool,
}

/// Run a single command node: build the request, spawn it through the
/// executor with a completion channel, and await the terminal outcome
/// while concurrently watching `cancel_rx`.
///
/// Cancellation is handled HERE, not by the caller, so the in-flight
/// child is actually killed rather than orphaned: on a cancel signal we
/// call `executor::cancel_execution` for this run's `execution_id` (the
/// executor's waiter task kills the whole process group and then sends
/// the terminal `NodeOutcome`), then await that final outcome so the
/// child is reaped before we return. The returned `NodeOutcome` will
/// carry `TerminalStatus::Cancelled` in that case, which the caller maps
/// to `WorkflowError::Cancelled`.
///
/// The runner never holds a shared lock across an await — it owns only
/// the `oneshot` receiver and calls `cancel_execution` (which takes the
/// executor lock briefly and releases it) as a normal async call.
async fn run_command_node<R: Runtime>(
    app: &AppHandle<R>,
    executor_state: Arc<ExecutorState>,
    cmd: &CommandRecord,
    node_id: &str,
    ctx: RunContext<'_>,
    variable_values: BTreeMap<String, String>,
    cancel_rx: &mut oneshot::Receiver<()>,
) -> Result<NodeOutcome, WorkflowError> {
    let execution_id = uuid::Uuid::new_v4().to_string();
    let (tx, mut rx) = oneshot::channel::<NodeOutcome>();

    emit_unless_silent(
        app,
        ctx.silent,
        &WorkflowEvent::NodeStarted {
            run_id: ctx.run_id.to_string(),
            workflow_id: ctx.workflow_id.to_string(),
            node_id: node_id.to_string(),
            execution_id: Some(execution_id.clone()),
        },
    );

    let req = build_request(
        cmd,
        execution_id.clone(),
        ctx.run_id.to_string(),
        variable_values,
        ctx.silent,
    );
    executor::spawn_execution_with_completion(app.clone(), executor_state.clone(), req, Some(tx))
        .await
        .map_err(|e| WorkflowError::Spawn(node_id.to_string(), e))?;

    // Race the node's natural completion against a cancel signal. On
    // cancel we kill the running execution and then await its terminal
    // outcome (now `Cancelled`) so the child is reaped before returning
    // — without this the command would keep running orphaned.
    tokio::select! {
        biased;
        _ = &mut *cancel_rx => {
            // Best-effort kill; `cancel_execution` is idempotent and a
            // no-op if the run already finished in this same tick.
            let _ = executor::cancel_execution(executor_state, execution_id).await;
            rx.await
                .map_err(|_| WorkflowError::LostOutcome(node_id.to_string()))
        }
        outcome = &mut rx => {
            outcome.map_err(|_| WorkflowError::LostOutcome(node_id.to_string()))
        }
    }
}

/// Convert a node's extracted output fields into `${name}` variable
/// values for the next node. String values pass through verbatim; every
/// other JSON value (number, bool, array, object, null) is rendered as
/// its compact JSON text so it is still usable as a shell substitution.
/// Returns an empty map when the node produced no extraction (no schema,
/// or extraction failed).
fn extracted_to_values(outcome: &NodeOutcome) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(extracted) = outcome.extracted.as_ref() {
        for (name, value) in &extracted.fields {
            let text = match value {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            out.insert(name.clone(), text);
        }
    }
    out
}

/// Merge upstream data-flow values with a node's own per-node values.
///
/// Priority (highest first):
///   1. The node's own `node_variable_values` (prompt / user-supplied).
///   2. Upstream `data_flow` fields from the previous node.
///
/// So a value the user explicitly provided for a node always wins over a
/// same-named field carried from the predecessor — matching the accepted
/// design ("prompt/user > data-flow > spec default"; the executor still
/// applies each spec's default for any name absent from BOTH maps).
fn merge_variable_values(
    data_flow: &BTreeMap<String, String>,
    node_values: Option<&BTreeMap<String, String>>,
) -> BTreeMap<String, String> {
    let mut merged = data_flow.clone();
    if let Some(node_values) = node_values {
        for (k, v) in node_values {
            merged.insert(k.clone(), v.clone());
        }
    }
    merged
}

/// Drive a workflow to completion. Internal core shared by the public
/// [`execute_workflow`]; separated so the traversal can return a
/// `Result` and the caller emits the single terminal event. `cancel_rx`
/// is selected against each node's completion so a cancel mid-run stops
/// traversal and tears down the in-flight node.
#[allow(clippy::too_many_arguments)]
async fn traverse<R: Runtime>(
    app: &AppHandle<R>,
    executor_state: Arc<ExecutorState>,
    workflow: &WorkflowRecord,
    commands: &HashMap<String, CommandRecord>,
    node_variable_values: &HashMap<String, BTreeMap<String, String>>,
    run_id: &str,
    silent: bool,
    mut cancel_rx: oneshot::Receiver<()>,
) -> Result<(), WorkflowError> {
    let node_index: HashMap<String, usize> = workflow
        .nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.id.clone(), i))
        .collect();

    let start_idx = find_start(&workflow.nodes)?;
    let mut current = workflow.nodes[start_idx].id.clone();
    let mut steps = 0usize;
    let ctx = RunContext {
        run_id,
        workflow_id: &workflow.id,
        silent,
    };

    // Data-flow carry: the extracted output fields of the most recently
    // executed command/condition node, as `${name}` variable values for
    // the NEXT node. Empty at the start. Each command node merges this
    // UNDER its own per-node values (so prompt / user-supplied values win
    // — see `merge_variable_values`), then overwrites the carry with its
    // own extracted fields.
    let mut data_flow: BTreeMap<String, String> = BTreeMap::new();

    loop {
        steps += 1;
        if steps > MAX_STEPS {
            return Err(WorkflowError::Cycle);
        }

        let idx = *node_index
            .get(&current)
            .ok_or_else(|| WorkflowError::DanglingEdge("<internal>".into(), current.clone()))?;
        let node = &workflow.nodes[idx];
        let kind = NodeKind::parse(&node.kind)
            .ok_or_else(|| WorkflowError::UnknownNodeKind(node.id.clone(), node.kind.clone()))?;

        let next_branch: Branch = match kind {
            NodeKind::End => {
                return Ok(());
            }
            NodeKind::Start => Branch::Out,
            NodeKind::Command => {
                let command_id = node
                    .command_id
                    .as_ref()
                    .ok_or_else(|| WorkflowError::MissingCommandId(node.id.clone()))?;
                let cmd = commands.get(command_id).ok_or_else(|| {
                    WorkflowError::UnknownCommand(node.id.clone(), command_id.clone())
                })?;

                let values = merge_variable_values(&data_flow, node_variable_values.get(&node.id));
                let outcome = run_command_node(
                    app,
                    executor_state.clone(),
                    cmd,
                    &node.id,
                    ctx,
                    values,
                    &mut cancel_rx,
                )
                .await?;

                emit_unless_silent(
                    app,
                    silent,
                    &WorkflowEvent::NodeFinished {
                        run_id: run_id.to_string(),
                        workflow_id: workflow.id.clone(),
                        node_id: node.id.clone(),
                        exit_code: outcome.exit_code,
                    },
                );

                if outcome.status == TerminalStatus::Cancelled {
                    return Err(WorkflowError::Cancelled);
                }
                // Carry this node's extracted fields to the next node.
                data_flow = extracted_to_values(&outcome);
                Branch::Out
            }
            NodeKind::Condition => {
                // MVP semantics: a `condition` node runs its OWN
                // referenced command (the "test") and branches on that
                // command's exit code — exit 0 → `then`, any non-zero →
                // `else`. This keeps the engine stateless (no need to
                // remember the previous node's outcome) and matches the
                // editor's model where a condition is an explicit test
                // step, not a passive inspector of upstream state.
                let command_id = node
                    .command_id
                    .as_ref()
                    .ok_or_else(|| WorkflowError::MissingCommandId(node.id.clone()))?;
                let cmd = commands.get(command_id).ok_or_else(|| {
                    WorkflowError::UnknownCommand(node.id.clone(), command_id.clone())
                })?;

                let values = merge_variable_values(&data_flow, node_variable_values.get(&node.id));
                let outcome = run_command_node(
                    app,
                    executor_state.clone(),
                    cmd,
                    &node.id,
                    ctx,
                    values,
                    &mut cancel_rx,
                )
                .await?;

                emit_unless_silent(
                    app,
                    silent,
                    &WorkflowEvent::NodeFinished {
                        run_id: run_id.to_string(),
                        workflow_id: workflow.id.clone(),
                        node_id: node.id.clone(),
                        exit_code: outcome.exit_code,
                    },
                );

                if outcome.status == TerminalStatus::Cancelled {
                    return Err(WorkflowError::Cancelled);
                }
                // Carry this node's extracted fields to the next node.
                data_flow = extracted_to_values(&outcome);
                if outcome.exit_code == Some(0) {
                    Branch::Then
                } else {
                    Branch::Else
                }
            }
        };

        let edge = edge_for_branch(&workflow.edges, &node_index, &node.id, next_branch)?;
        let (edge_id, target) = match (kind, next_branch, edge) {
            (_, _, Some(found)) => found,
            (NodeKind::Condition, branch, None) => {
                return Err(WorkflowError::MissingBranch(
                    node.id.clone(),
                    branch.as_str().to_string(),
                ));
            }
            (_, _, None) => {
                return Err(WorkflowError::NoOutgoingEdge(node.id.clone()));
            }
        };

        // For a condition node, record which branch was taken so the
        // editor can highlight the path. Start / command nodes have a
        // single `out` edge and don't need the annotation.
        if kind == NodeKind::Condition {
            emit_unless_silent(
                app,
                silent,
                &WorkflowEvent::BranchTaken {
                    run_id: run_id.to_string(),
                    workflow_id: workflow.id.clone(),
                    node_id: node.id.clone(),
                    branch: next_branch.as_str().to_string(),
                    edge_id,
                },
            );
        }

        current = target;
    }
}

/// Kick off a workflow run. Registers a cancellation handle, spawns the
/// traversal on a background task, and returns the `run_id` immediately
/// — mirroring `spawn_execution`'s fire-and-return shape. The terminal
/// `WorkflowEvent` (finished / cancelled / error) is emitted by the
/// background task.
///
/// `commands` must contain every `CommandRecord` referenced by a
/// `command` / `condition` node; the command layer resolves them from
/// storage before calling. The engine itself never touches the DB.
///
/// `node_variable_values` maps a node id to the variable values the
/// command layer collected for it on the frontend (defaults merged with
/// prompt results). A node absent from the map runs with an empty value
/// set, so the executor falls back to each spec's `default_value`.
/// `silent`, when `true` (a planned cron fire via the scheduler), suppresses
/// EVERY `workflow-event` AND every per-node `execution-event` so a background
/// run does not stream to the live console. The run still executes to
/// completion and is recorded in history (the scheduler's `ScheduledRun`).
/// Manual runs (and direct UI runs) pass `false` so they stream as before.
#[allow(clippy::too_many_arguments)]
pub async fn execute_workflow<R: Runtime>(
    app: AppHandle<R>,
    executor_state: Arc<ExecutorState>,
    state: Arc<WorkflowExecutorState>,
    workflow: WorkflowRecord,
    commands: HashMap<String, CommandRecord>,
    node_variable_values: HashMap<String, BTreeMap<String, String>>,
    silent: bool,
) -> Result<String, String> {
    let run_id = uuid::Uuid::new_v4().to_string();
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();

    {
        let mut running = state.running.lock().await;
        running.insert(
            run_id.clone(),
            WorkflowRunningEntry {
                cancel_tx: Some(cancel_tx),
            },
        );
    }

    let run_id_task = run_id.clone();
    let running_arc = state.running.clone();
    tokio::spawn(async move {
        let start = Instant::now();
        let result = traverse(
            &app,
            executor_state,
            &workflow,
            &commands,
            &node_variable_values,
            &run_id_task,
            silent,
            cancel_rx,
        )
        .await;

        {
            let mut map = running_arc.lock().await;
            map.remove(&run_id_task);
        }

        match result {
            Ok(()) => emit_unless_silent(
                &app,
                silent,
                &WorkflowEvent::WorkflowFinished {
                    run_id: run_id_task.clone(),
                    workflow_id: workflow.id.clone(),
                    duration_ms: start.elapsed().as_millis() as u64,
                },
            ),
            // The dedicated `Cancelled` sentinel maps to the cancelled
            // event; every other error variant is a real graph fault and
            // is rendered into the error event's message.
            Err(WorkflowError::Cancelled) => emit_unless_silent(
                &app,
                silent,
                &WorkflowEvent::WorkflowCancelled {
                    run_id: run_id_task.clone(),
                    workflow_id: workflow.id.clone(),
                },
            ),
            Err(err) => emit_unless_silent(
                &app,
                silent,
                &WorkflowEvent::WorkflowError {
                    run_id: run_id_task.clone(),
                    workflow_id: workflow.id.clone(),
                    message: err.to_string(),
                },
            ),
        }
    });

    Ok(run_id)
}

/// Signal a running workflow to cancel. Idempotent: an unknown / already
/// finished run id is a no-op success, matching `cancel_execution`.
pub async fn cancel_workflow(
    state: Arc<WorkflowExecutorState>,
    run_id: String,
) -> Result<(), String> {
    let mut map = state.running.lock().await;
    if let Some(entry) = map.get_mut(&run_id) {
        if let Some(tx) = entry.cancel_tx.take() {
            let _ = tx.send(());
        }
    }
    Ok(())
}

#[cfg(test)]
mod wire_format_tests {
    use super::*;

    #[test]
    fn node_started_wire_format_is_camelcase() {
        let e = WorkflowEvent::NodeStarted {
            run_id: "r1".into(),
            workflow_id: "w1".into(),
            node_id: "n1".into(),
            execution_id: Some("x1".into()),
        };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "nodeStarted");
        assert_eq!(json["runId"], "r1");
        assert_eq!(json["workflowId"], "w1");
        assert_eq!(json["nodeId"], "n1");
        assert_eq!(json["executionId"], "x1");
        assert!(json.get("run_id").is_none());
        assert!(json.get("workflow_id").is_none());
        assert!(json.get("node_id").is_none());
        assert!(json.get("execution_id").is_none());
    }

    #[test]
    fn node_started_omits_absent_execution_id() {
        let e = WorkflowEvent::NodeStarted {
            run_id: "r1".into(),
            workflow_id: "w1".into(),
            node_id: "n1".into(),
            execution_id: None,
        };
        let json = serde_json::to_value(&e).unwrap();
        assert!(json.get("executionId").is_none());
    }

    #[test]
    fn node_finished_wire_format_is_camelcase() {
        let e = WorkflowEvent::NodeFinished {
            run_id: "r1".into(),
            workflow_id: "w1".into(),
            node_id: "n1".into(),
            exit_code: Some(0),
        };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "nodeFinished");
        assert_eq!(json["exitCode"], 0);
        assert!(json.get("exit_code").is_none());
    }

    #[test]
    fn branch_taken_wire_format_is_camelcase() {
        let e = WorkflowEvent::BranchTaken {
            run_id: "r1".into(),
            workflow_id: "w1".into(),
            node_id: "n1".into(),
            branch: "then".into(),
            edge_id: "e1".into(),
        };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "branchTaken");
        assert_eq!(json["branch"], "then");
        assert_eq!(json["edgeId"], "e1");
        assert!(json.get("edge_id").is_none());
    }

    #[test]
    fn workflow_finished_wire_format_is_camelcase() {
        let e = WorkflowEvent::WorkflowFinished {
            run_id: "r1".into(),
            workflow_id: "w1".into(),
            duration_ms: 42,
        };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "workflowFinished");
        assert_eq!(json["durationMs"], 42);
        assert!(json.get("duration_ms").is_none());
    }

    #[test]
    fn workflow_cancelled_and_error_wire_format() {
        let c = WorkflowEvent::WorkflowCancelled {
            run_id: "r1".into(),
            workflow_id: "w1".into(),
        };
        let cj = serde_json::to_value(&c).unwrap();
        assert_eq!(cj["kind"], "workflowCancelled");

        let e = WorkflowEvent::WorkflowError {
            run_id: "r1".into(),
            workflow_id: "w1".into(),
            message: "boom".into(),
        };
        let ej = serde_json::to_value(&e).unwrap();
        assert_eq!(ej["kind"], "workflowError");
        assert_eq!(ej["message"], "boom");
    }
}

#[cfg(test)]
mod graph_tests {
    use super::*;
    use crate::storage::workflows::{NodePosition, WorkflowNodeRecord};

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

    #[test]
    fn find_start_requires_exactly_one() {
        let none: Vec<WorkflowNodeRecord> = vec![node("a", "command", Some("c"))];
        assert_eq!(find_start(&none), Err(WorkflowError::NoStart));

        let two = vec![node("s1", "start", None), node("s2", "start", None)];
        assert_eq!(find_start(&two), Err(WorkflowError::MultipleStarts));

        let one = vec![node("s", "start", None), node("c", "command", Some("x"))];
        assert_eq!(find_start(&one), Ok(0));
    }

    #[test]
    fn find_start_rejects_unknown_kind() {
        let bad = vec![node("s", "frobnicate", None)];
        assert_eq!(
            find_start(&bad),
            Err(WorkflowError::UnknownNodeKind(
                "s".into(),
                "frobnicate".into()
            ))
        );
    }

    #[test]
    fn edge_for_branch_detects_dangling_target() {
        let edges = vec![edge("e1", "a", "ghost", "out")];
        let index: HashMap<String, usize> = [("a".to_string(), 0)].into_iter().collect();
        let res = edge_for_branch(&edges, &index, "a", Branch::Out);
        assert_eq!(
            res,
            Err(WorkflowError::DanglingEdge("e1".into(), "ghost".into()))
        );
    }

    #[test]
    fn edge_for_branch_returns_none_when_absent() {
        let edges = vec![edge("e1", "a", "b", "then")];
        let index: HashMap<String, usize> = [("a".to_string(), 0), ("b".to_string(), 1)]
            .into_iter()
            .collect();
        let res = edge_for_branch(&edges, &index, "a", Branch::Else).unwrap();
        assert!(res.is_none());
    }

    #[test]
    fn edge_for_branch_matches_source_and_branch() {
        let edges = vec![
            edge("e_then", "cond", "ok", "then"),
            edge("e_else", "cond", "fail", "else"),
        ];
        let index: HashMap<String, usize> = [
            ("cond".to_string(), 0),
            ("ok".to_string(), 1),
            ("fail".to_string(), 2),
        ]
        .into_iter()
        .collect();
        let (eid, target) = edge_for_branch(&edges, &index, "cond", Branch::Else)
            .unwrap()
            .unwrap();
        assert_eq!(eid, "e_else");
        assert_eq!(target, "fail");
    }
}
