import { useEffect } from "react";
import i18n from "../i18n";
import { useCommandStore } from "../stores/commandStore";
import { useExecutionStore } from "../stores/executionStore";
import { useHistoryStore } from "../stores/historyStore";
import { useWorkflowRunStore } from "../stores/workflowRunStore";
import type { ExecutionEvent, RunStatus } from "../types";
import { getCommandName } from "../utils/commandLabels";
import { subscribeExecutionEvents } from "../utils/executor";
import {
  executionLogToHistoryOutput,
  updateRunHistoryEventInDb,
} from "../utils/historyRepository";
import { isTransient } from "../utils/transientExecutions";

/**
 * Forward a finished/cancelled/error event to the history layer so
 * the `commandRun` row created by `triggerCommandRun` gets its final
 * `exitCode` / `durationMs` / `status` filled in. Fire-and-forget:
 * an IPC failure (or a missing history row — pruned by retention)
 * must NOT block the executor's normal completion handling.
 *
 * `update_run_event` on the Rust side is a no-op when the row is not
 * found, so it's safe to call for transient executions too — but we
 * skip them anyway to avoid a pointless IPC round-trip on every
 * CommandForm live-run.
 */
function recordRunCompletion(
  executionId: string,
  exitCode: number | undefined,
  durationMs: number | undefined,
  status: RunStatus,
  timedOut?: boolean,
): void {
  if (isTransient(executionId)) return;
  // Capture the run's aggregate console output + structured result from the
  // execution store so they can be PERSISTED to history (the executionStore is
  // in-memory only and is cleared on app restart / "Clear"). The execution has
  // already received all stdout/stderr and the `result` event (which arrives
  // before the terminal event), so reading it here gives the full output.
  const execution = useExecutionStore.getState().executions[executionId];
  const output = execution
    ? executionLogToHistoryOutput(execution.log)
    : undefined;
  const result = execution?.result;
  // Patch the in-memory History snapshot immediately so a row currently on
  // screen flips from "running" to its terminal status (and becomes
  // expandable) without waiting for a reload. The History view is a load-once
  // snapshot and does not subscribe to execution events, so the DB write below
  // alone would leave the badge stuck on "running" until the next filter/page
  // change.
  useHistoryStore.getState().applyRunCompletion(executionId, {
    status,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(timedOut !== undefined ? { timedOut } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(result !== undefined ? { result } : {}),
  });
  void updateRunHistoryEventInDb(
    executionId,
    exitCode,
    durationMs,
    status,
    timedOut,
    output,
    result,
  ).catch((err: unknown) => {
    console.error("failed to update run history event", executionId, err);
  });
}

interface CommandInfo {
  name: string;
  script: string;
  shell?: string;
  target?: import("../types").ExecutionTarget;
}

function lookupCommandInfo(commandId: string | undefined): CommandInfo {
  if (!commandId) return { name: "Untitled command", script: "" };
  const cmd = useCommandStore
    .getState()
    .commands.find((c) => c.id === commandId);
  if (!cmd) return { name: "Untitled command", script: "" };
  // Resolve through the localization helper so seed commands appear in the
  // user's current language. Non-component context — read `i18n.t` directly.
  return {
    name: getCommandName(cmd, i18n.t),
    script: cmd.script,
    shell: cmd.shell,
    target: cmd.target,
  };
}

/**
 * Route a workflow node's `execution-event` into the single aggregated
 * workflow process keyed by `workflowRunId`. Only stdout/stderr produce
 * output lines; the node's own started/finished/error/cancelled events are
 * intentionally dropped here — the aggregated process's terminal status is
 * owned by `useWorkflowBridge` (driven by the graph-level `workflow-event`
 * channel), and step boundaries are written there as `meta` headers. We must
 * NOT call `startExecution`/`finishExecution` for the node's own
 * `executionId`, push it to recents, or steal the active panel: that is what
 * made workflow steps appear as N separate terminal processes.
 *
 * stdout/stderr are NOT appended to the aggregate immediately. In a parallel
 * fork every branch streams concurrently, so appending on arrival interleaves
 * all branches into one unreadable blob. Instead each line is BUFFERED against
 * its node (`bufferNodeLine`) and flushed as a contiguous block under the
 * node's step header when the node finishes — see `useWorkflowBridge`. The
 * per-node capture (`appendNodeOutputLine`, read by the editor's node modal)
 * is unaffected and still happens line-by-line.
 */
function routeWorkflowNodeEvent(
  event: ExecutionEvent,
  workflowRunId: string,
): void {
  const runStore = useWorkflowRunStore.getState();
  if (event.kind === "stdout") {
    // Buffer for grouped flush under this node's header (see useWorkflowBridge).
    runStore.bufferNodeLine(workflowRunId, event.executionId, {
      stream: "stdout",
      line: event.line,
      ts: Date.now(),
    });
    // ALSO capture the line against this specific node so the editor's node
    // modal can show that node's own output (the aggregate above mixes all
    // nodes together and is not addressable per node).
    runStore.appendNodeOutputLine(workflowRunId, event.executionId, event.line);
    return;
  }
  if (event.kind === "stderr") {
    runStore.bufferNodeLine(workflowRunId, event.executionId, {
      stream: "stderr",
      line: event.line,
      ts: Date.now(),
    });
    runStore.appendNodeOutputLine(workflowRunId, event.executionId, event.line);
    return;
  }
  if (event.kind === "result") {
    // The node's structured output-schema extraction. Dropped from the
    // aggregate console but kept per-node so a downstream node's "example
    // input" (and this node's "example result") can show the schema view.
    runStore.setNodeOutputResult(workflowRunId, event.executionId, {
      fields: event.fields,
      returnValue: event.returnValue,
      ...(event.error !== undefined ? { error: event.error } : {}),
    });
    return;
  }
  if (event.kind === "started") {
    // Record the RESOLVED working directory this node's command launched in
    // (an override / expanded `${var}` / prompt answer / home fallback — the
    // static `command.workingDir` can't show any of these). Keyed by execution
    // id; the step-header builder reads it at flush time. The aggregate's run
    // lifecycle stays owned by `useWorkflowBridge` — this only stashes data.
    runStore.setExecutionWorkingDir(
      workflowRunId,
      event.executionId,
      event.workingDir,
    );
    return;
  }
  // finished / error / cancelled: no-op for the aggregate. The workflow bridge
  // handles run lifecycle + step headers.
}

function handleEvent(event: ExecutionEvent): void {
  // Transient executions (e.g. the CommandForm live-run) bypass the global
  // execution store entirely. The fan-out in `subscribeExecutionEvents`
  // still delivers the event to the transient consumer's own handler;
  // skipping the store write here keeps live-runs out of Recent, the
  // OutputPanel, and the recent-ids list.
  if (isTransient(event.executionId)) return;
  // Workflow node output: fold into the aggregated workflow process instead
  // of creating a standalone execution. Deterministic — the Rust runner tags
  // every node event with the run id, so this does not depend on event
  // ordering between the execution-event and workflow-event channels.
  if (event.workflowRunId !== undefined) {
    routeWorkflowNodeEvent(event, event.workflowRunId);
    return;
  }
  const store = useExecutionStore.getState();
  switch (event.kind) {
    case "started": {
      const info = lookupCommandInfo(event.commandId);
      // Pass the resolved variables from the event so a backend-initiated
      // run (scheduler / workflow) shows them in the console like a direct
      // run. For a frontend-initiated run the execution is already
      // pre-registered with its variables; `startExecution` is idempotent
      // and keeps the existing list (`existing.variables ?? variables`), so
      // this never clobbers the richer pre-registered values.
      store.startExecution(
        event.executionId,
        event.commandId,
        info.name,
        info.script,
        info.shell,
        event.variables,
        undefined,
        undefined,
        info.target,
        event.workingDir,
      );
      return;
    }
    case "stdout": {
      store.appendLog(event.executionId, {
        stream: "stdout",
        line: event.line,
        ts: Date.now(),
      });
      return;
    }
    case "stderr": {
      store.appendLog(event.executionId, {
        stream: "stderr",
        line: event.line,
        ts: Date.now(),
      });
      return;
    }
    case "result": {
      // Structured extraction for a command with an output schema.
      // Arrives after all stdout/stderr and before `finished`, so the
      // execution already exists (the store stubs defensively otherwise).
      store.setExecutionResult(event.executionId, {
        fields: event.fields,
        returnValue: event.returnValue,
        ...(event.error !== undefined ? { error: event.error } : {}),
      });
      return;
    }
    case "finished": {
      const ok = event.exitCode === 0 && !event.timedOut;
      store.finishExecution(event.executionId, {
        status: ok ? "success" : "error",
        exitCode: event.exitCode,
        durationMs: event.durationMs,
        finishedAt: Date.now(),
        error: undefined,
        timedOut: event.timedOut,
      });
      // exitCode === 0 → succeeded; anything else → failed. The
      // history-side `RunStatus` mirrors that mapping.
      recordRunCompletion(
        event.executionId,
        // ExecutionEvent's exitCode is `number | null`; the history
        // wrapper takes `number | undefined`. `??` collapses null →
        // undefined; finished events almost always have a concrete
        // exit code, but a defensive collapse keeps the contract clean.
        event.exitCode ?? undefined,
        event.durationMs,
        ok ? "succeeded" : "failed",
        event.timedOut,
      );
      return;
    }
    case "error": {
      store.finishExecution(event.executionId, {
        status: "error",
        exitCode: null,
        durationMs: undefined,
        finishedAt: Date.now(),
        error: event.message,
      });
      recordRunCompletion(
        event.executionId,
        undefined,
        undefined,
        "failed",
      );
      return;
    }
    case "cancelled": {
      store.finishExecution(event.executionId, {
        status: "cancelled",
        exitCode: null,
        durationMs: undefined,
        finishedAt: Date.now(),
        error: undefined,
      });
      recordRunCompletion(
        event.executionId,
        undefined,
        undefined,
        "cancelled",
      );
      return;
    }
  }
}

export function useExecutionBridge(): void {
  useEffect(() => {
    const unsubscribe = subscribeExecutionEvents(handleEvent);
    return () => {
      unsubscribe();
    };
  }, []);
}
