// Run store — tracks runs fired from the web UI and backs the console (F6/F8).
//
// A run is registered on fire (`trackRun`), then the poller (api/runPoller)
// pushes status + captured-output snapshots via `updateRun` until terminal.
// The console (F8/F9) reads from here: the run list, the active selection, the
// panel open/position/size, and the rename/pin/clear actions. Read-only w.r.t.
// entities — this store only models the user's OWN runs this browser session.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { EntityKind, RunStatus, HistoryLogLine } from "../api/types";

/**
 * Run lifecycle status as seen by the web UI. Extends the server's
 * {@link RunStatus} with two client-only states:
 *  - `"pending"` — fired, not yet polled.
 *  - `"stale"`   — still `running` when the poll deadline elapsed; the poller
 *    gave up watching it. The run may still be going server-side — History is
 *    the source of truth for its final outcome.
 */
export type TrackedStatus = RunStatus | "pending" | "stale";

/** Where the console docks. Persisted (per-browser UI preference). */
export type ConsoleDockPosition = "bottom" | "left" | "right";

export interface TrackedRun {
  executionId: string;
  kind: EntityKind;
  name: string;
  /** User-assigned label shown in the recents strip instead of `name`. */
  customName?: string;
  /** Pinned runs sort ahead of unpinned and survive "clear terminated". */
  pinned?: boolean;
  status: TrackedStatus;
  /** Error code when the run could not be started (e.g. missingVariable). */
  error?: string;
  output?: HistoryLogLine[];
  exitCode?: number;
}

interface TrackRunInput {
  executionId: string;
  kind: EntityKind;
  name: string;
  error?: string;
}

interface RunState {
  /** Runs in this browser session, newest first. */
  runs: TrackedRun[];
  /** The run whose output the console body shows, or null. */
  activeId: string | null;
  /** Whether the console panel is open. Hidden by default; opened manually. */
  panelOpen: boolean;
  position: ConsoleDockPosition;
  panelHeight: number;
  panelWidth: number;

  trackRun: (input: TrackRunInput) => void;
  updateRun: (executionId: string, patch: Partial<TrackedRun>) => void;
  setActive: (executionId: string | null) => void;
  clearTerminated: () => void;
  clearOne: (executionId: string) => void;
  renameRun: (executionId: string, name: string) => void;
  setPinned: (executionId: string, pinned: boolean) => void;

  setPanelOpen: (open: boolean) => void;
  setPosition: (position: ConsoleDockPosition) => void;
  setPanelHeight: (height: number) => void;
  setPanelWidth: (width: number) => void;
}

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 800;
const MIN_WIDTH = 280;
const MAX_WIDTH = 900;
const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

function isTerminal(status: TrackedStatus): boolean {
  return status !== "pending" && status !== "running";
}

export const useRunStore = create<RunState>()(
  persist(
    (set) => ({
      runs: [],
      activeId: null,
      panelOpen: false,
      position: "bottom",
      panelHeight: 280,
      panelWidth: 420,

      trackRun: (input) =>
        set((s) => ({
          runs: [
            {
              executionId: input.executionId,
              kind: input.kind,
              name: input.name,
              status: input.error ? "failed" : "pending",
              error: input.error,
            },
            ...s.runs,
          ],
          // Auto-select the new run so opening the console shows it — but do
          // NOT auto-open the console (F8: opens only manually).
          activeId: input.executionId,
        })),

      updateRun: (executionId, patch) =>
        set((s) => ({
          runs: s.runs.map((r) =>
            r.executionId === executionId ? { ...r, ...patch } : r,
          ),
        })),

      setActive: (executionId) => set({ activeId: executionId }),

      clearTerminated: () =>
        set((s) => {
          const kept = s.runs.filter(
            (r) => r.pinned || !isTerminal(r.status),
          );
          const activeStillThere = kept.some(
            (r) => r.executionId === s.activeId,
          );
          return {
            runs: kept,
            activeId: activeStillThere ? s.activeId : (kept[0]?.executionId ?? null),
          };
        }),

      clearOne: (executionId) =>
        set((s) => {
          const kept = s.runs.filter((r) => r.executionId !== executionId);
          return {
            runs: kept,
            activeId:
              s.activeId === executionId
                ? (kept[0]?.executionId ?? null)
                : s.activeId,
          };
        }),

      renameRun: (executionId, name) =>
        set((s) => ({
          runs: s.runs.map((r) =>
            r.executionId === executionId
              ? { ...r, customName: name.trim() === "" ? undefined : name.trim() }
              : r,
          ),
        })),

      setPinned: (executionId, pinned) =>
        set((s) => ({
          runs: s.runs.map((r) =>
            r.executionId === executionId ? { ...r, pinned } : r,
          ),
        })),

      setPanelOpen: (open) => set({ panelOpen: open }),
      setPosition: (position) => set({ position }),
      setPanelHeight: (height) =>
        set({ panelHeight: clamp(height, MIN_HEIGHT, MAX_HEIGHT) }),
      setPanelWidth: (width) =>
        set({ panelWidth: clamp(width, MIN_WIDTH, MAX_WIDTH) }),
    }),
    {
      name: "procmix-web-console",
      // Persist only the UI layout preferences — runs are session state and
      // their executionIds are meaningless across reloads.
      partialize: (s) => ({
        position: s.position,
        panelHeight: s.panelHeight,
        panelWidth: s.panelWidth,
      }),
    },
  ),
);

// Re-export so existing imports (`RunStatus`) stay valid if referenced.
export type { RunStatus };
