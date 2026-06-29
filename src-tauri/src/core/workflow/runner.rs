//! The execution state machine: spawning a command node through the sandboxed
//! executor, the shared command-bearing-node driver (with retries), the
//! recursive `traverse_path` walk, the `parallel` fork, and the public
//! `execute_workflow*` / `cancel_workflow` entry points plus the run-tracking
//! [`WorkflowExecutorState`].

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use tauri::{AppHandle, Runtime};
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::core::executor::{
    self, CapturedLine, CapturedStream, ExecuteRequest, ExecutorState, NodeOutcome, RunOptions,
    TerminalStatus,
};
use crate::core::workflow_condition::EvalContext;
use crate::storage::commands::CommandRecord;
use crate::storage::workflows::{RetryConfigRecord, WorkflowNodeRecord, WorkflowRecord};

use super::dataflow::{
    apply_data_assignments, apply_parser_node, apply_text_node, extracted_to_values,
    resolve_variable_values, PrevOutcome,
};
use super::eval::{
    build_eval_context, loop_should_continue, select_condition_branch, select_switch_branch,
};
use super::events::{emit_unless_silent, WorkflowEvent};
use super::graph::{edge_for_branch, edges_for_branch_multi, find_start, Branch, NodeKind};
use super::WorkflowError;

/// Hard cap on the number of nodes a single run may visit. Defends
/// against cycles in a malformed graph (the editor should prevent them,
/// but a hand-edited DB or a future bug must not hang the runner). A
/// well-formed MVP workflow is far smaller than this; exceeding it is
/// treated as a `Cycle` error.
const MAX_STEPS: usize = 10_000;

/// Per-run cancellation handle stored in [`WorkflowExecutorState`].
///
/// A `CancellationToken` (not a `oneshot::Sender`) so the single cancel signal
/// fans out to EVERY in-flight fork branch: each branch is spawned with a clone
/// of the run's token, and `cancel_workflow` calls `.cancel()` once to wake all
/// of them. The token is cancel-safe and idempotent, so a cancel for an
/// already-finished run is a harmless no-op.
struct WorkflowRunningEntry {
    cancel: CancellationToken,
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
    /// When `true`, each node's executor run buffers its stdout/stderr so the
    /// traversal can assemble an aggregate console log for history (used by a
    /// scheduled workflow fire). When `false` (the default streaming path) no
    /// per-node buffer is allocated — the live UI builds the aggregate from
    /// the per-node `execution-event`s instead.
    capture_output: bool,
}

/// Run a single command node: build the request, spawn it through the
/// executor with a completion channel, and await the terminal outcome
/// while concurrently watching the run's `cancel` token.
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
/// The `cancel` token is shared (cloned into every fork branch), so a
/// cancel from any source — the user, or a sibling branch failing
/// fast — kills this node's child too. The runner never holds a shared
/// lock across an await; it observes the token and calls `cancel_execution`
/// (which takes the executor lock briefly and releases it) as a normal call.
async fn run_command_node<R: Runtime>(
    app: &AppHandle<R>,
    executor_state: Arc<ExecutorState>,
    cmd: &CommandRecord,
    node_id: &str,
    ctx: RunContext<'_>,
    variable_values: BTreeMap<String, String>,
    cancel: &CancellationToken,
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

    // A workflow node mirrors a direct library run, but tags every
    // `execution-event` with the workflow run id so the frontend routes the
    // node's output into the aggregated workflow process instead of a
    // standalone terminal entry. A streaming run (live UI) builds the
    // aggregate console from those events and needs no per-node buffer; a
    // scheduled fire has no UI, so it asks each node to buffer its output and
    // the traversal assembles the aggregate log for history. A SILENT
    // (planned) fire also suppresses each node's `execution-event`s.
    let req = ExecuteRequest::for_command(
        cmd,
        RunOptions {
            execution_id: execution_id.clone(),
            variable_values,
            workflow_run_id: Some(ctx.run_id.to_string()),
            timeout_override: None,
            capture_output: ctx.capture_output,
            silent: ctx.silent,
        },
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
        _ = cancel.cancelled() => {
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

/// Append a command-bearing node's captured output to the run's aggregate
/// console log, prefixed by a `meta` step-header line (`▶ <command name>`)
/// so the persisted history reads like the live workflow console. A no-op
/// when capture is disabled (`acc` is `None`) or the node produced no buffer.
/// Each node's lines are ALREADY sensitive-redacted by the streaming reader,
/// so no secret lands here verbatim. The overall byte budget is bounded by
/// the executor's per-node capture caps plus the scheduler's
/// `MAX_HISTORY_OUTPUT_BYTES` truncation at persist time.
fn append_node_capture(
    acc: &mut Option<Vec<CapturedLine>>,
    command_name: &str,
    outcome: &NodeOutcome,
) {
    let Some(lines) = acc.as_mut() else {
        return;
    };
    lines.push(CapturedLine {
        stream: CapturedStream::Meta,
        line: format!("▶ {command_name}"),
    });
    if let Some(node_lines) = outcome.output.as_ref() {
        lines.extend(node_lines.iter().cloned());
    }
}

/// Sleep for `backoff_ms`, but abort early if the run is cancelled. Returns
/// `Err(Cancelled)` if the cancel signal fires during the pause so the retry
/// loop stops cleanly instead of waiting out a long backoff. A `0`/`None`
/// backoff is a no-op (immediate retry).
async fn cancellable_backoff(
    backoff_ms: Option<u64>,
    node_id: &str,
    cancel: &CancellationToken,
) -> Result<(), WorkflowError> {
    let ms = backoff_ms.unwrap_or(0);
    if ms == 0 {
        // Still observe an already-delivered cancel so a 0-backoff retry loop
        // can't ignore a cancel that arrived between attempts.
        return if cancel.is_cancelled() {
            Err(WorkflowError::Cancelled)
        } else {
            Ok(())
        };
    }
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(WorkflowError::Cancelled),
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
    vars: &BTreeMap<String, String>,
    prev: Option<&PrevOutcome>,
    ctx: RunContext<'_>,
    retry: Option<&RetryConfigRecord>,
    cancel: &CancellationToken,
    capture: &mut Option<Vec<CapturedLine>>,
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
        let values = resolve_variable_values(
            &node.variable_sources,
            node_variable_values.get(&node.id),
            prev,
            data_flow,
            vars,
        );
        let outcome = run_command_node(
            app,
            executor_state.clone(),
            cmd,
            &node.id,
            ctx,
            values,
            cancel,
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
        // extracted fields, fold its captured output into the run aggregate,
        // and return.
        let succeeded = outcome.exit_code == Some(0);
        if succeeded || attempt > max_retries {
            *data_flow = extracted_to_values(&outcome);
            append_node_capture(capture, &cmd.name, &outcome);
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
        cancellable_backoff(backoff_ms, &node.id, cancel).await?;
    }
}

/// Drive a workflow to completion. Internal core shared by the public
/// [`execute_workflow`]; separated so the traversal can return a
/// `Result` and the caller emits the single terminal event. `cancel_rx`
/// is selected against each node's completion so a cancel mid-run stops
/// traversal and tears down the in-flight node.
/// Where a traversal begins, and (for a node-scoped run) the input that node
/// is seeded with.
///
///   - `Start` → the normal whole-graph run: begin at the single `start` node
///     with an empty data-flow and no previous outcome.
///   - `Node { node_id, seed_input }` → a "run from this node" run: begin at
///     `node_id`, treating `seed_input` as the raw output of an imaginary
///     predecessor. The node and EVERY downstream node then execute exactly as
///     in a normal run, so downstream previews recompute. The seed represents
///     "whatever was in this node's input-example column" (a prior run's
///     capture, a manual sample, or nothing) — the engine does not care how it
///     was obtained.
enum TraverseStart {
    Start,
    Node {
        node_id: String,
        seed_input: Option<String>,
    },
}

/// Shared, read-only-after-setup state threaded through the recursive
/// [`traverse_path`] and cloned (cheaply — every field is an `Arc` or `Copy`)
/// into each concurrent fork branch spawned onto a [`JoinSet`].
///
/// Wrapping the graph / command tables in `Arc` is what makes a branch task
/// `'static`: it owns a clone of the context instead of borrowing the parent's
/// stack, so it can be spawned and outlive the `parallel` arm's frame.
struct TraverseCtx<R: Runtime> {
    app: AppHandle<R>,
    executor_state: Arc<ExecutorState>,
    workflow: Arc<WorkflowRecord>,
    commands: Arc<HashMap<String, CommandRecord>>,
    node_variable_values: Arc<HashMap<String, BTreeMap<String, String>>>,
    /// node id → index into `workflow.nodes`, precomputed once.
    node_index: Arc<HashMap<String, usize>>,
    run_id: String,
    silent: bool,
    /// `true` exactly when an aggregate console log is being assembled (a
    /// scheduled fire); threaded into each node's `RunContext`.
    capture_output: bool,
    /// Total steps across the WHOLE run (every branch shares it), so the cycle
    /// cap counts the sum of all paths rather than resetting per branch.
    steps: Arc<AtomicUsize>,
}

impl<R: Runtime> Clone for TraverseCtx<R> {
    fn clone(&self) -> Self {
        Self {
            app: self.app.clone(),
            executor_state: self.executor_state.clone(),
            workflow: self.workflow.clone(),
            commands: self.commands.clone(),
            node_variable_values: self.node_variable_values.clone(),
            node_index: self.node_index.clone(),
            run_id: self.run_id.clone(),
            silent: self.silent,
            capture_output: self.capture_output,
            steps: self.steps.clone(),
        }
    }
}

impl<R: Runtime> TraverseCtx<R> {
    fn run_context(&self) -> RunContext<'_> {
        RunContext {
            run_id: &self.run_id,
            workflow_id: &self.workflow.id,
            silent: self.silent,
            capture_output: self.capture_output,
        }
    }
}

/// What one spawned fork-branch task returns: its declaration index (for
/// ordered capture / log assembly), the branch sub-path's result, and its own
/// captured-log buffer (`None` on the streaming path).
type BranchResult = (u32, Result<(), WorkflowError>, Option<Vec<CapturedLine>>);

/// Per-path mutable state owned by one [`traverse_path`] frame. Each fork
/// branch gets its OWN `PathState` (a clone of the parent's `data_flow` /
/// `prev`, a SNAPSHOT of `vars`, and a fresh `loop_iterations`), so a branch's
/// data-flow, variable writes, and loop counters never race a sibling's.
struct PathState {
    /// Data-flow carry: the most recent command/condition node's extracted
    /// fields, surfaced as `${name}` values for the next node.
    data_flow: BTreeMap<String, String>,
    /// Persistent named `data`-node variables. The top-level sequential path
    /// mutates this for the whole run; a fork branch receives a SNAPSHOT clone
    /// whose writes are isolated and discarded at the join (MVP rule R1).
    vars: BTreeMap<String, String>,
    /// Per-`loop`-node completed-iteration counts on THIS path. A loop nested
    /// inside a fork branch keeps its own counter (R3).
    loop_iterations: HashMap<String, u32>,
    /// The immediately-preceding node's outcome, or `None` before the first
    /// node / after a pure node that produces no outcome.
    prev: Option<PrevOutcome>,
}

#[allow(clippy::too_many_arguments)]
async fn traverse<R: Runtime>(
    app: &AppHandle<R>,
    executor_state: Arc<ExecutorState>,
    workflow: &WorkflowRecord,
    commands: &HashMap<String, CommandRecord>,
    node_variable_values: &HashMap<String, BTreeMap<String, String>>,
    run_id: &str,
    silent: bool,
    start: TraverseStart,
    cancel: CancellationToken,
    capture: &mut Option<Vec<CapturedLine>>,
) -> Result<(), WorkflowError> {
    let node_index: HashMap<String, usize> = workflow
        .nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.id.clone(), i))
        .collect();

    // Resolve the entry node and the initial `prev` from the start descriptor.
    // A node-scoped run seeds `prev.stdout_tail` with the node's input example
    // so its `rawOutput` / parser sources (and a downstream node's data-flow)
    // see the same bytes the editor showed.
    let (current, seeded_prev) = match &start {
        TraverseStart::Start => {
            let start_idx = find_start(&workflow.nodes)?;
            (workflow.nodes[start_idx].id.clone(), None)
        }
        TraverseStart::Node {
            node_id,
            seed_input,
        } => {
            if !node_index.contains_key(node_id) {
                return Err(WorkflowError::DanglingEdge(
                    "<start-node>".into(),
                    node_id.clone(),
                ));
            }
            let prev = seed_input.as_ref().map(|input| PrevOutcome {
                stdout_tail: Some(input.clone()),
                ..Default::default()
            });
            (node_id.clone(), prev)
        }
    };

    // Build the shared context. The graph / command tables are cloned ONCE into
    // `Arc`s here so concurrent branches can own a `'static` clone — sequential
    // runs pay a single clone of immutable data and nothing more.
    let ctx = TraverseCtx {
        app: app.clone(),
        executor_state,
        workflow: Arc::new(workflow.clone()),
        commands: Arc::new(commands.clone()),
        node_variable_values: Arc::new(node_variable_values.clone()),
        node_index: Arc::new(node_index),
        run_id: run_id.to_string(),
        silent,
        // Per-node buffering is on exactly when the caller wants an aggregate
        // log (a scheduled fire passes `Some(vec)`); the streaming UI passes
        // `None` and pays no buffering cost.
        capture_output: capture.is_some(),
        steps: Arc::new(AtomicUsize::new(0)),
    };

    let state = PathState {
        data_flow: BTreeMap::new(),
        vars: BTreeMap::new(),
        loop_iterations: HashMap::new(),
        prev: seeded_prev,
    };

    // The top-level path stops only at `end` (no bound join above it).
    traverse_path(&ctx, current, state, None, &cancel, capture).await
}

/// Walk ONE chain of the graph from `current` until it reaches an `end` node,
/// its bound join (`stop_at`), or an error — driving each node, picking the
/// next edge, and recursing into a [`JoinSet`] at every `parallel` fork.
///
/// `state` is OWNED so each fork branch has its own data-flow / vars / loop
/// counters. `stop_at` is the id of the `join` node this path must HALT BEFORE
/// (set for a fork branch bound to an explicit join); reaching it returns `Ok`
/// without executing the join — the parent fork frame continues past it.
///
/// Returns a boxed future because the function is recursive (a fork branch is
/// another `traverse_path`); an `async fn` calling itself would be an
/// infinitely-sized type.
fn traverse_path<'a, R: Runtime>(
    ctx: &'a TraverseCtx<R>,
    mut current: String,
    mut state: PathState,
    stop_at: Option<&'a str>,
    cancel: &'a CancellationToken,
    capture: &'a mut Option<Vec<CapturedLine>>,
) -> Pin<Box<dyn Future<Output = Result<(), WorkflowError>> + Send + 'a>> {
    Box::pin(async move {
        let workflow = &ctx.workflow;
        let run_ctx = ctx.run_context();

        loop {
            // Shared step cap across ALL branches of the run (R3).
            let n = ctx.steps.fetch_add(1, Ordering::Relaxed) + 1;
            if n > MAX_STEPS {
                return Err(WorkflowError::Cycle);
            }

            // A branch bound to a join stops the instant it reaches it, WITHOUT
            // executing the join — the parent frame resumes past it.
            if Some(current.as_str()) == stop_at {
                return Ok(());
            }

            let idx = *ctx
                .node_index
                .get(&current)
                .ok_or_else(|| WorkflowError::DanglingEdge("<internal>".into(), current.clone()))?;
            let node = &workflow.nodes[idx];
            let kind = NodeKind::parse(&node.kind).ok_or_else(|| {
                WorkflowError::UnknownNodeKind(node.id.clone(), node.kind.clone())
            })?;

            let next_branch: Branch = match kind {
                NodeKind::End => {
                    // A bound fork branch (`stop_at.is_some()`) MUST converge at
                    // its join — the only legitimate Ok finish is the
                    // `stop_at == current` early-return above. Reaching an `End`
                    // here means the branch dead-ended before the barrier; the
                    // join (and everything after it) would otherwise run despite
                    // the branch never arriving. That is a graph fault, not a
                    // silent success. An UNBOUND branch (`stop_at == None`) still
                    // legitimately ends at `End`.
                    if let Some(join_id) = stop_at {
                        return Err(WorkflowError::BranchEndedBeforeJoin(join_id.to_string()));
                    }
                    return Ok(());
                }
                NodeKind::Start => {
                    state.prev = None;
                    Branch::Out
                }
                NodeKind::Data => {
                    // A `data` node runs NO command: it derives data-flow
                    // variables from each assignment's source — reading the
                    // PREVIOUS node's outcome for non-manual sources — then
                    // continues on its single `out` edge. Pure and instant.
                    apply_data_assignments(
                        &node.data,
                        state.prev.as_ref(),
                        &state.data_flow,
                        &mut state.vars,
                    );
                    // A `data` node produces no result of its own — `prev` stays
                    // as the PREVIOUS node's outcome (it is transparent to the
                    // data-flow carry).
                    Branch::Out
                }
                NodeKind::Parser => {
                    // A `parser` node runs NO command: it re-parses the PREVIOUS
                    // node's raw output through its own output-schema pipeline,
                    // overwrites the data-flow with the extracted fields, and
                    // continues on its single `out` edge.
                    state.prev = Some(apply_parser_node(
                        node.parser.as_ref(),
                        state.prev.as_ref(),
                        &mut state.data_flow,
                    ));
                    Branch::Out
                }
                NodeKind::Text => {
                    // A `text` node runs NO command: it expands the `${var}`
                    // references in its template against the run's variables and
                    // makes the result this node's output.
                    state.prev = Some(apply_text_node(
                        node.text.as_deref(),
                        state.prev.as_ref(),
                        &state.data_flow,
                        &state.vars,
                    ));
                    Branch::Out
                }
                NodeKind::Command => {
                    let (outcome, _attempts) = run_command_bearing_node(
                        &ctx.app,
                        &ctx.executor_state,
                        &ctx.commands,
                        node,
                        &ctx.node_variable_values,
                        &mut state.data_flow,
                        &state.vars,
                        state.prev.as_ref(),
                        run_ctx,
                        None,
                        cancel,
                        capture,
                    )
                    .await?;
                    state.prev = Some(PrevOutcome::from_outcome(&outcome));
                    Branch::Out
                }
                NodeKind::Condition => {
                    // A `condition` node runs its OWN referenced command (the
                    // "test"), then branches: a `condition` predicate (if set)
                    // is evaluated against the outcome (`then`/`else`), else it
                    // falls back to the exit code (exit 0 → `then`).
                    let (outcome, _attempts) = run_command_bearing_node(
                        &ctx.app,
                        &ctx.executor_state,
                        &ctx.commands,
                        node,
                        &ctx.node_variable_values,
                        &mut state.data_flow,
                        &state.vars,
                        state.prev.as_ref(),
                        run_ctx,
                        None,
                        cancel,
                        capture,
                    )
                    .await?;
                    let eval_ctx = build_eval_context(&outcome);
                    let branch =
                        select_condition_branch(&node.id, node.condition.as_ref(), &eval_ctx)?;
                    let mut p = PrevOutcome::from_outcome(&outcome);
                    p.condition_result = Some(branch == Branch::Then);
                    state.prev = Some(p);
                    branch
                }
                NodeKind::Switch => {
                    // A `switch` node runs its referenced command as a test,
                    // then takes the first `case` whose predicate matches (in
                    // declaration order), or `default` when none match.
                    let (outcome, _attempts) = run_command_bearing_node(
                        &ctx.app,
                        &ctx.executor_state,
                        &ctx.commands,
                        node,
                        &ctx.node_variable_values,
                        &mut state.data_flow,
                        &state.vars,
                        state.prev.as_ref(),
                        run_ctx,
                        None,
                        cancel,
                        capture,
                    )
                    .await?;
                    let eval_ctx = build_eval_context(&outcome);
                    let branch = select_switch_branch(&node.id, &node.cases, &eval_ctx)?;
                    let mut p = PrevOutcome::from_outcome(&outcome);
                    p.matched_case = Some(match &branch {
                        Branch::Case(id) => id.clone(),
                        _ => "default".to_string(),
                    });
                    state.prev = Some(p);
                    branch
                }
                NodeKind::Loop => {
                    // A `loop` node runs NO command of its own: it is a control
                    // point re-entered each time its body sub-graph flows back
                    // to it. It decides — from its config, the iterations
                    // already completed, and the current data-flow — whether to
                    // enter the body again (`body`) or finish (`done`).
                    let cfg = node
                        .loop_config
                        .as_ref()
                        .ok_or_else(|| WorkflowError::LoopMissingConfig(node.id.clone()))?;
                    let completed = *state.loop_iterations.get(&node.id).unwrap_or(&0);
                    let eval_ctx = EvalContext {
                        exit_code: None,
                        variables: state.data_flow.clone(),
                        stdout: None,
                    };
                    let branch = loop_should_continue(&node.id, cfg, completed, &eval_ctx)?;
                    if branch == Branch::Body {
                        // Entering the body: record the new (1-based) iteration
                        // and announce it. The loop node produces no outcome.
                        let iteration = completed + 1;
                        state.loop_iterations.insert(node.id.clone(), iteration);
                        emit_unless_silent(
                            &ctx.app,
                            ctx.silent,
                            &WorkflowEvent::LoopIteration {
                                run_id: ctx.run_id.clone(),
                                workflow_id: workflow.id.clone(),
                                node_id: node.id.clone(),
                                iteration,
                            },
                        );
                        state.prev = None;
                    } else {
                        // Leaving the loop: expose the completed-iteration count
                        // to a downstream `data` node, then clear the counter so
                        // a later re-entry (an outer loop) starts fresh.
                        state.prev = Some(PrevOutcome {
                            loop_iterations: Some(completed),
                            ..Default::default()
                        });
                        state.loop_iterations.remove(&node.id);
                    }
                    branch
                }
                NodeKind::Try => {
                    // A `try` node runs its referenced command with retries. The
                    // final attempt's exit code decides the exit: success → `ok`,
                    // failure after retries → `catch`.
                    let (outcome, attempts) = run_command_bearing_node(
                        &ctx.app,
                        &ctx.executor_state,
                        &ctx.commands,
                        node,
                        &ctx.node_variable_values,
                        &mut state.data_flow,
                        &state.vars,
                        state.prev.as_ref(),
                        run_ctx,
                        node.retry.as_ref(),
                        cancel,
                        capture,
                    )
                    .await?;
                    let branch = if outcome.exit_code == Some(0) {
                        Branch::Ok
                    } else {
                        Branch::Catch
                    };
                    let mut p = PrevOutcome::from_outcome(&outcome);
                    p.retry_count = Some(attempts);
                    state.prev = Some(p);
                    branch
                }
                NodeKind::Parallel => {
                    // Fork. Run each `branch:<n>` exit concurrently, then (if a
                    // join is bound) continue the PARENT path past the join.
                    return run_parallel(ctx, node, state, cancel, capture).await;
                }
                NodeKind::Join => {
                    // A `join` reached by the PARENT/sequential continuation (a
                    // branch bound to it stops BEFORE it via `stop_at`). It is a
                    // pass-through: continue on its single `out` edge. A join
                    // reached without a matching fork (e.g. top-level) behaves
                    // the same — there is nothing to synchronise, so it just
                    // forwards. (Data-flow was already reset by the fork frame
                    // when it resumed here.)
                    Branch::Out
                }
            };

            // Whether this node makes an explicit branch choice (condition /
            // switch / loop / try). Used to pick the right "no edge" error and
            // to decide whether to emit a `BranchTaken` event for the editor.
            let is_branching = matches!(
                kind,
                NodeKind::Condition | NodeKind::Switch | NodeKind::Loop | NodeKind::Try
            );
            let branch_label = next_branch.to_branch_string();

            let edge = edge_for_branch(&workflow.edges, &ctx.node_index, &node.id, &next_branch)?;
            let (edge_id, target) = match edge {
                Some(found) => found,
                None if matches!(kind, NodeKind::Switch) => {
                    return Err(WorkflowError::NoMatchingCase(node.id.clone()));
                }
                None if is_branching => {
                    return Err(WorkflowError::MissingBranch(node.id.clone(), branch_label));
                }
                None => {
                    return Err(WorkflowError::NoOutgoingEdge(node.id.clone()));
                }
            };

            if is_branching {
                emit_unless_silent(
                    &ctx.app,
                    ctx.silent,
                    &WorkflowEvent::BranchTaken {
                        run_id: ctx.run_id.clone(),
                        workflow_id: workflow.id.clone(),
                        node_id: node.id.clone(),
                        branch: branch_label,
                        edge_id,
                    },
                );
            }

            current = target;
        }
    })
}

/// Execute a `parallel` (fork) node: fan out to its `branch:<n>` exits and run
/// each concurrently, then continue the parent path.
///
/// MVP semantics (Phase 0):
///   - 0 branches → [`WorkflowError::ParallelNoBranches`] (a misconfigured fork
///     can't silently dead-end).
///   - 1 branch → FAST PATH: traverse it inline on the SAME frame with the
///     current data-flow/prev/vars — the fork is transparent (no `JoinSet`).
///   - ≥2 branches → spawn one `traverse_path` per branch into a [`JoinSet`],
///     each with its OWN clone of `data_flow`/`prev`, a SNAPSHOT of `vars`, and
///     a CHILD cancellation token. Branch writes to `vars` are isolated and
///     discarded (R1).
///
/// Each branch's stop node is the bound `join_node_id` (if any): the branch
/// returns `Ok` the moment it reaches that join, WITHOUT executing it. If no
/// join is bound, each branch runs to its own `end`.
///
/// Fail-fast: the first branch error cancels the child token (aborting the
/// siblings' in-flight commands), drains the `JoinSet`, and returns that error.
/// A `JoinError` from an aborted task is mapped to `Cancelled`, not a fault.
///
/// After all branches succeed: if a join is bound, the PARENT path resumes from
/// the join node's single `out` edge with EMPTY data-flow and `prev = None`
/// (the approved "no merge" rule). If none is bound, this path is done.
async fn run_parallel<R: Runtime>(
    ctx: &TraverseCtx<R>,
    node: &WorkflowNodeRecord,
    state: PathState,
    cancel: &CancellationToken,
    capture: &mut Option<Vec<CapturedLine>>,
) -> Result<(), WorkflowError> {
    let branches = edges_for_branch_multi(&ctx.workflow.edges, &ctx.node_index, &node.id)?;
    if branches.is_empty() {
        return Err(WorkflowError::ParallelNoBranches(node.id.clone()));
    }

    let join_id = node.join_node_id.clone();

    // FAST PATH: a single branch is just a sequential edge — keep the current
    // frame, data-flow, prev, and vars (fork is transparent). No JoinSet.
    if branches.len() == 1 {
        let (_, _, target) = &branches[0];
        let stop = join_id.as_deref();
        traverse_path(ctx, target.clone(), state, stop, cancel, capture).await?;
        return continue_after_join(ctx, join_id.as_deref(), cancel, capture).await;
    }

    // ≥2 branches → true concurrency. Snapshot `vars` once; every branch reads
    // the SAME pre-fork values and its writes never escape (R1).
    let vars_snapshot = state.vars.clone();
    // A child token so a fail-fast `.cancel()` aborts ONLY this fork's branches
    // (and is also tripped by the parent token being cancelled).
    let child_cancel = cancel.child_token();

    // Capture (R5): give each branch its own buffer, collected in branch index
    // order after the JoinSet drains, so the aggregate log is reproducible. The
    // streaming path (capture == None) allocates nothing.
    let capturing = capture.is_some();

    let mut set: JoinSet<BranchResult> = JoinSet::new();
    for (n, _edge_id, target) in &branches {
        let branch_ctx = ctx.clone();
        let branch_state = PathState {
            data_flow: state.data_flow.clone(),
            vars: vars_snapshot.clone(),
            loop_iterations: HashMap::new(),
            prev: state.prev.clone(),
        };
        let branch_cancel = child_cancel.clone();
        let target = target.clone();
        let join_id = join_id.clone();
        let n = *n;
        set.spawn(async move {
            let mut branch_capture: Option<Vec<CapturedLine>> =
                if capturing { Some(Vec::new()) } else { None };
            let result = traverse_path(
                &branch_ctx,
                target,
                branch_state,
                join_id.as_deref(),
                &branch_cancel,
                &mut branch_capture,
            )
            .await;
            (n, result, branch_capture)
        });
    }

    // Collect outcomes; on the FIRST error, fail fast: cancel the child token to
    // abort siblings, drain the set, and return that error.
    let mut first_error: Option<WorkflowError> = None;
    let mut branch_logs: Vec<(u32, Vec<CapturedLine>)> = Vec::new();
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok((n, Ok(()), branch_capture)) => {
                if let Some(lines) = branch_capture {
                    branch_logs.push((n, lines));
                }
            }
            Ok((_n, Err(err), _)) => {
                if first_error.is_none() {
                    first_error = Some(err);
                    child_cancel.cancel();
                }
            }
            Err(_join_err) => {
                // A task panicked or was aborted by the fail-fast cancel. An
                // aborted sibling is expected once we've cancelled, so treat it
                // as a cancellation rather than a separate fault.
                if first_error.is_none() {
                    first_error = Some(WorkflowError::Cancelled);
                    child_cancel.cancel();
                }
            }
        }
    }

    if let Some(err) = first_error {
        return Err(err);
    }

    // All branches succeeded. Append their buffered logs to the parent capture
    // in branch INDEX order (R5) so the aggregate is reproducible regardless of
    // real-time interleaving.
    if let Some(parent) = capture.as_mut() {
        branch_logs.sort_by_key(|(n, _)| *n);
        for (_, lines) in branch_logs {
            parent.extend(lines);
        }
    }

    continue_after_join(ctx, join_id.as_deref(), cancel, capture).await
}

/// Resume the parent path AFTER a fork's branches have all completed. With a
/// bound join, traversal continues from the join node's single `out` edge with
/// EMPTY data-flow and `prev = None` (the approved no-merge MVP rule). Without a
/// join (`join_id == None`), each branch already ran to its own `end`, so this
/// path is finished.
async fn continue_after_join<R: Runtime>(
    ctx: &TraverseCtx<R>,
    join_id: Option<&str>,
    cancel: &CancellationToken,
    capture: &mut Option<Vec<CapturedLine>>,
) -> Result<(), WorkflowError> {
    let Some(join_id) = join_id else {
        return Ok(());
    };
    // Validate the bound join exists before continuing.
    if !ctx.node_index.contains_key(join_id) {
        return Err(WorkflowError::DanglingEdge(
            "<join>".into(),
            join_id.to_string(),
        ));
    }
    // Continue from the join with a fresh frame: empty data-flow, no prev, and a
    // fresh `vars` (branch vars were isolated and discarded). The `Join` arm of
    // `traverse_path` forwards it on its `out` edge.
    let state = PathState {
        data_flow: BTreeMap::new(),
        vars: BTreeMap::new(),
        loop_iterations: HashMap::new(),
        prev: None,
    };
    traverse_path(ctx, join_id.to_string(), state, None, cancel, capture).await
}

/// Terminal outcome of a workflow run driven to completion in-process by
/// [`execute_workflow_blocking`]. Carries the aggregate console log and the
/// final node's exit code so a headless caller (the scheduler) can persist a
/// `scheduledRun` history event with viewable output — the streaming UI path
/// does not need this because it assembles the same log from events.
#[derive(Debug, Default)]
pub struct WorkflowRunCapture {
    /// `true` when the run finished without a graph/command fault.
    pub succeeded: bool,
    /// `true` when the run was cancelled mid-flight (vs a genuine error).
    pub cancelled: bool,
    /// Aggregate, per-node-prefixed console log (already sensitive-redacted),
    /// or `None` when no command-bearing node produced output.
    pub output: Option<Vec<CapturedLine>>,
}

/// Drive a workflow to completion IN-PROCESS (awaiting the traversal) and
/// return its aggregate captured output. Unlike [`execute_workflow`] — which
/// spawns the traversal and returns immediately for the live UI — this awaits
/// the run so a caller can record the output in history. Always capturing.
///
/// `silent` controls whether the run ALSO streams to the live console:
///   - `true` (automatic cron / catch-up fire, HTTP API): headless, no
///     `workflow-event` / `execution-event` — the history record is the only
///     observable result.
///   - `false` (manual "Run now"): streams to the live console (the panel
///     opens, the marker appears, output scrolls in) AND captures the same
///     aggregate log for the `scheduledRun` history record. Streaming and
///     capturing are orthogonal in `traverse`, so a manual fire gets both.
///
/// A terminal `workflow-event` (finished / cancelled / error) is emitted on the
/// non-silent path so the frontend bridge finalises the run marker; the silent
/// path emits nothing.
///
/// Cancellation is registered exactly like the spawned path, so an in-flight
/// fire can still be cancelled via [`cancel_workflow`].
#[allow(clippy::too_many_arguments)]
pub async fn execute_workflow_blocking<R: Runtime>(
    app: AppHandle<R>,
    executor_state: Arc<ExecutorState>,
    state: Arc<WorkflowExecutorState>,
    workflow: WorkflowRecord,
    commands: HashMap<String, CommandRecord>,
    node_variable_values: HashMap<String, BTreeMap<String, String>>,
    silent: bool,
) -> WorkflowRunCapture {
    let run_id = uuid::Uuid::new_v4().to_string();
    let cancel = CancellationToken::new();

    {
        let mut running = state.running.lock().await;
        running.insert(
            run_id.clone(),
            WorkflowRunningEntry {
                cancel: cancel.clone(),
            },
        );
    }

    let started = Instant::now();
    // Capturing accumulator: its `Some`-ness turns on per-node buffering.
    let mut capture: Option<Vec<CapturedLine>> = Some(Vec::new());
    let result = traverse(
        &app,
        executor_state,
        &workflow,
        &commands,
        &node_variable_values,
        &run_id,
        silent,
        TraverseStart::Start,
        cancel,
        &mut capture,
    )
    .await;

    {
        let mut map = state.running.lock().await;
        map.remove(&run_id);
    }

    // Emit the terminal event so the live console (non-silent path) finalises
    // the run marker — mirroring `spawn_traversal`'s terminal emit. Silent
    // fires emit nothing.
    match &result {
        Ok(()) => emit_unless_silent(
            &app,
            silent,
            &WorkflowEvent::WorkflowFinished {
                run_id: run_id.clone(),
                workflow_id: workflow.id.clone(),
                duration_ms: started.elapsed().as_millis() as u64,
            },
        ),
        Err(WorkflowError::Cancelled) => emit_unless_silent(
            &app,
            silent,
            &WorkflowEvent::WorkflowCancelled {
                run_id: run_id.clone(),
                workflow_id: workflow.id.clone(),
            },
        ),
        Err(err) => emit_unless_silent(
            &app,
            silent,
            &WorkflowEvent::WorkflowError {
                run_id: run_id.clone(),
                workflow_id: workflow.id.clone(),
                message: err.to_string(),
            },
        ),
    }

    let output = capture.filter(|lines| !lines.is_empty());
    match result {
        Ok(()) => WorkflowRunCapture {
            succeeded: true,
            cancelled: false,
            output,
        },
        Err(WorkflowError::Cancelled) => WorkflowRunCapture {
            succeeded: false,
            cancelled: true,
            output,
        },
        Err(_) => WorkflowRunCapture {
            succeeded: false,
            cancelled: false,
            output,
        },
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
    spawn_traversal(
        app,
        executor_state,
        state,
        workflow,
        commands,
        node_variable_values,
        silent,
        TraverseStart::Start,
    )
    .await
}

/// Kick off a NODE-SCOPED run: execute `start_node_id` and every node
/// downstream of it, exactly as a normal run would for that sub-path. The
/// entry node is seeded with `seed_input` as the raw output of an imaginary
/// predecessor — i.e. whatever the editor showed in that node's "example
/// input" column (a prior run's capture, a manual sample, or `None` for an
/// empty input). Used by the editor's per-node "run" action so a node and all
/// its successors recompute their input/output previews without re-running the
/// upstream graph. Streams the same per-node `workflow-event`s as a full run
/// (never silent), so the canvas/inspector updates live. Returns the run id.
#[allow(clippy::too_many_arguments)]
pub async fn execute_workflow_from<R: Runtime>(
    app: AppHandle<R>,
    executor_state: Arc<ExecutorState>,
    state: Arc<WorkflowExecutorState>,
    workflow: WorkflowRecord,
    commands: HashMap<String, CommandRecord>,
    node_variable_values: HashMap<String, BTreeMap<String, String>>,
    start_node_id: String,
    seed_input: Option<String>,
) -> Result<String, String> {
    spawn_traversal(
        app,
        executor_state,
        state,
        workflow,
        commands,
        node_variable_values,
        // A node-scoped run is always a manual editor action → streams live.
        false,
        TraverseStart::Node {
            node_id: start_node_id,
            seed_input,
        },
    )
    .await
}

/// Shared spawn-and-emit core behind [`execute_workflow`] and
/// [`execute_workflow_from`]: register a cancel handle, spawn the traversal
/// from `start`, and emit the single terminal event when it ends. Returns the
/// `run_id` immediately (fire-and-return).
#[allow(clippy::too_many_arguments)]
async fn spawn_traversal<R: Runtime>(
    app: AppHandle<R>,
    executor_state: Arc<ExecutorState>,
    state: Arc<WorkflowExecutorState>,
    workflow: WorkflowRecord,
    commands: HashMap<String, CommandRecord>,
    node_variable_values: HashMap<String, BTreeMap<String, String>>,
    silent: bool,
    start: TraverseStart,
) -> Result<String, String> {
    let run_id = uuid::Uuid::new_v4().to_string();
    let cancel = CancellationToken::new();

    {
        let mut running = state.running.lock().await;
        running.insert(
            run_id.clone(),
            WorkflowRunningEntry {
                cancel: cancel.clone(),
            },
        );
    }

    let run_id_task = run_id.clone();
    let running_arc = state.running.clone();
    tokio::spawn(async move {
        let started = Instant::now();
        // The streaming (spawned) path never captures: the live UI assembles
        // the aggregate console from the per-node `execution-event`s. Pass a
        // `None` accumulator so no per-node buffer is allocated.
        let mut capture: Option<Vec<CapturedLine>> = None;
        let result = traverse(
            &app,
            executor_state,
            &workflow,
            &commands,
            &node_variable_values,
            &run_id_task,
            silent,
            start,
            cancel,
            &mut capture,
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
                    duration_ms: started.elapsed().as_millis() as u64,
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
    let map = state.running.lock().await;
    if let Some(entry) = map.get(&run_id) {
        // Idempotent: cancelling an already-cancelled token is a no-op, and the
        // single signal fans out to every in-flight fork branch holding a clone.
        entry.cancel.cancel();
    }
    Ok(())
}
