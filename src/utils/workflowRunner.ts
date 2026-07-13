import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Workflow, WorkflowEvent } from "../types";
import { workflowToRecord } from "./workflowRepository";

/**
 * Kick off a workflow run. The Rust `execute_workflow` command takes the
 * full `WorkflowRecord` (same convention as `execute_command` /
 * `upsert_workflow`) so an unsaved edit can be run without a DB round-trip,
 * and resolves the referenced commands from storage itself. Returns the run
 * id; graph progress arrives on the `workflow-event` channel.
 *
 * `nodeVariableValues` maps a node id to the variable values the caller
 * resolved for that node's command (spec defaults merged with prompt
 * answers — see `triggerWorkflowRun`). The engine substitutes these
 * per-node and falls back to each spec's default for any unset variable.
 *
 * `nodeWorkingDirValues` mirrors it for the single working-directory value a
 * node's `atRun` `workingDirSource` prompt collected — see
 * `resolveNodeWorkingDirValues`. A node absent from the map falls back to no
 * override.
 *
 * IMPORTANT: the referenced commands must already be persisted to SQLite
 * before calling this — the engine resolves each node's `commandId` against
 * the `commands` table. `triggerWorkflowRun` owns that ordering guarantee
 * (and the variable resolution); this is the thin IPC wrapper.
 */
export async function executeWorkflow(
  workflow: Workflow,
  nodeVariableValues: Record<string, Record<string, string>>,
  nodeWorkingDirValues: Record<string, string>,
): Promise<string> {
  return invoke<string>("execute_workflow", {
    workflow: workflowToRecord(workflow),
    nodeVariableValues,
    nodeWorkingDirValues,
  });
}

/**
 * Run a workflow STARTING FROM `startNodeId`, executing that node and every
 * node downstream of it. `seedInput` is the entry node's "example input" —
 * whatever the editor showed in its left column (a prior run's capture, a
 * manual sample, or `null` for an empty input). Progress streams on the same
 * `workflow-event` channel as a full run, so the canvas/inspector recompute
 * downstream previews. Returns the run id.
 *
 * Same persistence/variable-resolution preconditions as {@link executeWorkflow}
 * — `triggerWorkflowRunFromNode` owns that ordering.
 */
export async function executeWorkflowFromNode(
  workflow: Workflow,
  nodeVariableValues: Record<string, Record<string, string>>,
  nodeWorkingDirValues: Record<string, string>,
  startNodeId: string,
  seedInput: string | null,
): Promise<string> {
  return invoke<string>("run_workflow_from_node", {
    workflow: workflowToRecord(workflow),
    nodeVariableValues,
    nodeWorkingDirValues,
    startNodeId,
    seedInput,
  });
}

export async function cancelWorkflow(runId: string): Promise<void> {
  await invoke("cancel_workflow", { runId });
}

/**
 * Module-level subscription state for the `workflow-event` channel. One
 * global `listen()` Promise is started the first time anyone imports this
 * module; all consumers register handlers into a shared Set, so the
 * Tauri-side listener is created exactly once and is live before any user
 * interaction can trigger a workflow run.
 *
 * This mirrors the execution-event bridge in `executor.ts` — see that file
 * for the full StrictMode-race rationale that motivated the
 * singleton-listener + handler-Set + synchronous-unsubscribe design.
 */
let unlistenPromise: Promise<UnlistenFn> | null = null;
const handlers = new Set<(e: WorkflowEvent) => void>();

function ensureSubscribed(): Promise<UnlistenFn> {
  if (unlistenPromise) {
    return unlistenPromise;
  }
  unlistenPromise = listen<WorkflowEvent>("workflow-event", (event) => {
    for (const h of handlers) h(event.payload);
  });
  unlistenPromise.catch((err) => {
    console.error("workflow-event listener failed to attach:", err);
  });
  return unlistenPromise;
}

// Start subscribing immediately when this module loads. The Promise is
// retained in `unlistenPromise`; we don't need its resolution here.
void ensureSubscribed();

/**
 * Register a handler for workflow events. Returns the unsubscribe function
 * synchronously — the handler is added to the in-memory Set immediately, and
 * the global Tauri listener (set up at module load) is the only thing that
 * needs to be awaited. Returning the unsub synchronously avoids the
 * StrictMode double-effect race; see `subscribeExecutionEvents` for the
 * detailed explanation this pattern is copied from.
 */
export function subscribeWorkflowEvents(
  handler: (e: WorkflowEvent) => void,
): () => void {
  handlers.add(handler);
  void ensureSubscribed();
  return () => {
    handlers.delete(handler);
  };
}

/**
 * Resolves once the global workflow-event listener is live on the Tauri
 * side. Callers should await this before invoking `execute_workflow`,
 * otherwise early `nodeStarted` events can be dropped.
 */
export async function awaitWorkflowBridgeReady(): Promise<void> {
  await ensureSubscribed();
}
