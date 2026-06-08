// Zustand store backing the "History" view.
//
// Responsibilities:
//   - Hold the current page of `HistoryEvent`s + total + page metadata
//     for the paginator and filter bar.
//   - Coordinate undo (edit) and restore (delete) flows by re-fetching
//     the source event's snapshot from SQLite, applying it to the
//     `commandStore`, and recording a follow-up `commandReverted` /
//     `commandRestored` entry.
//
// Filters and pagination ALWAYS hit the Rust layer through
// `historyRepository` — we never load the full table into memory.
// This is what scales the table to thousands of rows without UI lag.

import { Message } from "@arco-design/web-react";
import { create } from "zustand";
import i18n from "../i18n";
import type {
  Command,
  CommandDeletedEvent,
  CommandEditedEvent,
  HistoryEvent,
  HistoryEventKind,
  HistoryFilter,
  RunStatus,
} from "../types";
import {
  upsertCommandInDb,
} from "../utils/commandRepository";
import {
  clearHistoryInDb,
  deleteHistoryEventInDb,
  getHistoryEventFromDb,
  listHistoryFromDb,
  recordHistoryEventInDb,
} from "../utils/historyRepository";
import { useCommandStore } from "./commandStore";

/**
 * UI-facing filter state. Mirrors `HistoryFilter` exactly with the
 * exception that all fields use their default values rather than
 * `undefined`, so React-controlled inputs always have a concrete value.
 */
export interface HistoryStoreFilter {
  kinds: HistoryEventKind[];
  nameQuery: string;
  dateFrom?: string;
  dateTo?: string;
  failedOnly: boolean;
}

const EMPTY_FILTER: HistoryStoreFilter = {
  kinds: [],
  nameQuery: "",
  failedOnly: false,
};

/**
 * Terminal outcome applied to a `commandRun` / `workflowRun` row by
 * {@link HistoryState.applyRunCompletion}. Mirrors the fields the bridge
 * already passes to `updateRunHistoryEventInDb`.
 */
export interface RunCompletionPatch {
  status: RunStatus;
  exitCode?: number;
  durationMs?: number;
  timedOut?: boolean;
}

/** Fixed page size — matches the requirement of 10 items per page. */
export const HISTORY_PAGE_SIZE = 10;

interface HistoryState {
  items: HistoryEvent[];
  total: number;
  page: number;
  pageSize: number;
  filter: HistoryStoreFilter;
  loading: boolean;
  /**
   * Last error message surfaced by an IPC failure. Cleared on the next
   * successful `load`. Components that want to display the error use a
   * stable selector against this field — we don't surface every error
   * as a transient toast because the user can't always act on it.
   */
  error?: string;
  load: () => Promise<void>;
  setFilter: (patch: Partial<HistoryStoreFilter>) => void;
  resetFilter: () => void;
  setPage: (page: number) => void;
  /**
   * Patch the in-memory `commandRun` / `workflowRun` row whose
   * `executionId` matches, applying its terminal outcome. The History view
   * is a load-once snapshot (it does not subscribe to execution events), so
   * without this the SQLite row is updated on completion but the rendered
   * badge stays stuck on "running" until the next reload. Called by the
   * execution bridge after a successful `update_run_event`. A no-op when no
   * matching row is on the current page (it was pruned, filtered out, or
   * lives on another page — the next `load()` will reflect the DB value).
   */
  applyRunCompletion: (
    executionId: string,
    patch: RunCompletionPatch,
  ) => void;
  undoEdit: (eventId: string) => Promise<void>;
  restoreDeleted: (eventId: string) => Promise<void>;
  clearAll: () => Promise<void>;
}

/**
 * Convert the UI filter shape to the wire-format `HistoryFilter`.
 * Empty kinds → undefined (the Rust side treats absent and empty the
 * same way, but omitting the field shrinks the IPC payload). Empty
 * `nameQuery` → undefined for the same reason.
 */
function toWireFilter(f: HistoryStoreFilter): HistoryFilter {
  const wire: HistoryFilter = {};
  if (f.kinds.length > 0) wire.kinds = f.kinds;
  if (f.nameQuery.trim() !== "") wire.commandNameQuery = f.nameQuery.trim();
  if (f.dateFrom) wire.dateFrom = f.dateFrom;
  if (f.dateTo) wire.dateTo = f.dateTo;
  if (f.failedOnly) wire.failedOnly = true;
  return wire;
}

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
 * Update a single command in the in-memory `commandStore` AFTER the
 * snapshot has been persisted via `upsertCommandInDb`. We touch the
 * store directly because the existing `addCommand`/`updateCommand`
 * methods generate fresh timestamps / ids — we need the snapshot to
 * land verbatim so the user sees the exact pre-change state.
 */
function reapplySnapshotInStore(snapshot: Command): void {
  const state = useCommandStore.getState();
  const exists = state.commands.some((c) => c.id === snapshot.id);
  if (exists) {
    useCommandStore.setState((s) => ({
      commands: s.commands.map((c) => (c.id === snapshot.id ? snapshot : c)),
      favorites: snapshot.favorite
        ? [...new Set([...s.favorites, snapshot.id])]
        : s.favorites.filter((f) => f !== snapshot.id),
    }));
  } else {
    useCommandStore.setState((s) => ({
      commands: [...s.commands, snapshot],
      favorites: snapshot.favorite
        ? [...new Set([...s.favorites, snapshot.id])]
        : s.favorites,
    }));
  }
}

export const useHistoryStore = create<HistoryState>()((set, get) => ({
  items: [],
  total: 0,
  page: 1,
  pageSize: HISTORY_PAGE_SIZE,
  filter: EMPTY_FILTER,
  loading: false,
  error: undefined,
  load: async () => {
    const { filter, page, pageSize } = get();
    set({ loading: true, error: undefined });
    try {
      const result = await listHistoryFromDb(
        toWireFilter(filter),
        page,
        pageSize,
      );
      set({
        items: result.items,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        loading: false,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Don't toast here — `History.tsx` decides whether to render
      // the message inline or as a toast based on context.
      set({ loading: false, error: msg });
    }
  },
  setFilter: (patch) => {
    // Any filter change resets the page to 1; otherwise a filter that
    // shrinks the result set below the current page leaves the UI on
    // an empty page with no obvious way back.
    set((s) => ({ filter: { ...s.filter, ...patch }, page: 1 }));
    void get().load();
  },
  resetFilter: () => {
    set({ filter: EMPTY_FILTER, page: 1 });
    void get().load();
  },
  setPage: (page) => {
    const safe = Math.max(1, page);
    set({ page: safe });
    void get().load();
  },
  applyRunCompletion: (executionId, patch) => {
    set((s) => {
      let changed = false;
      const items = s.items.map((item) => {
        if (
          (item.kind === "commandRun" || item.kind === "workflowRun") &&
          item.executionId === executionId
        ) {
          changed = true;
          return {
            ...item,
            status: patch.status,
            // Only overwrite the optional outcome fields when the bridge
            // supplied them — `error`/`cancelled` terminals carry no exit
            // code or duration, and we must not clobber an existing value
            // with undefined.
            ...(patch.exitCode !== undefined
              ? { exitCode: patch.exitCode }
              : {}),
            ...(patch.durationMs !== undefined
              ? { durationMs: patch.durationMs }
              : {}),
            ...(patch.timedOut !== undefined
              ? { timedOut: patch.timedOut }
              : {}),
          };
        }
        return item;
      });
      // Avoid a pointless re-render (and a new array identity) when the
      // matching row isn't on the current page.
      return changed ? { items } : {};
    });
  },
  undoEdit: async (eventId) => {
    let source: HistoryEvent | null;
    try {
      source = await getHistoryEventFromDb(eventId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      Message.error(
        `${i18n.t("history.undoFailed", { defaultValue: "Undo failed" })}: ${msg}`,
      );
      return;
    }
    if (source === null || source.kind !== "commandEdited") {
      // The source event was pruned, cleared, or its kind changed
      // (shouldn't happen, but be defensive). Refresh the page so the
      // UI no longer offers undo on an event that can't fulfil it.
      Message.error(
        i18n.t("history.undoMissing", {
          defaultValue: "Original edit event is no longer available",
        }),
      );
      void get().load();
      return;
    }
    const ev: CommandEditedEvent = source;
    try {
      await upsertCommandInDb(ev.snapshotBefore);
      reapplySnapshotInStore(ev.snapshotBefore);
      // Record the revert as a fresh history event so the user has a
      // trail of "what was undone, when".
      const revert: HistoryEvent = {
        id: makeId(),
        createdAt: nowIso(),
        kind: "commandReverted",
        commandId: ev.commandId,
        commandName: ev.snapshotBefore.name,
        originalEventId: ev.id,
      };
      await recordHistoryEventInDb(revert);
      Message.success(
        i18n.t("history.undoSuccess", { defaultValue: "Edit reverted" }),
      );
      void get().load();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      Message.error(
        `${i18n.t("history.undoFailed", { defaultValue: "Undo failed" })}: ${msg}`,
      );
    }
  },
  restoreDeleted: async (eventId) => {
    let source: HistoryEvent | null;
    try {
      source = await getHistoryEventFromDb(eventId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      Message.error(
        `${i18n.t("history.restoreFailed", { defaultValue: "Restore failed" })}: ${msg}`,
      );
      return;
    }
    if (source === null || source.kind !== "commandDeleted") {
      Message.error(
        i18n.t("history.restoreMissing", {
          defaultValue: "Original delete event is no longer available",
        }),
      );
      void get().load();
      return;
    }
    const ev: CommandDeletedEvent = source;
    try {
      await upsertCommandInDb(ev.snapshotBefore);
      reapplySnapshotInStore(ev.snapshotBefore);
      const restore: HistoryEvent = {
        id: makeId(),
        createdAt: nowIso(),
        kind: "commandRestored",
        commandId: ev.commandId,
        commandName: ev.snapshotBefore.name,
        originalEventId: ev.id,
      };
      await recordHistoryEventInDb(restore);
      Message.success(
        i18n.t("history.restoreSuccess", {
          defaultValue: "Command restored",
        }),
      );
      void get().load();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      Message.error(
        `${i18n.t("history.restoreFailed", { defaultValue: "Restore failed" })}: ${msg}`,
      );
    }
  },
  clearAll: async () => {
    try {
      await clearHistoryInDb();
      set({ items: [], total: 0, page: 1 });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      Message.error(
        `${i18n.t("history.clearFailed", { defaultValue: "Failed to clear history" })}: ${msg}`,
      );
    }
  },
}));

/**
 * Convenience selector for "is the given command currently present in
 * the command store?". The History row uses this to decide whether to
 * show the Undo button (edit events: only when the command exists) and
 * the Restore button (delete events: only when the command does NOT
 * exist). Co-locating the selector here avoids duplicating the rule
 * across HistoryRow and tests.
 *
 * NOTE: this returns a function, not a selector hook — the caller
 * subscribes via `useCommandStore(...)` and runs this against the
 * current commands list. We avoid creating a fresh array reference per
 * render that way.
 */
export function selectCommandExists(
  commandId: string,
): (commands: Command[]) => boolean {
  return (commands) => commands.some((c) => c.id === commandId);
}

// Internal helpers exported for tests only — keeps the test file from
// duplicating the conversion logic.
export const __test__ = {
  toWireFilter,
  EMPTY_FILTER,
};

// Also delete a single event (used internally by tests; surfaces a
// thin wrapper around the repository for the rare "user removed one
// row from history" UX path. We don't expose it on `HistoryState`
// today — the row UI does not include a per-event delete button —
// but the repository function is already there if we need it.)
export async function deleteHistoryEventAndReload(id: string): Promise<void> {
  await deleteHistoryEventInDb(id);
  await useHistoryStore.getState().load();
}
