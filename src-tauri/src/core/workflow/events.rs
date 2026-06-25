//! Graph-level progress events streamed on the `workflow-event` channel, plus
//! the small emit helpers the runner uses to push them (honouring a silent
//! run). The wire shape is locked by the tests at the bottom of this module.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

pub const WORKFLOW_EVENT: &str = "workflow-event";

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

pub(super) fn emit<R: Runtime>(app: &AppHandle<R>, event: &WorkflowEvent) {
    if let Err(err) = app.emit(WORKFLOW_EVENT, event) {
        eprintln!("failed to emit workflow event: {err}");
    }
}

/// Emit a `workflow-event` only when the run is NOT silent. A silent (planned
/// cron) fire suppresses every graph-level event; the run is recorded in
/// history instead of streaming to the live console.
pub(super) fn emit_unless_silent<R: Runtime>(
    app: &AppHandle<R>,
    silent: bool,
    event: &WorkflowEvent,
) {
    if !silent {
        emit(app, event);
    }
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
