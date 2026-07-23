import { Message } from "@arco-design/web-react";
import i18n from "../i18n";
import { useCommandStore } from "../stores/commandStore";
import { useExecutionStore } from "../stores/executionStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useWorkflowRunStore } from "../stores/workflowRunStore";
import { useWorkflowStore } from "../stores/workflowStore";
import type { HistoryEvent, Workflow } from "../types";
import { recordHistoryEventInDb } from "../utils/historyRepository";
import { upsertCommandInDb } from "../utils/commandRepository";
import { promptForWorkingDir } from "../utils/workingDirPrompt";
import { resolveVariableValues } from "./commandRunner";
import {
  awaitWorkflowBridgeReady,
  executeWorkflow as invokeExecuteWorkflow,
  executeWorkflowFromNode as invokeExecuteWorkflowFromNode,
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
  // Cache the resolved values by a key that captures BOTH the command and the
  // node's per-variable source bindings, so two nodes that run the same
  // command with the SAME bindings are only prompted once, while two nodes
  // with DIFFERENT bindings are resolved (and prompted) independently.
  const cache = new Map<string, Record<string, string>>();
  const result: NodeVariableValues = {};
  for (const node of workflow.nodes) {
    if (node.commandId === undefined) continue;
    const cmd = commandsById.get(node.commandId);
    // A missing command is already handled by
    // `ensureReferencedCommandsPersisted`; defensively skip here too.
    if (cmd === undefined) continue;

    const sources = node.variableSources ?? {};
    // Pre-supply a value for every variable bound to a non-prompt source so
    // `resolveVariableValues` does NOT open the prompt for it:
    //   - `manual` → the literal the author typed (also re-applied by the
    //     engine, so it is authoritative either way).
    //   - any other non-`atRun` source (rawOutput / field / exitCode / …) →
    //     an empty placeholder; the engine OVERRIDES it from the predecessor
    //     at run time, so the value passed here is irrelevant — its only job
    //     is to suppress the prompt for a value the user did not choose to
    //     enter by hand.
    // A variable bound to `atRun` (or unbound) is left to prompt as before.
    const callerSupplied: Record<string, string> = {};
    for (const [name, source] of Object.entries(sources)) {
      if (source.kind === "atRun") continue;
      callerSupplied[name] =
        source.kind === "manual" ? source.value : "";
    }

    const cacheKey = `${node.commandId}\u0000${JSON.stringify(sources)}`;
    let values = cache.get(cacheKey);
    if (values === undefined) {
      const resolved = await resolveVariableValues(cmd, callerSupplied);
      if (resolved === null) {
        // User cancelled the prompt — abort the entire run.
        return null;
      }
      values = resolved;
      cache.set(cacheKey, values);
    }
    if (Object.keys(values).length > 0) {
      result[node.id] = values;
    }
  }
  return result;
}

/**
 * Sentinel result for {@link resolveNodeWorkingDirValues}: `null` means the
 * user cancelled a working-dir prompt, so the whole run must be aborted.
 */
type NodeWorkingDirValues = Record<string, string>;

/**
 * Resolve the working-directory value for every command-bearing node whose
 * `workingDirSource` is `{ kind: "atRun" }` — the workflow-node equivalent of
 * `Command.promptWorkingDir`'s single-command prompt. REUSES
 * `promptForWorkingDir` (the same modal `triggerCommandRun` opens), pre-filled
 * with the referenced command's own `workingDir`.
 *
 * Returns a map keyed by node id (only `atRun` nodes are included; every
 * other source — `manual` / `dataVar` / no override — is resolved entirely
 * backend-side and needs no frontend value). Returns `null` if the user
 * cancels ANY prompt, mirroring {@link resolveNodeVariableValues}'s cancel
 * semantics.
 *
 * Two nodes referencing the SAME command are resolved once and reused
 * (cached by command id) so the user is not prompted twice for an identical
 * command's directory within a single run.
 */
async function resolveNodeWorkingDirValues(
  workflow: Workflow,
): Promise<NodeWorkingDirValues | null> {
  const commandsById = new Map(
    useCommandStore.getState().commands.map((c) => [c.id, c]),
  );
  const cache = new Map<string, string>();
  const result: NodeWorkingDirValues = {};
  for (const node of workflow.nodes) {
    if (node.commandId === undefined) continue;
    if (node.workingDirSource?.kind !== "atRun") continue;
    const cmd = commandsById.get(node.commandId);
    if (cmd === undefined) continue;

    let value = cache.get(node.commandId);
    if (value === undefined) {
      const prompted = await promptForWorkingDir(cmd.workingDir ?? "");
      if (prompted === null) {
        // User cancelled the prompt — abort the entire run.
        return null;
      }
      value = prompted;
      cache.set(node.commandId, value);
    }
    if (value !== "") {
      result[node.id] = value;
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
 *   3. Resolve each node's `atRun` working-directory value the same way
 *      (reusing `promptForWorkingDir`). Also runs before any IPC; a cancel
 *      aborts the run quietly just like the variable-prompt cancel.
 *   4. AWAIT the workflow-event bridge so the Tauri-side listener is live
 *      before Rust emits the first `nodeStarted` — same gate rationale as
 *      `awaitBridgeReady` in `triggerCommandRun`.
 *   5. Invoke `execute_workflow` (passing the per-node variable AND
 *      working-dir values), then register the run in the progress store and
 *      bump the run count.
 *   6. Record the `workflowRun(running)` history row and AWAIT the insert
 *      so the terminal-event update in `useWorkflowBridge` cannot lose the
 *      race.
 *
 * Returns the run id, or `null` when the run could not be started (missing
 * command or IPC error → toast; cancelled variable/working-dir prompt →
 * quiet abort).
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

  const nodeWorkingDirValues = await resolveNodeWorkingDirValues(workflow);
  if (nodeWorkingDirValues === null) {
    return null;
  }

  try {
    await awaitWorkflowBridgeReady();
    const runId = await invokeExecuteWorkflow(
      workflow,
      nodeVariableValues,
      nodeWorkingDirValues,
    );
    await registerStartedRun(workflow, runId);
    return runId;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    Message.error(`Failed to run "${workflow.name}": ${message}`);
    return null;
  }
}

/**
 * Register a just-started run with the progress store, execution console, and
 * history — the shared tail of {@link triggerWorkflowRun} and
 * {@link triggerWorkflowRunFromNode}. Captures each node's command id from the
 * (possibly unsaved) graph so console step headers can resolve a node's
 * command even when the workflow is a draft.
 */
async function registerStartedRun(
  workflow: Workflow,
  runId: string,
): Promise<void> {
  const nodeCommandIds: Record<string, string> = {};
  for (const node of workflow.nodes) {
    if (node.commandId !== undefined) {
      nodeCommandIds[node.id] = node.commandId;
    }
  }
  useWorkflowRunStore.getState().startRun(runId, workflow.id, nodeCommandIds);
  useWorkflowStore.getState().markWorkflowRun(workflow.id);
  // The single aggregated terminal process for this run; every node's output
  // folds into it (see triggerWorkflowRun for the full rationale).
  useExecutionStore
    .getState()
    .startWorkflowExecution(runId, workflow.name, workflow.id);
  // The console panel opens on the "Runs" tab regardless of which tab
  // (Runs or Terminal) was active before — switching to Terminal must not
  // hide a run's live output behind the interactive-terminal tab.
  useTerminalStore.getState().setPanelMode("runs");
  // AWAIT the history insert so the row exists before the bridge's terminal
  // event tries to finalize it. A history-write failure must not abort the run.
  try {
    await recordWorkflowRunStart(runId, workflow.id, workflow.name);
  } catch (histErr: unknown) {
    console.error("failed to record workflowRun history event", histErr);
  }
}

/**
 * Run a workflow STARTING FROM `startNodeId` — the editor's per-node "run"
 * action. Executes that node and every downstream node, seeding the entry
 * node's input with `seedInput` (its "example input": a prior run's capture, a
 * manual sample, or `null`/empty). Same ordering guarantees as
 * {@link triggerWorkflowRun} (persist commands → resolve variables → await
 * bridge → invoke → register). Downstream nodes recompute their previews from
 * the streamed per-node events.
 *
 * Returns the run id, or `null` (missing command / IPC error → toast;
 * cancelled variable prompt → quiet abort).
 */
export async function triggerWorkflowRunFromNode(
  workflow: Workflow,
  startNodeId: string,
  seedInput: string | null,
): Promise<string | null> {
  const persisted = await ensureReferencedCommandsPersisted(workflow);
  if (!persisted) {
    return null;
  }

  const nodeVariableValues = await resolveNodeVariableValues(workflow);
  if (nodeVariableValues === null) {
    return null;
  }

  const nodeWorkingDirValues = await resolveNodeWorkingDirValues(workflow);
  if (nodeWorkingDirValues === null) {
    return null;
  }

  try {
    await awaitWorkflowBridgeReady();
    const runId = await invokeExecuteWorkflowFromNode(
      workflow,
      nodeVariableValues,
      nodeWorkingDirValues,
      startNodeId,
      seedInput,
    );
    await registerStartedRun(workflow, runId);
    return runId;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    Message.error(`Failed to run "${workflow.name}": ${message}`);
    return null;
  }
}
