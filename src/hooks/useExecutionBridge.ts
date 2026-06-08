import { useEffect } from "react";
import i18n from "../i18n";
import { useCommandStore } from "../stores/commandStore";
import { useExecutionStore } from "../stores/executionStore";
import { useHistoryStore } from "../stores/historyStore";
import type { ExecutionEvent, RunStatus } from "../types";
import { getCommandName } from "../utils/commandLabels";
import { subscribeExecutionEvents } from "../utils/executor";
import { updateRunHistoryEventInDb } from "../utils/historyRepository";
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
  // Patch the in-memory History snapshot immediately so a row currently on
  // screen flips from "running" to its terminal status without waiting for a
  // reload. The History view is a load-once snapshot and does not subscribe
  // to execution events, so the DB write below alone would leave the badge
  // stuck on "running" until the next filter/page change.
  useHistoryStore.getState().applyRunCompletion(executionId, {
    status,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(timedOut !== undefined ? { timedOut } : {}),
  });
  void updateRunHistoryEventInDb(
    executionId,
    exitCode,
    durationMs,
    status,
    timedOut,
  ).catch((err: unknown) => {
    console.error("failed to update run history event", executionId, err);
  });
}

interface CommandInfo {
  name: string;
  script: string;
  shell?: string;
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
 */
function routeWorkflowNodeEvent(
  event: ExecutionEvent,
  workflowRunId: string,
): void {
  const store = useExecutionStore.getState();
  if (event.kind === "stdout") {
    store.appendLog(workflowRunId, {
      stream: "stdout",
      line: event.line,
      ts: Date.now(),
    });
    return;
  }
  if (event.kind === "stderr") {
    store.appendLog(workflowRunId, {
      stream: "stderr",
      line: event.line,
      ts: Date.now(),
    });
  }
  // started / finished / error / cancelled: no-op for the aggregate. The
  // workflow bridge handles run lifecycle + step headers.
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
