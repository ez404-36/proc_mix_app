// Thin wrapper over `miniappStore`, mirroring `commandActions` /
// `workflowActions`. UI / service code (notably the import orchestrator) goes
// through this facade rather than touching the store directly, so
// `src/services` stays free of direct store imports.
//
// `deleteMiniApp` records a `miniAppDeleted` history event carrying the full
// snapshot, so the History view can offer restore — mirroring
// `commandActions.deleteCommand` exactly. `createMiniApp` does not yet log a
// history event (no `miniAppCreated` kind exists), matching the previous
// behaviour.
//
// The helpers are plain functions (not hooks) so they can be invoked from
// anywhere — event handlers, effects, the import service, tests.

import { Message } from "@arco-design/web-react";
import i18n from "../i18n";
import { useMiniAppStore } from "../stores/miniappStore";
import type { HistoryEvent, MiniApp } from "../types";
import { recordHistoryEventInDb } from "../utils/historyRepository";

type NewMiniAppInput = Parameters<
  ReturnType<typeof useMiniAppStore.getState>["addMiniApp"]
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
 * user's action back — the delete has already happened in the mini-app
 * store, and reverting would surprise the user worse than missing a log row.
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
 * Persist a new mini-app via the store and return its materialised form
 * (with a generated id + timestamps). Returns the record so a caller (e.g. the
 * import flow) can track the old→new id mapping for command references.
 */
export function createMiniApp(input: NewMiniAppInput): MiniApp {
  return useMiniAppStore.getState().addMiniApp(input);
}

/**
 * Remove a mini-app via the store and log a `miniAppDeleted` event carrying
 * the full snapshot. The snapshot powers restore from the History view.
 *
 * Returns the removed snapshot, or `null` when the id was unknown (the store
 * delete is still issued — it's idempotent — but nothing is added to history
 * because there is no snapshot to record).
 */
export function deleteMiniApp(id: string): MiniApp | null {
  const removed = useMiniAppStore.getState().deleteMiniApp(id);
  if (removed === null) return null;
  safeRecord({
    id: makeId(),
    createdAt: nowIso(),
    kind: "miniAppDeleted",
    miniappId: removed.id,
    miniappName: removed.name,
    snapshotBefore: removed,
  });
  return removed;
}
