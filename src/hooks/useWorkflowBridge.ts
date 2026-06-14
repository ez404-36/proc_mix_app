import { useEffect } from "react";
import i18n from "../i18n";
import { useCommandStore } from "../stores/commandStore";
import { useExecutionStore } from "../stores/executionStore";
import { useWorkflowRunStore } from "../stores/workflowRunStore";
import { useWorkflowStore } from "../stores/workflowStore";
import type { RunStatus, WorkflowEvent } from "../types";
import { getCommandName } from "../utils/commandLabels";
import { updateRunHistoryEventInDb } from "../utils/historyRepository";
import { subscribeWorkflowEvents } from "../utils/workflowRunner";

/**
 * Forward a terminal workflow event to the history layer so the
 * `workflowRun` row created by `triggerWorkflowRun` gets its final
 * `durationMs` / `status` (and, for finished runs, the exit code of the
 * last node) filled in. Fire-and-forget: an IPC failure (or a missing
 * history row — pruned by retention) must NOT block the bridge's normal
 * progress handling.
 *
 * `update_run_event` on the Rust side is keyed by run id and matches both
 * `commandRun` and `workflowRun` rows (generalised in Phase 1), so the
 * existing IPC wrapper is reused verbatim.
 */
function recordWorkflowRunCompletion(
  runId: string,
  exitCode: number | undefined,
  durationMs: number | undefined,
  status: RunStatus,
): void {
  void updateRunHistoryEventInDb(runId, exitCode, durationMs, status).catch(
    (err: unknown) => {
      console.error("failed to update workflow run history event", runId, err);
    },
  );
}

/**
 * Resolve the command a node runs, for the step header in the aggregated
 * process. The node→command map is captured on the run at `startRun`, so
 * this works even for an UNSAVED draft workflow that is absent from
 * `workflowStore`. Falls back to the persisted workflow graph (for runs
 * triggered elsewhere) and finally to nothing.
 */
function resolveStepCommandId(
  runId: string,
  workflowId: string,
  nodeId: string,
): string | undefined {
  const run = useWorkflowRunStore.getState().runs[runId];
  const fromRun = run?.nodeCommandIds[nodeId];
  if (fromRun !== undefined) return fromRun;
  const workflow = useWorkflowStore
    .getState()
    .workflows.find((w) => w.id === workflowId);
  return workflow?.nodes.find((n) => n.id === nodeId)?.commandId;
}

/**
 * Build the step-header `meta` lines for a node: the command's (localized)
 * NAME plus the actual SCRIPT that runs. Returns one line per entry so a
 * multi-line script stays readable in the console. Falls back to the node's
 * own label, then the bare node id, when no command is resolvable (e.g. a
 * node with no command set yet). Non-component context, so `i18n.t` is read
 * directly.
 */
function buildStepHeaderLines(
  runId: string,
  workflowId: string,
  nodeId: string,
): string[] {
  const commandId = resolveStepCommandId(runId, workflowId, nodeId);
  if (commandId !== undefined) {
    const cmd = useCommandStore
      .getState()
      .commands.find((c) => c.id === commandId);
    if (cmd) {
      const name = getCommandName(cmd, i18n.t);
      const lines = [i18n.t("outputPanel.workflowStep", { step: name })];
      const script = cmd.script.trim();
      if (script !== "") {
        lines.push(i18n.t("outputPanel.workflowStepScript", { script }));
      }
      return lines;
    }
  }
  const workflow = useWorkflowStore
    .getState()
    .workflows.find((w) => w.id === workflowId);
  const node = workflow?.nodes.find((n) => n.id === nodeId);
  const fallback =
    node?.label !== undefined && node.label.trim() !== "" ? node.label : nodeId;
  return [i18n.t("outputPanel.workflowStep", { step: fallback })];
}

function handleEvent(event: WorkflowEvent): void {
  const store = useWorkflowRunStore.getState();
  const exec = useExecutionStore.getState();
  switch (event.kind) {
    case "nodeStarted": {
      store.markNodeStarted(event.runId, event.nodeId, event.executionId);
      // Delimit this step in the aggregated workflow process with a header
      // (command name) followed by the actual script being run, so the user
      // can tell which command produced the following output and exactly what
      // it executed.
      for (const line of buildStepHeaderLines(
        event.runId,
        event.workflowId,
        event.nodeId,
      )) {
        exec.appendWorkflowStepHeader(event.runId, line);
      }
      return;
    }
    case "nodeFinished": {
      store.markNodeFinished(event.runId, event.nodeId, event.exitCode);
      // Trailing exit marker for the step. `exitCode` is null when the node
      // did not produce a concrete code (signal/cancel); show it as the
      // localized exit trailer only when present.
      if (event.exitCode !== null) {
        exec.appendWorkflowStepHeader(
          event.runId,
          i18n.t("outputPanel.workflowStepExit", { code: event.exitCode }),
        );
      }
      return;
    }
    case "branchTaken":
      store.markBranchTaken(
        event.runId,
        event.nodeId,
        event.branch,
        event.edgeId,
      );
      return;
    case "loopIteration":
      store.markLoopIteration(event.runId, event.nodeId, event.iteration);
      return;
    case "nodeRetry":
      store.markRetry(event.runId, event.nodeId, event.attempt);
      return;
    case "workflowFinished":
      store.finishRun(event.runId, "success", {
        durationMs: event.durationMs,
      });
      // Mirror the run's terminal status onto the aggregated process so the
      // OutputPanel shows the final state/duration for the whole workflow.
      exec.finishExecution(event.runId, {
        status: "success",
        durationMs: event.durationMs,
        finishedAt: Date.now(),
        error: undefined,
      });
      recordWorkflowRunCompletion(
        event.runId,
        undefined,
        event.durationMs,
        "succeeded",
      );
      return;
    case "workflowCancelled":
      store.finishRun(event.runId, "cancelled");
      exec.finishExecution(event.runId, {
        status: "cancelled",
        finishedAt: Date.now(),
        error: undefined,
      });
      recordWorkflowRunCompletion(event.runId, undefined, undefined, "cancelled");
      return;
    case "workflowError":
      store.finishRun(event.runId, "error", { error: event.message });
      exec.finishExecution(event.runId, {
        status: "error",
        finishedAt: Date.now(),
        error: event.message,
      });
      recordWorkflowRunCompletion(event.runId, undefined, undefined, "failed");
      return;
  }
}

export function useWorkflowBridge(): void {
  useEffect(() => {
    const unsubscribe = subscribeWorkflowEvents(handleEvent);
    return () => {
      unsubscribe();
    };
  }, []);
}
