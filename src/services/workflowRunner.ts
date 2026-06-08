import { Message } from "@arco-design/web-react";
import i18n from "../i18n";
import { useCommandStore } from "../stores/commandStore";
import { useExecutionStore } from "../stores/executionStore";
import { useWorkflowRunStore } from "../stores/workflowRunStore";
import { useWorkflowStore } from "../stores/workflowStore";
import type { HistoryEvent, Workflow } from "../types";
import { recordHistoryEventInDb } from "../utils/historyRepository";
import { upsertCommandInDb } from "../utils/commandRepository";
import { resolveVariableValues } from "./commandRunner";
import {
  awaitWorkflowBridgeReady,
  executeWorkflow as invokeExecuteWorkflow,
} from "../utils/workflowRunner";

function makeHistoryEventId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `evt-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/**
 * Insert a `workflowRun(status=running)` row in history. We AWAIT the
 * insert so the row is guaranteed to exist by the time `useWorkflowBridge`
 * receives the terminal `workflowFinished` / `workflowCancelled` /
 * `workflowError` event and calls `updateRunHistoryEventInDb`. Without the
 * await, a fast workflow races the insert and the update finds no row,
 * leaving the entry stuck on `status: "running"` forever — the exact same
 * race `recordRunStart` guards against for command runs.
 */
async function recordWorkflowRunStart(
  runId: string,
  workflowId: string,
  workflowName: string,
): Promise<void> {
  const event: HistoryEvent = {
    id: makeHistoryEventId(),
    createdAt: new Date().toISOString(),
    kind: "workflowRun",
    workflowId,
    workflowName,
    executionId: runId,
    status: "running",
  };
  await recordHistoryEventInDb(event);
}

/**
 * Resolve and re-persist every command referenced by a `command` /
 * `condition` node BEFORE the run starts. The Rust engine resolves each
 * node's `commandId` against the `commands` SQLite table, so a referenced
 * command that has not yet been written through (an in-flight optimistic
 * upsert, or one whose write-through failed) would surface as an
 * `UnknownCommand` engine error. Re-issuing the upsert here — and AWAITING
 * it — closes that window deterministically.
 *
 * Returns `false` (and surfaces a toast) when a node references a command
 * id that does not exist in the store at all: that is a real
 * data-integrity problem the user must fix in the editor, not something to
 * paper over.
 */
async function ensureReferencedCommandsPersisted(
  workflow: Workflow,
): Promise<boolean> {
  const commands = useCommandStore.getState().commands;
  const byId = new Map(commands.map((c) => [c.id, c]));
  const referencedIds = new Set<string>();
  for (const node of workflow.nodes) {
    if (node.commandId !== undefined) {
      referencedIds.add(node.commandId);
    }
  }
  const missing: string[] = [];
  const upserts: Promise<void>[] = [];
  for (const id of referencedIds) {
    const cmd = byId.get(id);
    if (cmd === undefined) {
      missing.push(id);
      continue;
    }
    upserts.push(upsertCommandInDb(cmd));
  }
  if (missing.length > 0) {
    Message.error(
      i18n.t("workflow.missingCommand", {
        defaultValue:
          "This workflow references a command that no longer exists. Open it in the editor to fix the broken step.",
      }),
    );
    return false;
  }
  await Promise.all(upserts);
  return true;
}

/**
 * Sentinel result for {@link resolveNodeVariableValues}: `null` means the
 * user cancelled a variable prompt, so the whole run must be aborted.
 */
type NodeVariableValues = Record<string, Record<string, string>>;

/**
 * Resolve the variable values for every `command` / `condition` node that
 * references a command, REUSING `resolveVariableValues` from the
 * single-command run path — so spec defaults are merged and any variable
 * with no default opens the SAME interactive prompt the Library "Run"
 * uses. Workflow nodes previously ran with an empty value map and relied
 * solely on spec defaults, so a command with a no-default variable failed
 * the whole run (`missingVariable`). This collects the values up front.
 *
 * Returns a map keyed by node id (only nodes that resolved to a non-empty
 * value set are included; an all-defaulted command contributes nothing and
 * the engine falls back to its spec defaults). Returns `null` if the user
 * cancels ANY prompt — the caller then aborts the run without starting it,
 * mirroring `triggerCommandRun`'s cancel semantics.
 *
 * Two nodes referencing the SAME command id are resolved once and reused
 * (cached by command id) so the user is not prompted twice for an
 * identical command within a single run.
 */
async function resolveNodeVariableValues(
  workflow: Workflow,
): Promise<NodeVariableValues | null> {
  const commandsById = new Map(
    useCommandStore.getState().commands.map((c) => [c.id, c]),
  );
  const perCommandCache = new Map<string, Record<string, string>>();
  const result: NodeVariableValues = {};
  for (const node of workflow.nodes) {
    if (node.commandId === undefined) continue;
    const cmd = commandsById.get(node.commandId);
    // A missing command is already handled by
    // `ensureReferencedCommandsPersisted`; defensively skip here too.
    if (cmd === undefined) continue;
    let values = perCommandCache.get(node.commandId);
    if (values === undefined) {
      const resolved = await resolveVariableValues(cmd, {});
      if (resolved === null) {
        // User cancelled the prompt — abort the entire run.
        return null;
      }
      values = resolved;
      perCommandCache.set(node.commandId, values);
    }
    if (Object.keys(values).length > 0) {
      result[node.id] = values;
    }
  }
  return result;
}

/**
 * Trigger a workflow run. Ordering is load-bearing:
 *   1. Persist (re-upsert) every referenced command and AWAIT it, so the
 *      engine can resolve each node against SQLite. Abort with a toast if a
 *      node references a command that no longer exists.
 *   2. Resolve each node's variable values (defaults + interactive prompt
 *      for no-default specs), reusing `resolveVariableValues`. This MAY
 *      open modals, so it runs BEFORE any IPC — exactly like
 *      `triggerCommandRun`. Cancelling a prompt aborts the run quietly.
 *   3. AWAIT the workflow-event bridge so the Tauri-side listener is live
 *      before Rust emits the first `nodeStarted` — same gate rationale as
 *      `awaitBridgeReady` in `triggerCommandRun`.
 *   4. Invoke `execute_workflow` (passing the per-node variable values),
 *      then register the run in the progress store and bump the run count.
 *   5. Record the `workflowRun(running)` history row and AWAIT the insert
 *      so the terminal-event update in `useWorkflowBridge` cannot lose the
 *      race.
 *
 * Returns the run id, or `null` when the run could not be started (missing
 * command or IPC error → toast; cancelled variable prompt → quiet abort).
 */
export async function triggerWorkflowRun(
  workflow: Workflow,
): Promise<string | null> {
  const persisted = await ensureReferencedCommandsPersisted(workflow);
  if (!persisted) {
    return null;
  }

  // Collect per-node variable values BEFORE any IPC. This may open prompts;
  // a cancel returns null and aborts the run silently (no partial run, no
  // toast) — matching `triggerCommandRun`'s variable-cancel semantics.
  const nodeVariableValues = await resolveNodeVariableValues(workflow);
  if (nodeVariableValues === null) {
    return null;
  }

  try {
    await awaitWorkflowBridgeReady();
    const runId = await invokeExecuteWorkflow(workflow, nodeVariableValues);
    // Capture each node's command id from the (possibly unsaved) graph so the
    // console step headers can resolve command name + script regardless of
    // whether the workflow is persisted in `workflowStore`.
    const nodeCommandIds: Record<string, string> = {};
    for (const node of workflow.nodes) {
      if (node.commandId !== undefined) {
        nodeCommandIds[node.id] = node.commandId;
      }
    }
    useWorkflowRunStore.getState().startRun(runId, workflow.id, nodeCommandIds);
    useWorkflowStore.getState().markWorkflowRun(workflow.id);
    // Register the single aggregated terminal process for this run, keyed
    // by the run id. Every node's output (routed by `workflowRunId` in
    // `useExecutionBridge`) and the step headers (`useWorkflowBridge`) fold
    // into this one entry instead of N standalone executions. Opens the
    // OutputPanel immediately, mirroring `triggerCommandRun`.
    useExecutionStore.getState().startWorkflowExecution(runId, workflow.name);
    // AWAIT the history insert so the row exists before the bridge's
    // terminal-event handler tries to finalize it. A history-write failure
    // must NOT abort the user's run, so we catch and log rather than let it
    // propagate.
    try {
      await recordWorkflowRunStart(runId, workflow.id, workflow.name);
    } catch (histErr: unknown) {
      console.error("failed to record workflowRun history event", histErr);
    }
    return runId;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    Message.error(`Failed to run "${workflow.name}": ${message}`);
    return null;
  }
}
