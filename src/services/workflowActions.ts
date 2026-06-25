// Thin wrapper over `workflowStore` that records a matching history
// event after each user-initiated create / update / delete.
//
// UI code (the visual editor, Library) MUST call these helpers instead of
// touching the store directly so the history view always reflects what the
// user did. This mirrors `commandActions.ts` exactly.
//
// The helpers are pure functions (not hooks) so they can be invoked from
// anywhere — event handlers, effects, even outside React.

import { Message } from "@arco-design/web-react";
import i18n from "../i18n";
import { useCommandStore } from "../stores/commandStore";
import { useWorkflowStore } from "../stores/workflowStore";
import type { Command, HistoryEvent, Workflow } from "../types";
import { recordHistoryEventInDb } from "../utils/historyRepository";

type NewWorkflowInput = Parameters<
  ReturnType<typeof useWorkflowStore.getState>["addWorkflow"]
>[0];

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `evt-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/**
 * Persist the history event, surfacing failures as a toast but NEVER
 * propagating them to the caller. A failed history write must not roll the
 * user's action back — the create/edit/delete has already happened in the
 * workflow store, and reverting would surprise the user worse than missing
 * a log row.
 */
function safeRecord(event: HistoryEvent): void {
  void recordHistoryEventInDb(event).catch((err: unknown) => {
    console.error("failed to record history event", event.id, err);
    Message.error(
      i18n.t("history.recordFailed", {
        defaultValue: "Failed to record history entry",
      }),
    );
  });
}

/**
 * Create a new workflow via the store and log a `workflowCreated` event.
 * Returns the materialised workflow so the caller can navigate to it or
 * pre-select it in the editor.
 */
export function createWorkflow(input: NewWorkflowInput): Workflow {
  const created = useWorkflowStore.getState().addWorkflow(input);
  safeRecord({
    id: makeId(),
    createdAt: nowIso(),
    kind: "workflowCreated",
    workflowId: created.id,
    workflowName: created.name,
    snapshotAfter: created,
  });
  return created;
}

/**
 * Patch an existing workflow via the store and log a `workflowEdited`
 * event carrying BOTH the before and after snapshots. The before snapshot
 * is what powers undo from the History view.
 *
 * No-op (returns `null`) when the id is unknown.
 */
export function updateWorkflow(
  id: string,
  patch: Partial<Workflow>,
): { before: Workflow; after: Workflow } | null {
  const result = useWorkflowStore.getState().updateWorkflow(id, patch);
  if (result === null) return null;
  safeRecord({
    id: makeId(),
    createdAt: nowIso(),
    kind: "workflowEdited",
    workflowId: result.after.id,
    // Use the post-edit name so the history row shows what the workflow
    // looks like NOW; the snapshot still preserves the original for undo.
    workflowName: result.after.name,
    snapshotBefore: result.before,
    snapshotAfter: result.after,
  });
  return result;
}

/**
 * The set of API slugs currently in use by workflows in the live store.
 *
 * Exposed here (rather than letting callers read the store directly) so the
 * import orchestrator can detect a slug collision without `src/services/`
 * code reaching into `src/stores/` — store access stays behind this
 * sanctioned actions facade. Slugless workflows are skipped.
 */
export function existingWorkflowApiSlugs(): Set<string> {
  return new Set<string>(
    useWorkflowStore
      .getState()
      .workflows.map((w) => w.apiSlug)
      .filter((s): s is string => s !== undefined),
  );
}

/**
 * Remove a workflow via the store and log a `workflowDeleted` event
 * carrying the full snapshot. The snapshot powers restore from the History
 * view.
 *
 * Returns the removed snapshot, or `null` when the id was unknown.
 */
export function deleteWorkflow(id: string): Workflow | null {
  const removed = useWorkflowStore.getState().deleteWorkflow(id);
  if (removed === null) return null;
  // Cascade-delete the workflow's private `local` commands — they live with
  // the workflow, so they go with it. Capture their snapshots in the delete
  // event so a future restore can re-create them alongside the workflow.
  const localCommands: Command[] = useCommandStore
    .getState()
    .removeLocalCommandsForWorkflow(removed.id);
  safeRecord({
    id: makeId(),
    createdAt: nowIso(),
    kind: "workflowDeleted",
    workflowId: removed.id,
    workflowName: removed.name,
    snapshotBefore: removed,
    ...(localCommands.length > 0 ? { localCommands } : {}),
  });
  return removed;
}
