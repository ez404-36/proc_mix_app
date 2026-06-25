// Thin wrapper over `commandStore` that records a matching history
// event after each user-initiated create / update / delete.
//
// UI code (CommandForm, Library, Home, future visual editor) MUST call
// these helpers instead of touching the store directly so the history
// view always reflects what the user did. Seed bootstrap and tests
// continue to hit `useCommandStore.getState().addCommand` directly
// because we explicitly do NOT want to log seed entries as user
// actions.
//
// The helpers are pure functions (not hooks) so they can be invoked
// from anywhere — event handlers, effects, even outside React.

import { Message } from "@arco-design/web-react";
import i18n from "../i18n";
import { useCommandStore } from "../stores/commandStore";
import { useWorkflowStore } from "../stores/workflowStore";
import type { Command, HistoryEvent } from "../types";
import { isGlobalCommand } from "../utils/commandFilters";
import { recordHistoryEventInDb } from "../utils/historyRepository";

type NewCommandInput = Parameters<
  ReturnType<typeof useCommandStore.getState>["addCommand"]
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
 * propagating them to the caller. A failed history write must not
 * roll the user's action back — the create/edit/delete has already
 * happened in the command store, and reverting would surprise the
 * user worse than missing a log row.
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
 * Create a new command via the store and log a `commandCreated`
 * event. Returns the materialised command so the caller can navigate
 * to it or pre-select it in the UI.
 */
export function createCommand(input: NewCommandInput): Command {
  const created = useCommandStore.getState().addCommand(input);
  safeRecord({
    id: makeId(),
    createdAt: nowIso(),
    kind: "commandCreated",
    commandId: created.id,
    commandName: created.name,
    snapshotAfter: created,
  });
  return created;
}

/**
 * Duplicate an existing command: build a fresh `NewCommandInput` from the
 * source's user-authored fields, prefix its name (e.g. "(copy) …"), and
 * create it via {@link createCommand} so the copy is persisted AND logged
 * as a `commandCreated` event.
 *
 * Excluded from the copy:
 *   - identity/lifecycle fields (`id`, timestamps, `runCount`, `lastRunAt`)
 *     are stripped by the `NewCommandInput` shape / re-stamped by the store;
 *   - `nameKey`/`descriptionKey` (seed i18n keys) are never copied — the
 *     duplicate is a user command with literal `name`/`description`;
 *   - `favorite` is reset to `false` so a copy doesn't inherit the star.
 *
 * Scope IS preserved: duplicating a workflow-local command keeps it local to
 * the same `workflowId`. Returns the materialised copy so the caller can
 * navigate to its editor.
 */
export function duplicateCommand(
  source: Command,
  namePrefix: string,
): Command {
  const {
    id: _id,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    runCount: _runCount,
    lastRunAt: _lastRunAt,
    nameKey: _nameKey,
    descriptionKey: _descriptionKey,
    favorite: _favorite,
    name,
    ...rest
  } = source;
  return createCommand({
    ...rest,
    name: `${namePrefix}${name}`,
    favorite: false,
  });
}

/**
 * Patch an existing command via the store and log a `commandEdited`
 * event carrying BOTH the before and after snapshots. The before
 * snapshot is what powers undo from the History view.
 *
 * No-op (returns `null`) when the id is unknown; we still log nothing
 * in that case — there is nothing for history to capture.
 */
export function updateCommand(
  id: string,
  patch: Partial<Command>,
): { before: Command; after: Command } | null {
  const result = useCommandStore.getState().updateCommand(id, patch);
  if (result === null) return null;
  safeRecord({
    id: makeId(),
    createdAt: nowIso(),
    kind: "commandEdited",
    commandId: result.after.id,
    // Use the post-edit name so the history row shows what the
    // command looks like NOW; the snapshot still preserves the
    // original for undo.
    commandName: result.after.name,
    snapshotBefore: result.before,
    snapshotAfter: result.after,
  });
  return result;
}

/**
 * Remove a command via the store and log a `commandDeleted` event
 * carrying the full snapshot. The snapshot powers restore from the
 * History view.
 *
 * Returns the removed snapshot, or `null` when the id was unknown
 * (the store delete is still issued — it's idempotent — but nothing
 * is added to history because there is no snapshot to record).
 */
export function deleteCommand(id: string): Command | null {
  const removed = useCommandStore.getState().deleteCommand(id);
  if (removed === null) return null;
  safeRecord({
    id: makeId(),
    createdAt: nowIso(),
    kind: "commandDeleted",
    commandId: removed.id,
    commandName: removed.name,
    snapshotBefore: removed,
  });
  return removed;
}

/**
 * The set of API slugs currently in use by commands in the live store.
 *
 * Exposed here (rather than letting callers read the store directly) so the
 * import orchestrator can detect a slug collision without `src/services/`
 * code reaching into `src/stores/` — store access stays behind this
 * sanctioned actions facade. Slugless commands are skipped.
 */
export function existingCommandApiSlugs(): Set<string> {
  return new Set<string>(
    useCommandStore
      .getState()
      .commands.map((c) => c.apiSlug)
      .filter((s): s is string => s !== undefined),
  );
}

/**
 * Promote a workflow-LOCAL command to GLOBAL ("open global access"): clear
 * its `scope`/`workflowId` so it appears in the shared library and becomes
 * reusable from other workflows.
 *
 * Name-conflict policy: if another GLOBAL command already uses the same name,
 * the promoted command is renamed to `"<name> (<workflow name>)"` so the two
 * stay distinguishable in the library. The owning workflow's name is resolved
 * from the workflow store via the command's `workflowId`.
 *
 * Routes through {@link updateCommand}, so the change is logged as a
 * `commandEdited` event (undoable from History). Returns the
 * `{ before, after }` pair, or `null` when the id is unknown or the command
 * is already global.
 */
export function promoteCommandToGlobal(
  id: string,
): { before: Command; after: Command } | null {
  const commands = useCommandStore.getState().commands;
  const target = commands.find((c) => c.id === id);
  if (target === undefined || isGlobalCommand(target)) return null;

  // Detect a name clash against EXISTING global commands (exclude the target
  // itself). Comparison is case-insensitive on the literal name.
  const targetName = target.name.trim();
  const clashes = commands.some(
    (c) =>
      c.id !== target.id &&
      isGlobalCommand(c) &&
      c.name.trim().toLowerCase() === targetName.toLowerCase(),
  );

  let nextName = target.name;
  if (clashes) {
    const workflow = useWorkflowStore
      .getState()
      .workflows.find((w) => w.id === target.workflowId);
    const suffix = workflow?.name.trim();
    // Only append the parenthesised workflow name when we actually have one;
    // otherwise the rename would read "name ()".
    if (suffix !== undefined && suffix !== "") {
      nextName = `${target.name} (${suffix})`;
    }
  }

  return updateCommand(id, {
    scope: "global",
    workflowId: undefined,
    ...(nextName !== target.name ? { name: nextName } : {}),
  });
}
