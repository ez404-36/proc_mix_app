import { create } from "zustand";
import type { CaptureEvent } from "../types/capture";
import { redactSecrets } from "../utils/redactSecrets";

// Ephemeral in-memory store for the Process Capture "command recorder".
//
// CRITICAL (see `docs/process-capture.md`): the captured stream is NEVER
// persisted. It lives only here, in memory, and is wiped on stop/close.
// Only rows the user explicitly saves become Commands/Workflows, through
// the existing `commandActions`/`workflowActions` (Step 7) — this store
// never touches SQLite.
//
// Each incoming `CaptureEvent` becomes a `CaptureRow` with a stable local
// id (for React keys + selection) and a pre-redacted command line, so the
// UI never renders a raw secret. The raw value is intentionally NOT kept:
// redaction happens once, at ingest, and the unredacted string is dropped.

/** Hard cap on retained rows so a long recording can't grow unbounded. */
export const MAX_CAPTURE_ROWS = 500;

/**
 * A single captured process start, prepared for display. `commandLine` is
 * already redacted; the raw value is discarded at ingest and never stored.
 */
export interface CaptureRow {
  /** Stable local id for React keys and selection. */
  id: string;
  pid: number;
  ppid: number;
  image: string;
  /** Redacted command line — safe to display and to save. */
  commandLine: string;
  timestamp: string;
}

let rowSeq = 0;
function nextRowId(): string {
  rowSeq += 1;
  return `cap-${rowSeq}`;
}

interface CaptureState {
  /** Whether a recording session is currently active. */
  recording: boolean;
  /** Captured rows, newest last (append order). */
  rows: CaptureRow[];
  /** Ids of rows the user has ticked for saving. */
  selectedIds: Set<string>;

  setRecording: (recording: boolean) => void;
  /** Ingest a raw capture event: redact, assign an id, append (capped). */
  addEvent: (event: CaptureEvent) => void;
  toggleSelected: (id: string) => void;
  /** Select or clear every currently-present row. */
  setAllSelected: (selected: boolean) => void;
  /** Wipe rows + selection. Called on stop and on leaving the view. */
  clear: () => void;
}

export const useCaptureStore = create<CaptureState>()((set) => ({
  recording: false,
  rows: [],
  selectedIds: new Set<string>(),

  setRecording: (recording) => set({ recording }),

  addEvent: (event) =>
    set((state) => {
      const row: CaptureRow = {
        id: nextRowId(),
        pid: event.pid,
        ppid: event.ppid,
        image: event.image,
        commandLine: redactSecrets(event.commandLine),
        timestamp: event.timestamp,
      };
      const rows = [...state.rows, row];
      // Trim from the front when over the cap, dropping the selection for
      // any evicted rows so `selectedIds` cannot reference gone rows.
      if (rows.length > MAX_CAPTURE_ROWS) {
        const removed = rows.splice(0, rows.length - MAX_CAPTURE_ROWS);
        if (removed.some((r) => state.selectedIds.has(r.id))) {
          const selectedIds = new Set(state.selectedIds);
          for (const r of removed) selectedIds.delete(r.id);
          return { rows, selectedIds };
        }
      }
      return { rows };
    }),

  toggleSelected: (id) =>
    set((state) => {
      const selectedIds = new Set(state.selectedIds);
      if (selectedIds.has(id)) {
        selectedIds.delete(id);
      } else {
        selectedIds.add(id);
      }
      return { selectedIds };
    }),

  setAllSelected: (selected) =>
    set((state) => ({
      selectedIds: selected
        ? new Set(state.rows.map((r) => r.id))
        : new Set<string>(),
    })),

  clear: () => set({ rows: [], selectedIds: new Set<string>() }),
}));
