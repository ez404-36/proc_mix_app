import { useEffect } from "react";
import i18n from "../i18n";
import { useCommandStore } from "../stores/commandStore";
import { useExecutionStore } from "../stores/executionStore";
import { useHistoryStore } from "../stores/historyStore";
import { useTerminalStore } from "../stores/terminalStore";
import {
  getExecutionWorkingDir,
  useWorkflowRunStore,
} from "../stores/workflowRunStore";
import { useWorkflowStore } from "../stores/workflowStore";
import type { RunStatus, WorkflowEvent } from "../types";
import { getCommandName } from "../utils/commandLabels";
import { branchSlotsByNode } from "../utils/workflowGraph";
import {
  executionLogToHistoryOutput,
  updateRunHistoryEventInDb,
} from "../utils/historyRepository";
import { subscribeWorkflowEvents } from "../utils/workflowRunner";

/**
 * Memoised per-run map of node id → 1-based parallel-branch slot, so a node's
 * step header can be prefixed with `(ветка N)` when it runs inside a fork. The
 * workflow graph is read once per run from `workflowStore` and cached for the
 * run's lifetime (cleared in {@link clearRunBranchSlots} on a terminal event).
 *
 * For an UNSAVED draft run the graph is absent from `workflowStore`; the lookup
 * then yields an empty map and every node gets a plain header — the deliberate
 * "fall back to no branch label rather than guess wrong" behaviour.
 */
const branchSlotsByRun = new Map<string, Record<string, number>>();

function branchSlotForNode(
  runId: string,
  workflowId: string,
  nodeId: string,
): number | undefined {
  let slots = branchSlotsByRun.get(runId);
  if (slots === undefined) {
    const workflow = useWorkflowStore
      .getState()
      .workflows.find((w) => w.id === workflowId);
    slots =
      workflow === undefined
        ? {}
        : branchSlotsByNode(workflow.nodes, workflow.edges);
    branchSlotsByRun.set(runId, slots);
  }
  return slots[nodeId];
}

function clearRunBranchSlots(runId: string): void {
  branchSlotsByRun.delete(runId);
}

/** Test-only: drop every cached branch-slot map so suites that reuse a run id
 *  across cases don't see a stale (e.g. empty) map from a prior test. */
export function __resetBranchSlotCacheForTests(): void {
  branchSlotsByRun.clear();
}

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
  // Capture the aggregate workflow console output (all node stdout/stderr +
  // step headers, keyed by the workflow runId in the execution store) so it
  // can be PERSISTED to history. The executionStore is in-memory only, so
  // without this the History view has nothing to show for a finished run.
  const execution = useExecutionStore.getState().executions[runId];
  const output = execution
    ? executionLogToHistoryOutput(execution.log)
    : undefined;
  // Patch the in-memory History snapshot immediately so a row on screen flips
  // to its terminal status and becomes expandable without a reload.
  useHistoryStore.getState().applyRunCompletion(runId, {
    status,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(output !== undefined ? { output } : {}),
  });
  void updateRunHistoryEventInDb(
    runId,
    exitCode,
    durationMs,
    status,
    undefined,
    output,
  ).catch((err: unknown) => {
    console.error("failed to update workflow run history event", runId, err);
  });
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
 * The RESOLVED working directory a node's command launched in, captured from
 * its `started` execution-event and stashed on the run by the execution
 * bridge (keyed by execution id). Resolves the node's execution id from its
 * run-state, then looks up the recorded dir. Returns `undefined` when the node
 * never started, or its dir was empty (home-dir fallback) — the caller then
 * falls back to the command's static `workingDir`.
 */
/**
 * One line of a step header for the aggregated workflow console, plus an
 * optional presentation `variant` (see {@link ExecutionLogLine}). Only the
 * working-directory line carries `variant: "workdir"` (accent-coloured).
 */
interface StepHeaderLine {
  text: string;
  variant?: "workdir";
}

function resolveStepWorkingDir(
  runId: string,
  nodeId: string,
): string | undefined {
  const run = useWorkflowRunStore.getState().runs[runId];
  const executionId = run?.nodes[nodeId]?.executionId;
  if (executionId === undefined) return undefined;
  return getExecutionWorkingDir(executionId);
}

/**
 * Render a step's TITLE line: `▸ <name>`, or `▸ (ветка N) <name>` when the
 * node runs inside a parallel fork (so the user can tell which branch the
 * following block belongs to). Centralises the branch-vs-plain choice.
 */
function stepTitleLine(step: string, branchSlot: number | undefined): string {
  return branchSlot === undefined
    ? i18n.t("outputPanel.workflowStep", { step })
    : i18n.t("outputPanel.workflowStepBranch", { n: branchSlot, step });
}

/**
 * Build the step-header `meta` lines for a node: the command's (localized)
 * NAME (prefixed with the branch slot when inside a fork) plus the actual
 * SCRIPT that runs. Returns one line per entry so a multi-line script stays
 * readable in the console. Falls back to the node's own label, then the bare
 * node id, when no command is resolvable (e.g. a node with no command set
 * yet). Non-component context, so `i18n.t` is read directly.
 */
function buildStepHeaderLines(
  runId: string,
  workflowId: string,
  nodeId: string,
): StepHeaderLine[] {
  const branchSlot = branchSlotForNode(runId, workflowId, nodeId);
  const commandId = resolveStepCommandId(runId, workflowId, nodeId);
  if (commandId !== undefined) {
    const cmd = useCommandStore
      .getState()
      .commands.find((c) => c.id === commandId);
    if (cmd) {
      const name = getCommandName(cmd, i18n.t);
      const lines: StepHeaderLine[] = [
        { text: stepTitleLine(name, branchSlot) },
      ];
      const shell = cmd.shell ?? i18n.t("outputPanel.defaultShell");
      // Prefer the RESOLVED directory the process actually launched in
      // (captured from the node's `started` event — reflects a node-level
      // `workingDirSource` override, an expanded `${var}`, a run-time prompt
      // answer, or the home-dir fallback). Fall back to the command's static
      // `workingDir` only when the resolved value isn't available yet (e.g. a
      // header flushed for a node that never emitted `started`).
      const dir = resolveStepWorkingDir(runId, nodeId) ?? cmd.workingDir?.trim();
      // Shell + working directory on ONE line, e.g. `(bash) /home/egor`, tagged
      // `workdir` so the OutputPanel renders the whole line in the accent
      // colour — matching a standalone command run's header exactly (shell and
      // dir together, both blue). Without a directory the plain `(bash)` line
      // stays muted like the other step headers.
      lines.push(
        dir !== undefined && dir !== ""
          ? {
              text: i18n.t("outputPanel.workflowStepShellDir", { shell, dir }),
              variant: "workdir",
            }
          : { text: i18n.t("outputPanel.workflowStepShell", { shell }) },
      );
      const script = cmd.script.trim();
      if (script !== "") {
        lines.push({
          text: i18n.t("outputPanel.workflowStepScript", { script }),
        });
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
  return [{ text: stepTitleLine(fallback, branchSlot) }];
}

/**
 * Flush a node's buffered output into the aggregated workflow process as one
 * contiguous block: the step HEADER first, then every buffered stdout/stderr
 * line in arrival order. Emitting the header HERE (at flush, not at
 * nodeStarted) is what keeps each node's header+body together — three parallel
 * branches no longer print three headers up-front before any output.
 *
 * The header is written UNCONDITIONALLY, even when the node produced no output,
 * so a silent step still appears in the console (matching the pre-grouping
 * behaviour where every started node got a header). The node's buffer (if any)
 * is removed via `takeNodeBuffer`, so a later run-end sweep skips an
 * already-flushed node.
 */
function flushNodeOutput(
  runId: string,
  workflowId: string,
  nodeId: string,
): void {
  const runStore = useWorkflowRunStore.getState();
  const buffered = runStore.takeNodeBuffer(runId, nodeId);
  const exec = useExecutionStore.getState();
  for (const headerLine of buildStepHeaderLines(runId, workflowId, nodeId)) {
    exec.appendWorkflowStepHeader(runId, headerLine.text, headerLine.variant);
  }
  for (const line of buffered) {
    exec.appendLog(runId, line);
  }
}

/**
 * At run end, flush any node buffers that never received an explicit
 * `nodeFinished` — e.g. a run that errored before a node completed, or
 * fail-fast aborting sibling branches mid-stream. Without this, those nodes'
 * partial output would be silently dropped. Each remaining node's block is
 * emitted (header + buffered lines); no exit trailer, since the node has no
 * exit code. `takeAllBuffers` clears the run's buffers so nothing lingers.
 */
function flushRemainingBuffers(runId: string, workflowId: string): void {
  const runStore = useWorkflowRunStore.getState();
  const exec = useExecutionStore.getState();
  for (const [nodeId, lines] of runStore.takeAllBuffers(runId)) {
    for (const headerLine of buildStepHeaderLines(runId, workflowId, nodeId)) {
      exec.appendWorkflowStepHeader(runId, headerLine.text, headerLine.variant);
    }
    for (const line of lines) {
      exec.appendLog(runId, line);
    }
  }
}

/**
 * Lazily register a run that was started OUTSIDE the frontend (a scheduler
 * "Run now", or any future backend-initiated workflow run). The normal
 * frontend Run path calls `registerStartedRun` (in `services/workflowRunner`)
 * with the in-memory graph BEFORE invoking, so the aggregate execution and the
 * run-store entry already exist by the time the first `workflow-event` arrives.
 * A backend-initiated run never does that, so without this bootstrap the first
 * event lands on a non-existent run/execution: `markNodeStarted` /
 * `bufferNodeLine` early-return, `startWorkflowExecution` is never called (the
 * panel never opens, no console marker), and `appendLog` /
 * `appendWorkflowStepHeader` no-op (empty output). This reproduced as the three
 * "manual schedule run" bugs.
 *
 * This bootstraps ONLY the in-memory stores (run store + aggregate console
 * execution), NOT a history row. A schedule fire is already recorded by the
 * Rust side as a single canonical `scheduledRun` event (the source of truth for
 * backend runs); inserting a `workflowRun` row here would produce a DUPLICATE
 * history entry. This mirrors the command path exactly: a schedule-fired
 * command never gets a frontend `commandRun` row either — `recordRunCompletion`
 * only UPDATES a pre-existing row (a no-op for backend runs), leaving the lone
 * `scheduledRun` record. The live console still shows the run; history shows the
 * single `scheduledRun` entry.
 *
 * Resolves the workflow's name and node→command map from `useWorkflowStore` by
 * `workflowId` (a saved workflow — the only kind a schedule can target — is
 * always loaded). Idempotent: when the run-store entry already exists it does
 * nothing, so a pre-registered frontend run is never touched and repeated
 * events for the same backend run register exactly once.
 *
 * Unlike `registerStartedRun` it does NOT bump the workflow's run count: that
 * stat belongs to the schedule accounting on the Rust side (a manual "Run now"
 * is explicitly out of band and must not shift the workflow's own counters).
 */
function ensureBackendRunRegistered(runId: string, workflowId: string): void {
  if (useWorkflowRunStore.getState().runs[runId] !== undefined) {
    return;
  }
  const workflow = useWorkflowStore
    .getState()
    .workflows.find((w) => w.id === workflowId);
  const nodeCommandIds: Record<string, string> = {};
  if (workflow) {
    for (const node of workflow.nodes) {
      if (node.commandId !== undefined) {
        nodeCommandIds[node.id] = node.commandId;
      }
    }
  }
  const name =
    workflow?.name ??
    i18n.t("outputPanel.workflowRunFallbackTitle", {
      defaultValue: "Workflow run",
    });
  useWorkflowRunStore.getState().startRun(runId, workflowId, nodeCommandIds);
  // The single aggregated terminal process for this run; opening the panel and
  // creating the pinnable console marker (bugs #1 and #2).
  useExecutionStore.getState().startWorkflowExecution(runId, name, workflowId);
  // The console panel opens on the "Runs" tab regardless of which tab (Runs
  // or Terminal) was active before — covers a backend-initiated workflow run
  // (scheduler "Run now") the same way `registerStartedRun` covers a
  // frontend-initiated one.
  useTerminalStore.getState().setPanelMode("runs");
}

function handleEvent(event: WorkflowEvent): void {
  // Lazily bootstrap a run started OUTSIDE the frontend (scheduler "Run now").
  // A frontend Run pre-registers before invoking, so an UNKNOWN run id reaching
  // here is always backend-initiated: register the in-memory stores now (run
  // store + aggregate console execution) so the panel opens, a marker is
  // created, and the events below land on a real execution instead of
  // no-opping. No history row is written — the Rust `scheduledRun` event is the
  // canonical record for a schedule fire (see `ensureBackendRunRegistered`).
  ensureBackendRunRegistered(event.runId, event.workflowId);
  const store = useWorkflowRunStore.getState();
  const exec = useExecutionStore.getState();
  switch (event.kind) {
    case "nodeStarted": {
      // Only record the node→execution mapping here. The step HEADER is NOT
      // written yet: in a parallel fork that would print every branch's header
      // up-front, before any output, since all branches start together. The
      // header is emitted at FLUSH time (nodeFinished) so each node's
      // header+body+exit stay contiguous — see `flushNodeOutput`.
      store.markNodeStarted(event.runId, event.nodeId, event.executionId);
      return;
    }
    case "nodeFinished": {
      store.markNodeFinished(event.runId, event.nodeId, event.exitCode);
      // Flush this node's grouped block now: header, then its buffered
      // stdout/stderr in arrival order, then the exit trailer — contiguous.
      flushNodeOutput(event.runId, event.workflowId, event.nodeId);
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
      // Flush any node buffers that never finished (defensive — a clean finish
      // normally flushes each node on nodeFinished) BEFORE finalizing, so the
      // aggregate log the history layer captures below is complete.
      flushRemainingBuffers(event.runId, event.workflowId);
      clearRunBranchSlots(event.runId);
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
      // Flush partial output of nodes aborted mid-stream so it isn't lost.
      flushRemainingBuffers(event.runId, event.workflowId);
      clearRunBranchSlots(event.runId);
      exec.finishExecution(event.runId, {
        status: "cancelled",
        finishedAt: Date.now(),
        error: undefined,
      });
      recordWorkflowRunCompletion(event.runId, undefined, undefined, "cancelled");
      return;
    case "workflowError":
      store.finishRun(event.runId, "error", { error: event.message });
      // Flush partial output of nodes that never finished (e.g. the failing
      // node, or fail-fast-aborted siblings) so it isn't silently dropped.
      flushRemainingBuffers(event.runId, event.workflowId);
      clearRunBranchSlots(event.runId);
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
