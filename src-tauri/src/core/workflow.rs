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
use crate::core::workflow_condition::{self, EvalContext};
use crate::storage::commands::CommandRecord;
use crate::storage::workflows::{
    DataAssignmentRecord, DataSourceRecord, LoopConfigRecord, RetryConfigRecord, SwitchCaseRecord,
    WorkflowEdgeRecord, WorkflowNodeRecord, WorkflowRecord,
};

pub const WORKFLOW_EVENT: &str = "workflow-event";

/// Hard cap on the number of nodes a single run may visit. Defends
/// against cycles in a malformed graph (the editor should prevent them,
/// but a hand-edited DB or a future bug must not hang the runner). A
/// well-formed MVP workflow is far smaller than this; exceeding it is
/// treated as a `Cycle` error.
const MAX_STEPS: usize = 10_000;

/// Branch discriminator on an edge. Mirrors the TS `WorkflowEdgeBranch`
/// union and the `branch` string stored on `WorkflowEdgeRecord`.
///
/// `Case` carries the user-authored case id and renders as `case:<id>`, so
/// `Branch` is NOT `Copy` (it owns a `String`); it is passed by reference to
/// [`edge_for_branch`] and cloned only when an event needs to own the label.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Branch {
    Out,
    Then,
    Else,
    /// A `switch` case selected by its predicate. Edge label: `case:<id>`.
    Case(String),
    /// A `switch`'s fallback when no case matched. Edge label: `default`.
    Default,
    /// A `loop`'s iteration entry — enters the body sub-graph. Edge: `body`.
    Body,
    /// A `loop`'s completion exit, taken when iteration stops. Edge: `done`.
    Done,
    /// A `try`'s success exit (command finished exit 0). Edge: `ok`.
    Ok,
    /// A `try`'s failure exit, taken once retries are exhausted. Edge: `catch`.
    Catch,
}

impl Branch {
    /// The exact string this branch is stored as on `WorkflowEdgeRecord.branch`
    /// (and emitted on `BranchTaken.branch`). Mirrors the TS
    /// `WorkflowEdgeBranch` rendering: `case:<id>` for a switch case, the bare
    /// lowercase name otherwise.
    fn to_branch_string(&self) -> String {
        match self {
            Branch::Out => "out".to_string(),
            Branch::Then => "then".to_string(),
            Branch::Else => "else".to_string(),
            Branch::Case(id) => format!("case:{id}"),
            Branch::Default => "default".to_string(),
            Branch::Body => "body".to_string(),
            Branch::Done => "done".to_string(),
            Branch::Ok => "ok".to_string(),
            Branch::Catch => "catch".to_string(),
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
    Switch,
    Loop,
    Try,
    Data,
    End,
}

impl NodeKind {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "start" => Some(NodeKind::Start),
            "command" => Some(NodeKind::Command),
            "condition" => Some(NodeKind::Condition),
            "switch" => Some(NodeKind::Switch),
            "loop" => Some(NodeKind::Loop),
            "try" => Some(NodeKind::Try),
            "data" => Some(NodeKind::Data),
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
    #[error("node {0} has more than one outgoing edge on the {1} branch")]
    AmbiguousBranch(String, String),
    #[error("command node {0} has no outgoing edge")]
    NoOutgoingEdge(String),
    #[error("switch node {0} has no default branch and no case matched")]
    NoMatchingCase(String),
    #[error("node {0} has an invalid condition: {1}")]
    ConditionEval(String, String),
    #[error("loop node {0} is missing its loop config")]
    LoopMissingConfig(String),
    #[error("loop node {0} must set exactly one of `count` or `while`")]
    LoopMisconfigured(String),
    #[error("loop node {0} exceeded its maximum of {1} iterations")]
    LoopLimit(String, u32),
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
    /// Emitted by a `loop` node each time it enters its body (one per
    /// iteration), so the editor can show iteration progress. `iteration` is
    /// 1-based (the first body entry is iteration 1). Not emitted on the final
    /// `done` exit.
    #[serde(rename = "loopIteration")]
    LoopIteration {
        run_id: String,
        workflow_id: String,
        node_id: String,
        iteration: u32,
    },
    /// Emitted by a `try` node before each retry attempt, after a failed
    /// attempt and before the backoff pause. `attempt` is the 1-based number of
    /// the attempt ABOUT TO RUN (so the first retry is `attempt: 2`). Lets the
    /// editor show "retrying (2/4)…". Not emitted before the first attempt.
    #[serde(rename = "nodeRetry")]
    NodeRetry {
        run_id: String,
        workflow_id: String,
        node_id: String,
        attempt: u32,
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
/// its target exists and that the branch is unambiguous. Returns
/// `(edge_id, target_node_id)`.
///
/// A node must have AT MOST ONE outgoing edge per branch: the traversal is
/// strictly sequential, so two `out` edges (or two `then` edges) from the
/// same node have no defined meaning. The MVP silently took the first match
/// by storage order, making a hand-edited / buggy graph route
/// nondeterministically. We now reject a second match on the same
/// `(source, branch)` with `AmbiguousBranch` so the fault is surfaced
/// instead of hidden.
fn edge_for_branch(
    edges: &[WorkflowEdgeRecord],
    node_index: &HashMap<String, usize>,
    node_id: &str,
    branch: &Branch,
) -> Result<Option<(String, String)>, WorkflowError> {
    let branch_str = branch.to_branch_string();
    let mut found: Option<(String, String)> = None;
    for e in edges {
        if e.source == node_id && e.branch == branch_str {
            if !node_index.contains_key(&e.target) {
                return Err(WorkflowError::DanglingEdge(e.id.clone(), e.target.clone()));
            }
            if found.is_some() {
                return Err(WorkflowError::AmbiguousBranch(
                    node_id.to_string(),
                    branch_str,
                ));
            }
            found = Some((e.id.clone(), e.target.clone()));
        }
    }
    Ok(found)
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

/// Build the pure [`EvalContext`] a condition is evaluated against from a
/// finished node's outcome: its exit code, its extracted output fields (the
/// same projection data-flow uses, so `Variable`-subject conditions see the
/// same names a downstream `${name}` would), and its bounded stdout tail.
/// Keeping this a free function lets it be unit-tested without an executor.
fn build_eval_context(outcome: &NodeOutcome) -> EvalContext {
    EvalContext {
        exit_code: outcome.exit_code,
        variables: extracted_to_values(outcome),
        stdout: outcome.stdout_tail.clone(),
    }
}

/// Choose the branch a `condition` node takes. When the node carries an
/// explicit `predicate`, it is evaluated against the test command's outcome:
/// true → `then`, false → `else`. When it is `None`, the node falls back to
/// the MVP exit-code rule (exit 0 → `then`, non-zero → `else`). A malformed
/// predicate (bad regex) surfaces as `ConditionEval`, not a silent `else`.
/// Pure — no executor, fully unit-testable.
fn select_condition_branch(
    node_id: &str,
    predicate: Option<&workflow_condition::Condition>,
    ctx: &EvalContext,
) -> Result<Branch, WorkflowError> {
    let took_then = match predicate {
        Some(cond) => workflow_condition::evaluate(cond, ctx)
            .map_err(|e| WorkflowError::ConditionEval(node_id.to_string(), e.to_string()))?,
        None => ctx.exit_code == Some(0),
    };
    Ok(if took_then {
        Branch::Then
    } else {
        Branch::Else
    })
}

/// Expand `${name}` references in `template` against `vars`. A reference to a
/// name not present in `vars` resolves to the EMPTY string — the same lenient
/// rule a `Variable`-subject condition uses for a missing data-flow field, so
/// the engine treats "missing field" uniformly across conditions and data
/// nodes. `$$` is a literal `$`. Non-reference text (including multibyte UTF-8)
/// passes through unchanged.
///
/// This is intentionally a small, self-contained expander rather than a reuse
/// of `parser::substitute`: that one is command-oriented (consults
/// `VariableSpec` defaults and ERRORS on a missing variable), which is the
/// wrong contract for a data node's lenient, spec-less assignment.
fn expand_refs(template: &str, vars: &BTreeMap<String, String>) -> String {
    let bytes = template.as_bytes();
    let mut out = String::with_capacity(template.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'$' {
            // Copy this byte's char. Find the next `$` and copy the whole span
            // at once so multibyte sequences are never split.
            let next = template[i..]
                .find('$')
                .map(|off| i + off)
                .unwrap_or(template.len());
            out.push_str(&template[i..next]);
            i = next;
            continue;
        }
        // At a `$`.
        if i + 1 < bytes.len() && bytes[i + 1] == b'$' {
            out.push('$');
            i += 2;
            continue;
        }
        if i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            if let Some(close_off) = template[i + 2..].find('}') {
                let name = &template[i + 2..i + 2 + close_off];
                if let Some(v) = vars.get(name) {
                    out.push_str(v);
                }
                // Missing → empty (push nothing).
                i = i + 2 + close_off + 1;
                continue;
            }
        }
        // A lone `$` (or malformed `${` with no `}`) is kept verbatim.
        out.push('$');
        i += 1;
    }
    out
}

/// Snapshot of the node executed immediately before the current one on the
/// path the runner walked — everything a `data` node may pull a value from.
/// Built after each executed node; `None` before the first one (and after a
/// pure `data`/`start` node, which produce no outcome of their own).
#[derive(Debug, Clone, Default)]
struct PrevOutcome {
    /// Bounded, redacted stdout tail (a command-bearing node), if any.
    stdout_tail: Option<String>,
    /// Process exit code, if the node ran a command.
    exit_code: Option<i32>,
    /// Named output-schema fields the node extracted (rendered as strings).
    fields: BTreeMap<String, String>,
    /// `try` node: attempts made (1 = first-try success). `None` otherwise.
    retry_count: Option<u32>,
    /// `condition` node: did its test pass. `None` for other kinds.
    condition_result: Option<bool>,
    /// `switch` node: the case id taken ("default" when none matched).
    matched_case: Option<String>,
    /// `loop` node: completed iterations at the point it exited via `done`.
    loop_iterations: Option<u32>,
}

impl PrevOutcome {
    /// Build the command-derived part (stdout / exit / fields) from a
    /// finished node's outcome. Kind-specific extras are layered on by the
    /// caller (`retry_count`, `condition_result`, …).
    fn from_outcome(outcome: &NodeOutcome) -> Self {
        PrevOutcome {
            stdout_tail: outcome.stdout_tail.clone(),
            exit_code: outcome.exit_code,
            fields: extracted_to_values(outcome),
            ..Default::default()
        }
    }
}

/// Resolve a single data-node source to its string value, reading from the
/// previous node's outcome when needed. A source that doesn't apply to what
/// actually ran (e.g. `RetryCount` after a plain command, or any non-`Manual`
/// source with no predecessor) resolves to the EMPTY string — the same
/// lenient "missing → empty" rule the rest of the engine uses, so a graph
/// edited into an inapplicable state degrades gracefully instead of aborting.
/// `Manual` is `${ref}`-expanded against the current data-flow (unchanged
/// legacy behaviour). Pure — fully unit-testable.
fn resolve_data_source(
    source: &DataSourceRecord,
    prev: Option<&PrevOutcome>,
    data_flow: &BTreeMap<String, String>,
) -> String {
    match source {
        DataSourceRecord::Manual { value } => expand_refs(value, data_flow),
        DataSourceRecord::RawOutput => prev.and_then(|p| p.stdout_tail.clone()).unwrap_or_default(),
        DataSourceRecord::SchemaOutput => match prev {
            // The full extracted result as one value: a compact JSON object of
            // every extracted field. Empty string when the prev node extracted
            // nothing (no schema), matching the lenient "missing → empty" rule.
            Some(p) if !p.fields.is_empty() => serde_json::to_string(&p.fields).unwrap_or_default(),
            _ => String::new(),
        },
        DataSourceRecord::ExitCode => prev
            .and_then(|p| p.exit_code)
            .map(|c| c.to_string())
            .unwrap_or_default(),
        DataSourceRecord::Field { field } => prev
            .and_then(|p| p.fields.get(field).cloned())
            .unwrap_or_default(),
        DataSourceRecord::RetryCount => prev
            .and_then(|p| p.retry_count)
            .map(|n| n.to_string())
            .unwrap_or_default(),
        DataSourceRecord::ConditionResult => prev
            .and_then(|p| p.condition_result)
            .map(|b| b.to_string())
            .unwrap_or_default(),
        DataSourceRecord::MatchedCase => prev
            .and_then(|p| p.matched_case.clone())
            .unwrap_or_default(),
        DataSourceRecord::LoopIterations => prev
            .and_then(|p| p.loop_iterations)
            .map(|n| n.to_string())
            .unwrap_or_default(),
    }
}

/// Apply a `data` node's assignments to the data-flow map, in order, pulling
/// each value from its source (see [`resolve_data_source`]). A later
/// assignment sees an earlier one in the same node (the `Manual` `${ref}`
/// expansion reads the live `data_flow`). Pure — fully unit-testable.
fn apply_data_assignments(
    assignments: &[DataAssignmentRecord],
    prev: Option<&PrevOutcome>,
    data_flow: &mut BTreeMap<String, String>,
) {
    for a in assignments {
        let value = resolve_data_source(&a.effective_source(), prev, data_flow);
        data_flow.insert(a.name.clone(), value);
    }
}

/// Choose the branch a `switch` node takes from its cases and the test
/// command's outcome: the FIRST case whose predicate evaluates true (in
/// declaration order) yields `Branch::Case(id)`; if none match, `Branch::
/// Default`. A malformed predicate (bad regex) is surfaced as a
/// `ConditionEval` error rather than silently skipped, so the author learns
/// the case never fires. Pure — no executor, fully unit-testable.
fn select_switch_branch(
    node_id: &str,
    cases: &[SwitchCaseRecord],
    ctx: &EvalContext,
) -> Result<Branch, WorkflowError> {
    for case in cases {
        let matched = workflow_condition::evaluate(&case.condition, ctx)
            .map_err(|e| WorkflowError::ConditionEval(node_id.to_string(), e.to_string()))?;
        if matched {
            return Ok(Branch::Case(case.id.clone()));
        }
    }
    Ok(Branch::Default)
}

/// Decide whether a `loop` node continues (→ `Branch::Body`) or stops
/// (→ `Branch::Done`), given its config, the number of iterations ALREADY
/// completed, and the data-flow context the `while` predicate evaluates
/// against. Pure — no executor, fully unit-testable.
///
/// Rules, in order:
///  1. **Hard cap first.** If `completed >= max_iterations`, return `LoopLimit`
///     — the safety bound is checked BEFORE the mode logic so a runaway
///     `while` loop (or a `count` larger than the cap) can never spin past it.
///  2. **Exactly one mode.** Exactly one of `count` / `while` must be set;
///     neither or both is a `LoopMisconfigured` authoring error.
///  3. **count mode:** continue while `completed < count`.
///  4. **while mode:** continue while the predicate holds (a bad regex
///     surfaces as `ConditionEval`, not a silent stop).
fn loop_should_continue(
    node_id: &str,
    cfg: &LoopConfigRecord,
    completed: u32,
    ctx: &EvalContext,
) -> Result<Branch, WorkflowError> {
    if completed >= cfg.max_iterations {
        return Err(WorkflowError::LoopLimit(
            node_id.to_string(),
            cfg.max_iterations,
        ));
    }
    match (cfg.count, cfg.while_condition.as_ref()) {
        (Some(count), None) => {
            if completed < count {
                Ok(Branch::Body)
            } else {
                Ok(Branch::Done)
            }
        }
        (None, Some(cond)) => {
            let keep_going = workflow_condition::evaluate(cond, ctx)
                .map_err(|e| WorkflowError::ConditionEval(node_id.to_string(), e.to_string()))?;
            if keep_going {
                Ok(Branch::Body)
            } else {
                Ok(Branch::Done)
            }
        }
        // Neither or both set → an authoring error, not a guess.
        _ => Err(WorkflowError::LoopMisconfigured(node_id.to_string())),
    }
}

/// Sleep for `backoff_ms`, but abort early if the run is cancelled. Returns
/// `Err(Cancelled)` if the cancel signal fires during the pause so the retry
/// loop stops cleanly instead of waiting out a long backoff. A `0`/`None`
/// backoff is a no-op (immediate retry).
async fn cancellable_backoff(
    backoff_ms: Option<u64>,
    node_id: &str,
    cancel_rx: &mut oneshot::Receiver<()>,
) -> Result<(), WorkflowError> {
    let ms = backoff_ms.unwrap_or(0);
    if ms == 0 {
        // Still observe an already-delivered cancel so a 0-backoff retry loop
        // can't ignore a cancel that arrived between attempts.
        return match cancel_rx.try_recv() {
            Ok(()) => Err(WorkflowError::Cancelled),
            Err(_) => Ok(()),
        };
    }
    tokio::select! {
        biased;
        _ = &mut *cancel_rx => Err(WorkflowError::Cancelled),
        _ = tokio::time::sleep(std::time::Duration::from_millis(ms)) => {
            let _ = node_id; // node_id reserved for future per-node trace spans
            Ok(())
        }
    }
}

/// Run a node that executes its referenced command (`command` / `condition` /
/// `switch` / `try`), shared by every command-running arm so the resolve →
/// run → emit `NodeFinished` → cancel-check → carry-data-flow sequence lives in
/// ONE place.
///
/// Resolves the node's `commandId`, merges the upstream `data_flow` under the
/// node's own values, runs it through [`run_command_node`], emits the
/// `NodeFinished` event, maps a cancellation to `WorkflowError::Cancelled`, and
/// overwrites `data_flow` with this node's extracted fields for the next node.
/// Returns the terminal [`NodeOutcome`] so the caller can pick its branch.
///
/// When `retry` is `Some`, a non-zero exit triggers up to `retries` additional
/// attempts, each preceded by a `NodeRetry` event and a cancellable backoff;
/// the FINAL attempt's outcome is returned (the caller's `ok`/`catch` choice
/// reads its exit code). A hard `Spawn` / `LostOutcome` error is NOT retried —
/// it means the command could not run at all, which a retry won't fix — so it
/// propagates immediately. `None` runs exactly once (command/condition/switch).
///
/// Returns `(outcome, attempts)` where `attempts` is the number of times the
/// command actually ran (1 = succeeded / gave up on the first try); a `try`
/// node exposes this as its `retryCount` data source.
#[allow(clippy::too_many_arguments)]
async fn run_command_bearing_node<R: Runtime>(
    app: &AppHandle<R>,
    executor_state: &Arc<ExecutorState>,
    commands: &HashMap<String, CommandRecord>,
    node: &WorkflowNodeRecord,
    node_variable_values: &HashMap<String, BTreeMap<String, String>>,
    data_flow: &mut BTreeMap<String, String>,
    ctx: RunContext<'_>,
    retry: Option<&RetryConfigRecord>,
    cancel_rx: &mut oneshot::Receiver<()>,
) -> Result<(NodeOutcome, u32), WorkflowError> {
    let command_id = node
        .command_id
        .as_ref()
        .ok_or_else(|| WorkflowError::MissingCommandId(node.id.clone()))?;
    let cmd = commands
        .get(command_id)
        .ok_or_else(|| WorkflowError::UnknownCommand(node.id.clone(), command_id.clone()))?;

    // Total attempts = 1 (first run) + retries. `retries == 0` (or no config)
    // means a single attempt, identical to the pre-retry behaviour.
    let max_retries = retry.map(|r| r.retries).unwrap_or(0);
    let backoff_ms = retry.and_then(|r| r.backoff_ms);

    let mut attempt: u32 = 1;
    loop {
        let values = merge_variable_values(data_flow, node_variable_values.get(&node.id));
        let outcome = run_command_node(
            app,
            executor_state.clone(),
            cmd,
            &node.id,
            ctx,
            values,
            cancel_rx,
        )
        .await?;

        emit_unless_silent(
            app,
            ctx.silent,
            &WorkflowEvent::NodeFinished {
                run_id: ctx.run_id.to_string(),
                workflow_id: ctx.workflow_id.to_string(),
                node_id: node.id.clone(),
                exit_code: outcome.exit_code,
            },
        );

        if outcome.status == TerminalStatus::Cancelled {
            return Err(WorkflowError::Cancelled);
        }

        // Success, or no retries left → this is the final outcome. Carry its
        // extracted fields and return.
        let succeeded = outcome.exit_code == Some(0);
        if succeeded || attempt > max_retries {
            *data_flow = extracted_to_values(&outcome);
            return Ok((outcome, attempt));
        }

        // Failed with attempts remaining: announce the upcoming retry, wait the
        // (cancellable) backoff, then loop. `attempt + 1` is the number of the
        // attempt about to run.
        attempt += 1;
        emit_unless_silent(
            app,
            ctx.silent,
            &WorkflowEvent::NodeRetry {
                run_id: ctx.run_id.to_string(),
                workflow_id: ctx.workflow_id.to_string(),
                node_id: node.id.clone(),
                attempt,
            },
        );
        cancellable_backoff(backoff_ms, &node.id, cancel_rx).await?;
    }
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

    // Per-`loop`-node count of COMPLETED iterations within this run. A loop
    // node is re-entered each time its body sub-graph flows back to it; this
    // map is how the otherwise-stateless traversal remembers how many times
    // each loop has gone round. Keyed by node id (loops never share state).
    let mut loop_iterations: HashMap<String, u32> = HashMap::new();

    // The outcome of the node executed immediately before the current one, so
    // a `data` node can pull a value from its predecessor (raw output, exit
    // code, retry count, …). `None` at the start; reset to `None` after a pure
    // node (`data`/`start`) that produces no outcome of its own.
    let mut prev: Option<PrevOutcome> = None;

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
            NodeKind::Start => {
                prev = None;
                Branch::Out
            }
            NodeKind::Data => {
                // A `data` node runs NO command: it derives data-flow variables
                // from each assignment's source — reading the PREVIOUS node's
                // outcome for non-manual sources — then continues on its single
                // `out` edge. Pure and instant; emits no per-node events. After
                // it, there is no command outcome to carry, so `prev` is reset.
                apply_data_assignments(&node.data, prev.as_ref(), &mut data_flow);
                prev = None;
                Branch::Out
            }
            NodeKind::Command => {
                let (outcome, _attempts) = run_command_bearing_node(
                    app,
                    &executor_state,
                    commands,
                    node,
                    node_variable_values,
                    &mut data_flow,
                    ctx,
                    None,
                    &mut cancel_rx,
                )
                .await?;
                prev = Some(PrevOutcome::from_outcome(&outcome));
                Branch::Out
            }
            NodeKind::Condition => {
                // A `condition` node runs its OWN referenced command (the
                // "test"), then branches: when a `condition` predicate is set
                // it is evaluated against the outcome (`then`/`else`), otherwise
                // it falls back to the exit code (exit 0 → `then`, non-zero →
                // `else`) — preserving exact MVP behaviour for predicate-less
                // nodes.
                let (outcome, _attempts) = run_command_bearing_node(
                    app,
                    &executor_state,
                    commands,
                    node,
                    node_variable_values,
                    &mut data_flow,
                    ctx,
                    None,
                    &mut cancel_rx,
                )
                .await?;
                let eval_ctx = build_eval_context(&outcome);
                let branch = select_condition_branch(&node.id, node.condition.as_ref(), &eval_ctx)?;
                let mut p = PrevOutcome::from_outcome(&outcome);
                p.condition_result = Some(branch == Branch::Then);
                prev = Some(p);
                branch
            }
            NodeKind::Switch => {
                // A `switch` node runs its referenced command as a test, then
                // takes the first `case` whose predicate matches (in
                // declaration order), or `default` when none match.
                let (outcome, _attempts) = run_command_bearing_node(
                    app,
                    &executor_state,
                    commands,
                    node,
                    node_variable_values,
                    &mut data_flow,
                    ctx,
                    None,
                    &mut cancel_rx,
                )
                .await?;
                let eval_ctx = build_eval_context(&outcome);
                let branch = select_switch_branch(&node.id, &node.cases, &eval_ctx)?;
                let mut p = PrevOutcome::from_outcome(&outcome);
                p.matched_case = Some(match &branch {
                    Branch::Case(id) => id.clone(),
                    _ => "default".to_string(),
                });
                prev = Some(p);
                branch
            }
            NodeKind::Loop => {
                // A `loop` node runs NO command of its own: it is a control
                // point re-entered each time its body sub-graph flows back to
                // it. It decides — from its config, the iterations already
                // completed, and the current data-flow — whether to enter the
                // body again (`body`) or finish (`done`). The `while` predicate
                // inspects the data-flow the body produced (exit code / stdout
                // belong to body commands, not the loop node), so the context
                // carries only `variables`.
                let cfg = node
                    .loop_config
                    .as_ref()
                    .ok_or_else(|| WorkflowError::LoopMissingConfig(node.id.clone()))?;
                let completed = *loop_iterations.get(&node.id).unwrap_or(&0);
                let eval_ctx = EvalContext {
                    exit_code: None,
                    variables: data_flow.clone(),
                    stdout: None,
                };
                let branch = loop_should_continue(&node.id, cfg, completed, &eval_ctx)?;
                if branch == Branch::Body {
                    // Entering the body: record the new (1-based) iteration and
                    // announce it so the editor can show progress. The loop node
                    // itself produces no outcome — the body's nodes will — so
                    // `prev` is cleared.
                    let iteration = completed + 1;
                    loop_iterations.insert(node.id.clone(), iteration);
                    emit_unless_silent(
                        app,
                        silent,
                        &WorkflowEvent::LoopIteration {
                            run_id: run_id.to_string(),
                            workflow_id: workflow.id.clone(),
                            node_id: node.id.clone(),
                            iteration,
                        },
                    );
                    prev = None;
                } else {
                    // Leaving the loop: expose the completed-iteration count to a
                    // downstream `data` node, then clear the counter so a re-entry
                    // later in the SAME run (e.g. an outer loop wrapping this one)
                    // starts a fresh count rather than resuming the old one.
                    prev = Some(PrevOutcome {
                        loop_iterations: Some(completed),
                        ..Default::default()
                    });
                    loop_iterations.remove(&node.id);
                }
                branch
            }
            NodeKind::Try => {
                // A `try` node runs its referenced command with retries (its
                // `retry` config). The final attempt's exit code decides the
                // exit: success (exit 0) → `ok`, failure after retries → `catch`.
                let (outcome, attempts) = run_command_bearing_node(
                    app,
                    &executor_state,
                    commands,
                    node,
                    node_variable_values,
                    &mut data_flow,
                    ctx,
                    node.retry.as_ref(),
                    &mut cancel_rx,
                )
                .await?;
                let branch = if outcome.exit_code == Some(0) {
                    Branch::Ok
                } else {
                    Branch::Catch
                };
                let mut p = PrevOutcome::from_outcome(&outcome);
                p.retry_count = Some(attempts);
                prev = Some(p);
                branch
            }
        };

        // Whether this node makes an explicit branch choice (condition /
        // switch / loop / try). Used both to pick the right "no edge" error and
        // to decide whether to emit a `BranchTaken` event for the editor.
        let is_branching = matches!(
            kind,
            NodeKind::Condition | NodeKind::Switch | NodeKind::Loop | NodeKind::Try
        );
        let branch_label = next_branch.to_branch_string();

        let edge = edge_for_branch(&workflow.edges, &node_index, &node.id, &next_branch)?;
        let (edge_id, target) = match edge {
            Some(found) => found,
            None if matches!(kind, NodeKind::Switch) => {
                // A switch with no matching case AND no `default` edge has
                // nowhere to go — a more specific error than a bare missing
                // edge so the author knows to add a default.
                return Err(WorkflowError::NoMatchingCase(node.id.clone()));
            }
            None if is_branching => {
                return Err(WorkflowError::MissingBranch(node.id.clone(), branch_label));
            }
            None => {
                return Err(WorkflowError::NoOutgoingEdge(node.id.clone()));
            }
        };

        // For a branching node (condition / switch), record which branch was
        // taken so the editor can highlight the path. Start / command nodes
        // have a single `out` edge and don't need the annotation.
        if is_branching {
            emit_unless_silent(
                app,
                silent,
                &WorkflowEvent::BranchTaken {
                    run_id: run_id.to_string(),
                    workflow_id: workflow.id.clone(),
                    node_id: node.id.clone(),
                    branch: branch_label,
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
    fn loop_iteration_wire_format_is_camelcase() {
        let e = WorkflowEvent::LoopIteration {
            run_id: "r1".into(),
            workflow_id: "w1".into(),
            node_id: "lp".into(),
            iteration: 2,
        };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "loopIteration");
        assert_eq!(json["runId"], "r1");
        assert_eq!(json["workflowId"], "w1");
        assert_eq!(json["nodeId"], "lp");
        assert_eq!(json["iteration"], 2);
        assert!(json.get("node_id").is_none());
    }

    #[test]
    fn node_retry_wire_format_is_camelcase() {
        let e = WorkflowEvent::NodeRetry {
            run_id: "r1".into(),
            workflow_id: "w1".into(),
            node_id: "tr".into(),
            attempt: 2,
        };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "nodeRetry");
        assert_eq!(json["nodeId"], "tr");
        assert_eq!(json["attempt"], 2);
        assert!(json.get("node_id").is_none());
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
            condition: None,
            cases: Vec::new(),
            loop_config: None,
            retry: None,
            data: Vec::new(),
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
        let res = edge_for_branch(&edges, &index, "a", &Branch::Out);
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
        let res = edge_for_branch(&edges, &index, "a", &Branch::Else).unwrap();
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
        let (eid, target) = edge_for_branch(&edges, &index, "cond", &Branch::Else)
            .unwrap()
            .unwrap();
        assert_eq!(eid, "e_else");
        assert_eq!(target, "fail");
    }

    #[test]
    fn edge_for_branch_rejects_two_edges_on_same_branch() {
        // Two `out` edges from the same node is ambiguous: a strictly
        // sequential traversal has no defined way to pick one. The MVP took
        // the first by storage order (nondeterministic). It must now error.
        let edges = vec![edge("e1", "a", "b", "out"), edge("e2", "a", "c", "out")];
        let index: HashMap<String, usize> = [
            ("a".to_string(), 0),
            ("b".to_string(), 1),
            ("c".to_string(), 2),
        ]
        .into_iter()
        .collect();
        let res = edge_for_branch(&edges, &index, "a", &Branch::Out);
        assert_eq!(
            res,
            Err(WorkflowError::AmbiguousBranch("a".into(), "out".into()))
        );
    }

    #[test]
    fn edge_for_branch_dangling_target_beats_ambiguity_check() {
        // A dangling target on the FIRST matching edge is reported as a
        // dangling edge, not masked by a later ambiguity — the dangling
        // check runs per-edge before the duplicate check.
        let edges = vec![edge("e1", "a", "ghost", "out")];
        let index: HashMap<String, usize> = [("a".to_string(), 0)].into_iter().collect();
        let res = edge_for_branch(&edges, &index, "a", &Branch::Out);
        assert_eq!(
            res,
            Err(WorkflowError::DanglingEdge("e1".into(), "ghost".into()))
        );
    }

    // ---- §3 switch routing -------------------------------------------------

    use crate::core::workflow_condition::{Condition, Op, Subject};

    fn case(id: &str, subject: Subject, op: Op, value: &str) -> SwitchCaseRecord {
        SwitchCaseRecord {
            id: id.into(),
            condition: Condition {
                subject,
                op,
                value: value.into(),
            },
        }
    }

    fn ctx_exit(code: Option<i32>) -> EvalContext {
        EvalContext {
            exit_code: code,
            ..Default::default()
        }
    }

    #[test]
    fn branch_renders_case_with_id_and_named_branches() {
        assert_eq!(Branch::Out.to_branch_string(), "out");
        assert_eq!(Branch::Then.to_branch_string(), "then");
        assert_eq!(Branch::Else.to_branch_string(), "else");
        assert_eq!(Branch::Default.to_branch_string(), "default");
        assert_eq!(Branch::Case("ok".into()).to_branch_string(), "case:ok");
    }

    #[test]
    fn switch_takes_first_matching_case_in_order() {
        // Two cases both match exit code 0; the FIRST in declaration order wins.
        let cases = vec![
            case("zero", Subject::ExitCode, Op::Eq, "0"),
            case("also", Subject::ExitCode, Op::Lt, "10"),
        ];
        let branch = select_switch_branch("sw", &cases, &ctx_exit(Some(0))).unwrap();
        assert_eq!(branch, Branch::Case("zero".into()));
    }

    #[test]
    fn switch_falls_through_to_default_when_no_case_matches() {
        let cases = vec![case("zero", Subject::ExitCode, Op::Eq, "0")];
        let branch = select_switch_branch("sw", &cases, &ctx_exit(Some(7))).unwrap();
        assert_eq!(branch, Branch::Default);
    }

    #[test]
    fn switch_with_no_cases_is_default() {
        let branch = select_switch_branch("sw", &[], &ctx_exit(Some(0))).unwrap();
        assert_eq!(branch, Branch::Default);
    }

    #[test]
    fn switch_surfaces_bad_regex_as_condition_eval_error() {
        // An unmatched-paren regex must abort with a typed `ConditionEval`,
        // not be silently treated as "no match".
        let cases = vec![case("re", Subject::Stdout, Op::Regex, "(")];
        let ctx = EvalContext {
            stdout: Some("anything".into()),
            ..Default::default()
        };
        let err = select_switch_branch("sw", &cases, &ctx).unwrap_err();
        match err {
            WorkflowError::ConditionEval(node, _) => assert_eq!(node, "sw"),
            other => panic!("expected ConditionEval, got {other:?}"),
        }
    }

    #[test]
    fn build_eval_context_maps_exit_and_stdout_tail() {
        // A finished node's exit code and stdout tail flow into the context the
        // switch evaluates against. Build a minimal NodeOutcome directly.
        let outcome = NodeOutcome {
            status: TerminalStatus::Finished,
            exit_code: Some(3),
            extracted: None,
            duration_ms: 1,
            output: None,
            stdout_tail: Some("2 passed, 1 failed\n".into()),
        };
        let ctx = build_eval_context(&outcome);
        assert_eq!(ctx.exit_code, Some(3));
        assert_eq!(ctx.stdout.as_deref(), Some("2 passed, 1 failed\n"));
        assert!(ctx.variables.is_empty());
    }

    // ---- §4 loop decisions -------------------------------------------------

    fn loop_count(count: u32, max: u32) -> LoopConfigRecord {
        LoopConfigRecord {
            count: Some(count),
            while_condition: None,
            max_iterations: max,
        }
    }

    fn loop_while(cond: Condition, max: u32) -> LoopConfigRecord {
        LoopConfigRecord {
            count: None,
            while_condition: Some(cond),
            max_iterations: max,
        }
    }

    #[test]
    fn loop_count_enters_body_until_count_reached() {
        let cfg = loop_count(3, 1000);
        let ctx = EvalContext::default();
        // completed 0,1,2 → body; 3 → done.
        assert_eq!(loop_should_continue("lp", &cfg, 0, &ctx), Ok(Branch::Body));
        assert_eq!(loop_should_continue("lp", &cfg, 2, &ctx), Ok(Branch::Body));
        assert_eq!(loop_should_continue("lp", &cfg, 3, &ctx), Ok(Branch::Done));
    }

    #[test]
    fn loop_while_enters_body_while_predicate_holds() {
        // Continue while variable `go` == "1".
        let cond = Condition {
            subject: Subject::Variable { name: "go".into() },
            op: Op::Eq,
            value: "1".into(),
        };
        let cfg = loop_while(cond, 1000);

        let mut yes = EvalContext::default();
        yes.variables.insert("go".into(), "1".into());
        assert_eq!(loop_should_continue("lp", &cfg, 0, &yes), Ok(Branch::Body));

        let mut no = EvalContext::default();
        no.variables.insert("go".into(), "0".into());
        assert_eq!(loop_should_continue("lp", &cfg, 5, &no), Ok(Branch::Done));
    }

    #[test]
    fn loop_limit_fires_before_mode_logic_even_for_while_true() {
        // A `while` that never becomes false must still be stopped by the hard
        // cap — and as a typed `LoopLimit`, not a silent `Done`.
        let cond = Condition {
            subject: Subject::Variable { name: "go".into() },
            op: Op::Eq,
            value: "1".into(),
        };
        let cfg = loop_while(cond, 10);
        let mut ctx = EvalContext::default();
        ctx.variables.insert("go".into(), "1".into());
        assert_eq!(
            loop_should_continue("lp", &cfg, 10, &ctx),
            Err(WorkflowError::LoopLimit("lp".into(), 10))
        );
    }

    #[test]
    fn loop_count_above_max_is_capped_by_loop_limit() {
        // A `count` larger than `max_iterations` cannot spin past the cap.
        let cfg = loop_count(100, 5);
        let ctx = EvalContext::default();
        assert_eq!(loop_should_continue("lp", &cfg, 4, &ctx), Ok(Branch::Body));
        assert_eq!(
            loop_should_continue("lp", &cfg, 5, &ctx),
            Err(WorkflowError::LoopLimit("lp".into(), 5))
        );
    }

    #[test]
    fn loop_misconfigured_when_neither_or_both_modes_set() {
        let ctx = EvalContext::default();
        let neither = LoopConfigRecord {
            count: None,
            while_condition: None,
            max_iterations: 10,
        };
        assert_eq!(
            loop_should_continue("lp", &neither, 0, &ctx),
            Err(WorkflowError::LoopMisconfigured("lp".into()))
        );
        let both = LoopConfigRecord {
            count: Some(3),
            while_condition: Some(Condition {
                subject: Subject::ExitCode,
                op: Op::Eq,
                value: "0".into(),
            }),
            max_iterations: 10,
        };
        assert_eq!(
            loop_should_continue("lp", &both, 0, &ctx),
            Err(WorkflowError::LoopMisconfigured("lp".into()))
        );
    }

    #[test]
    fn loop_branch_strings_render() {
        assert_eq!(Branch::Body.to_branch_string(), "body");
        assert_eq!(Branch::Done.to_branch_string(), "done");
    }

    // ---- §6 condition predicate -------------------------------------------

    #[test]
    fn condition_without_predicate_falls_back_to_exit_code() {
        // No predicate → MVP rule: exit 0 → then, non-zero → else.
        assert_eq!(
            select_condition_branch("c", None, &ctx_exit(Some(0))),
            Ok(Branch::Then)
        );
        assert_eq!(
            select_condition_branch("c", None, &ctx_exit(Some(1))),
            Ok(Branch::Else)
        );
    }

    #[test]
    fn condition_with_predicate_evaluates_it_over_exit_code() {
        // A stdout `contains` predicate overrides the exit-code default: even
        // with exit 0, a non-matching stdout takes `else`.
        let pred = Condition {
            subject: Subject::Stdout,
            op: Op::Contains,
            value: "OK".into(),
        };
        let mut hit = EvalContext {
            exit_code: Some(0),
            ..Default::default()
        };
        hit.stdout = Some("all OK here".into());
        assert_eq!(
            select_condition_branch("c", Some(&pred), &hit),
            Ok(Branch::Then)
        );

        let miss = EvalContext {
            exit_code: Some(0),
            stdout: Some("nope".into()),
            ..Default::default()
        };
        assert_eq!(
            select_condition_branch("c", Some(&pred), &miss),
            Ok(Branch::Else)
        );
    }

    #[test]
    fn condition_bad_regex_predicate_is_condition_eval_error() {
        let pred = Condition {
            subject: Subject::Stdout,
            op: Op::Regex,
            value: "(".into(),
        };
        let ctx = EvalContext {
            stdout: Some("x".into()),
            ..Default::default()
        };
        let err = select_condition_branch("cnode", Some(&pred), &ctx).unwrap_err();
        match err {
            WorkflowError::ConditionEval(node, _) => assert_eq!(node, "cnode"),
            other => panic!("expected ConditionEval, got {other:?}"),
        }
    }

    // ---- §6 data node ------------------------------------------------------

    #[test]
    fn expand_refs_substitutes_present_and_blanks_missing() {
        let mut vars = BTreeMap::new();
        vars.insert("name".into(), "world".into());
        assert_eq!(expand_refs("hi ${name}!", &vars), "hi world!");
        // Missing → empty.
        assert_eq!(expand_refs("[${absent}]", &vars), "[]");
        // `$$` is a literal `$`; a lone `$` survives.
        assert_eq!(expand_refs("cost $$5 ${name}", &vars), "cost $5 world");
        assert_eq!(expand_refs("price $ end", &vars), "price $ end");
    }

    #[test]
    fn expand_refs_preserves_multibyte_text() {
        let vars = BTreeMap::new();
        // Cyrillic + emoji around a (missing) ref must pass through intact.
        assert_eq!(expand_refs("Привет ${x}🚀", &vars), "Привет 🚀");
    }

    fn manual_assign(name: &str, value: &str) -> DataAssignmentRecord {
        DataAssignmentRecord {
            name: name.into(),
            value: value.into(),
            source: None,
        }
    }

    fn sourced_assign(name: &str, source: DataSourceRecord) -> DataAssignmentRecord {
        DataAssignmentRecord {
            name: name.into(),
            value: String::new(),
            source: Some(source),
        }
    }

    #[test]
    fn apply_data_assignments_manual_sets_and_chains() {
        // A legacy (source-less) record behaves as a manual `${ref}` template.
        let mut df = BTreeMap::new();
        df.insert("base".into(), "abc".into());
        let assigns = vec![
            manual_assign("greeting", "hello ${base}"),
            // A later assignment sees an earlier one in the same node.
            manual_assign("loud", "${greeting}!"),
        ];
        apply_data_assignments(&assigns, None, &mut df);
        assert_eq!(df.get("greeting").map(String::as_str), Some("hello abc"));
        assert_eq!(df.get("loud").map(String::as_str), Some("hello abc!"));
        assert_eq!(df.get("base").map(String::as_str), Some("abc"));
    }

    #[test]
    fn resolve_data_source_reads_previous_outcome() {
        let prev = PrevOutcome {
            stdout_tail: Some("the output\n".into()),
            exit_code: Some(3),
            fields: BTreeMap::from([("count".to_string(), "42".to_string())]),
            retry_count: Some(2),
            condition_result: Some(true),
            matched_case: Some("prod".into()),
            loop_iterations: Some(5),
        };
        let df = BTreeMap::new();
        let r = |s: DataSourceRecord| resolve_data_source(&s, Some(&prev), &df);
        assert_eq!(r(DataSourceRecord::RawOutput), "the output\n");
        assert_eq!(r(DataSourceRecord::ExitCode), "3");
        assert_eq!(
            r(DataSourceRecord::Field {
                field: "count".into()
            }),
            "42"
        );
        assert_eq!(r(DataSourceRecord::RetryCount), "2");
        assert_eq!(r(DataSourceRecord::ConditionResult), "true");
        assert_eq!(r(DataSourceRecord::MatchedCase), "prod");
        assert_eq!(r(DataSourceRecord::LoopIterations), "5");
    }

    #[test]
    fn resolve_data_source_schema_output_is_json_of_all_fields() {
        let prev = PrevOutcome {
            fields: BTreeMap::from([
                ("count".to_string(), "42".to_string()),
                ("name".to_string(), "build".to_string()),
            ]),
            ..Default::default()
        };
        let df = BTreeMap::new();
        // BTreeMap → deterministic, key-sorted compact JSON object.
        assert_eq!(
            resolve_data_source(&DataSourceRecord::SchemaOutput, Some(&prev), &df),
            r#"{"count":"42","name":"build"}"#
        );
        // No extracted fields (schema-less command) → empty, not "{}".
        let empty = PrevOutcome {
            exit_code: Some(0),
            ..Default::default()
        };
        assert_eq!(
            resolve_data_source(&DataSourceRecord::SchemaOutput, Some(&empty), &df),
            ""
        );
    }

    #[test]
    fn resolve_data_source_inapplicable_is_empty_not_error() {
        // No predecessor, or a source the prev outcome doesn't carry → empty.
        let df = BTreeMap::new();
        assert_eq!(
            resolve_data_source(&DataSourceRecord::ExitCode, None, &df),
            ""
        );
        let prev = PrevOutcome {
            exit_code: Some(0),
            ..Default::default()
        };
        // A plain command has no retry count → empty, not a crash.
        assert_eq!(
            resolve_data_source(&DataSourceRecord::RetryCount, Some(&prev), &df),
            ""
        );
        // A missing field → empty.
        assert_eq!(
            resolve_data_source(
                &DataSourceRecord::Field {
                    field: "nope".into()
                },
                Some(&prev),
                &df
            ),
            ""
        );
    }

    #[test]
    fn apply_data_assignments_pulls_from_sources() {
        let prev = PrevOutcome {
            exit_code: Some(7),
            stdout_tail: Some("hi".into()),
            ..Default::default()
        };
        let mut df = BTreeMap::new();
        let assigns = vec![
            sourced_assign("code", DataSourceRecord::ExitCode),
            sourced_assign("out", DataSourceRecord::RawOutput),
            manual_assign("greeting", "code=${code}"),
        ];
        apply_data_assignments(&assigns, Some(&prev), &mut df);
        assert_eq!(df.get("code").map(String::as_str), Some("7"));
        assert_eq!(df.get("out").map(String::as_str), Some("hi"));
        // Manual source sees an earlier sourced assignment via `${ref}`.
        assert_eq!(df.get("greeting").map(String::as_str), Some("code=7"));
    }

    #[test]
    fn data_source_record_wire_format_is_tagged_camelcase() {
        let json = serde_json::to_value(DataSourceRecord::RawOutput).unwrap();
        assert_eq!(json["kind"], "rawOutput");
        let json = serde_json::to_value(DataSourceRecord::Field { field: "x".into() }).unwrap();
        assert_eq!(json["kind"], "field");
        assert_eq!(json["field"], "x");
    }

    #[test]
    fn legacy_data_assignment_without_source_is_manual() {
        // A record persisted before `source` existed decodes with `source:
        // None` and its `effective_source` is the manual legacy value.
        let json = serde_json::json!({ "name": "v", "value": "hello" });
        let rec: DataAssignmentRecord = serde_json::from_value(json).unwrap();
        assert_eq!(rec.source, None);
        assert_eq!(
            rec.effective_source(),
            DataSourceRecord::Manual {
                value: "hello".into()
            }
        );
    }
}
