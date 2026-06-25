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
//
// The engine is split into focused submodules along its responsibility seams;
// this `mod.rs` owns the shared [`WorkflowError`] and re-exports the public
// API exactly as the original single-file module did:
//   - [`events`]   — `WorkflowEvent` wire DTO + emit helpers.
//   - [`graph`]    — node-kind parsing, start finding, edge selection.
//   - [`eval`]     — condition / switch / loop branch selection, `${ref}` expansion.
//   - [`dataflow`] — data-source resolution, assignments, parser / text nodes.
//   - [`runner`]   — the execution state machine, spawn, parallel fork, and the
//                    public `execute_workflow*` / `cancel_workflow` entry points.

mod dataflow;
mod eval;
mod events;
mod graph;
mod runner;

// Public API — re-exported so external callers (`commands/`, `scheduler.rs`,
// `http_server/handlers.rs`, and the integration tests) compile unchanged.
pub use events::{WorkflowEvent, WORKFLOW_EVENT};
pub use runner::{
    cancel_workflow, execute_workflow, execute_workflow_blocking, execute_workflow_from,
    WorkflowExecutorState, WorkflowRunCapture,
};

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
    #[error("parallel node {0} has no branch edges")]
    ParallelNoBranches(String),
    #[error("fork branch reached an end node before its bound join {0}")]
    BranchEndedBeforeJoin(String),
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
