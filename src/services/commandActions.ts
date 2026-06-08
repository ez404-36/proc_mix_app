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
import type { Command, HistoryEvent } from "../types";
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
