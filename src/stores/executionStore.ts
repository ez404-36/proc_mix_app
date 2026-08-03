import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  Execution,
  ExecutionLogLine,
  ExecutionStatus,
  ExecutionVariable,
  ExtractedResult,
} from "../types";

const MAX_RECENT = 50;

/** Default docked-terminal height (px) — matches the previous `max-height: 50vh`
 *  feel on a ~900px viewport while giving a concrete starting size to resize
 *  from. */
export const DEFAULT_PANEL_HEIGHT = 360;
/** Lower bound: keeps the header + a few output lines visible. Mirrors the old
 *  `min-height: 220px`. */
export const MIN_PANEL_HEIGHT = 220;

/** Clamp a requested panel height to `[MIN_PANEL_HEIGHT, max]`, where `max`
 *  leaves a little of the app visible above the dock. `viewportHeight` is the
 *  window height the caller measured; falling back to a wide bound keeps the
 *  store pure/testable when no window is available. */
export function clampPanelHeight(
  requested: number,
  viewportHeight: number,
): number {
  const max = Math.max(MIN_PANEL_HEIGHT, viewportHeight - 80);
  return Math.min(Math.max(requested, MIN_PANEL_HEIGHT), max);
}

export type FinishPatch = Pick<
  Execution,
  "status" | "exitCode" | "durationMs" | "finishedAt" | "error" | "timedOut"
>;

export type ConsoleDockPosition = "bottom" | "left" | "right";

export const DEFAULT_PANEL_WIDTH = 420;
export const MIN_PANEL_WIDTH = 280;

export function clampPanelWidth(
  requested: number,
  viewportWidth: number,
): number {
  const max = Math.max(MIN_PANEL_WIDTH, viewportWidth - 200);
  return Math.min(Math.max(requested, MIN_PANEL_WIDTH), max);
}

interface ExecutionState {
  executions: Record<string, Execution>;
  recentIds: string[];
  activeExecutionId: string | null;
  panelOpen: boolean;
  /** Current docked-terminal height in px. Adjusted by dragging the panel's
   *  top resize handle; clamped via {@link clampPanelHeight}. */
  panelHeight: number;
  /** Current docked-terminal width in px (used for left/right dock). */
  panelWidth: number;
  /** Where the console panel is docked. */
  consolePosition: ConsoleDockPosition;

  startExecution: (
    id: string,
    commandId: string | undefined,
    commandName: string,
    script?: string,
    shell?: string,
    variables?: ExecutionVariable[],
    env?: Record<string, string>,
    variableValuesRaw?: Record<string, string>,
    target?: import("../types").ExecutionTarget,
    workingDir?: string,
    pid?: number,
  ) => void;
  /**
   * Create (or reuse) the single aggregated execution for a workflow run,
   * keyed by the workflow `runId`. Marks it `isWorkflow` so the panel cancels
   * the workflow and hides Re-run, opens the panel, and makes it active —
   * mirroring `startExecution`'s panel behavior. Idempotent on the same id.
   * `workflowId` is the source workflow's id, captured so the console can
   * offer "Repeat" on the finished aggregate.
   */
  startWorkflowExecution: (
    runId: string,
    title: string,
    workflowId?: string,
  ) => void;
  /**
   * Append an app-injected `meta` separator line (step header / exit
   * trailer) to the aggregated workflow execution. No-op if the execution
   * does not exist yet — the bridge always starts the run before appending.
   * `variant` optionally tags the line for special rendering (e.g.
   * `"workdir"` → the accent-coloured working-directory line).
   */
  appendWorkflowStepHeader: (
    runId: string,
    text: string,
    variant?: ExecutionLogLine["variant"],
  ) => void;
  appendLog: (id: string, line: ExecutionLogLine) => void;
  /**
   * Attach the structured output extraction to an execution, set when a
   * `result` execution event arrives (commands with an output schema).
   * Arrives BEFORE `finished`, so the execution always exists; a defensive
   * stub is created if not, to be merged by the later `started`/`finished`.
   */
  setExecutionResult: (id: string, result: ExtractedResult) => void;
  finishExecution: (id: string, patch: FinishPatch) => void;
  setActiveExecution: (id: string | null) => void;
  setPanelOpen: (open: boolean) => void;
  /** Set the docked-terminal height in px. The value is clamped to
   *  `[MIN_PANEL_HEIGHT, viewport - 80]` against the current window height. */
  setPanelHeight: (height: number) => void;
  /** Set the docked-terminal width in px (left/right dock). The value is
   *  clamped to `[MIN_PANEL_WIDTH, viewport - 200]`. */
  setPanelWidth: (width: number) => void;
  setConsolePosition: (position: ConsoleDockPosition) => void;
  clearExecution: (id: string) => void;
  clearAll: () => void;
  /** Set (or clear, with an empty string) the user-facing display name of a
   *  console run. No-op if the execution does not exist. */
  renameExecution: (id: string, name: string) => void;
  /** Pin or unpin a console run. Pinned runs survive Clear and reloads, and
   *  are kept ahead of unpinned runs in the recents order. */
  setPinned: (id: string, pinned: boolean) => void;
  /**
   * Re-order the recents strip: move `activeId` onto `overId`'s slot. The move
   * is constrained to a single pinned/unpinned partition — a drag that would
   * place an unpinned run ahead of a pinned one (or vice versa) is ignored.
   */
  reorderRecent: (activeId: string, overId: string) => void;
  /**
   * Clear every TERMINAL execution (success / error / cancelled),
   * keeping any that are still `running` (or `pending`) so an in-flight
   * process is never yanked out of the panel while it is still producing
   * output. Returns nothing; the panel decides whether to also close
   * based on whether anything remains. This backs the console "Clear"
   * button per the requirement "clear only finished/errored/cancelled".
   */
  clearTerminated: () => void;
}

/** Statuses considered "still in progress" — never cleared by
 *  {@link clearTerminated}. */
function isActiveStatus(status: ExecutionStatus): boolean {
  return status === "running" || status === "pending";
}

function setStatusIfMissing(
  current: Execution,
  patch: FinishPatch,
): ExecutionStatus {
  return patch.status ?? current.status;
}

/**
 * Prepend `id` to the recents order (a fresh / restarted run goes to the
 * front), de-duplicating and capping the list. A newly-started run is always
 * unpinned, so when pinned runs exist it is inserted at the FRONT of the
 * unpinned block rather than at absolute index 0 — preserving the
 * "pinned runs stay left" invariant. `pinnedCount` is the number of pinned
 * ids currently leading `recentIds` (0 when the caller hasn't computed it,
 * which keeps the old behaviour for the no-pins case).
 */
function pushRecent(
  recentIds: string[],
  id: string,
  pinnedCount = 0,
): string[] {
  const without = recentIds.filter((r) => r !== id);
  without.splice(pinnedCount, 0, id);
  return without.slice(0, MAX_RECENT);
}

/** Count pinned ids leading the recents order (after partitioning they are
 *  always the prefix). */
function leadingPinnedCount(
  recentIds: string[],
  executions: Record<string, Execution>,
): number {
  let count = 0;
  for (const id of recentIds) {
    if (executions[id]?.pinned) count += 1;
    else break;
  }
  return count;
}

/**
 * Re-order `recentIds` so every pinned run comes before every unpinned run,
 * keeping the relative order WITHIN each group stable. Pinned runs are shown
 * first (left) in the console recents strip; this is the invariant that
 * {@link ExecutionState.setPinned} and {@link ExecutionState.reorderRecent}
 * both maintain.
 */
function partitionByPinned(
  recentIds: string[],
  executions: Record<string, Execution>,
): string[] {
  const pinned: string[] = [];
  const rest: string[] = [];
  for (const id of recentIds) {
    if (executions[id]?.pinned) pinned.push(id);
    else rest.push(id);
  }
  return [...pinned, ...rest];
}

/**
 * Move `activeId` to the slot occupied by `overId` within `recentIds`.
 * The move is REJECTED (returns the array unchanged) when the two ids are not
 * in the same pinned/unpinned partition — a pinned run can never be ordered
 * after an unpinned one, and vice versa. Both ids must exist.
 */
function moveWithinPartition(
  recentIds: string[],
  executions: Record<string, Execution>,
  activeId: string,
  overId: string,
): string[] {
  if (activeId === overId) return recentIds;
  const fromIdx = recentIds.indexOf(activeId);
  const toIdx = recentIds.indexOf(overId);
  if (fromIdx === -1 || toIdx === -1) return recentIds;
  // Reject cross-partition moves: keep pinned ahead of unpinned.
  const activePinned = executions[activeId]?.pinned ?? false;
  const overPinned = executions[overId]?.pinned ?? false;
  if (activePinned !== overPinned) return recentIds;
  const next = [...recentIds];
  next.splice(fromIdx, 1);
  next.splice(next.indexOf(overId) + (toIdx > fromIdx ? 1 : 0), 0, activeId);
  return next;
}

/**
 * Persisted slice: ONLY pinned runs survive a reload. We deliberately never
 * persist the whole store — restoring a `running` execution would resurrect a
 * zombie process entry with no live event stream behind it. So `partialize`
 * keeps just the pinned executions and the matching recent-id order; the panel
 * boots closed and with no active selection.
 */
interface PersistedExecutionState {
  executions: Record<string, Execution>;
  recentIds: string[];
}

export const useExecutionStore = create<ExecutionState>()(
  persist(
    (set) => ({
      executions: {},
      recentIds: [],
      activeExecutionId: null,
      panelOpen: false,
      panelHeight: DEFAULT_PANEL_HEIGHT,
      panelWidth: DEFAULT_PANEL_WIDTH,
      consolePosition: "bottom",

  startExecution: (
    id,
    commandId,
    commandName,
    script,
    shell,
    variables,
    env,
    variableValuesRaw,
    target,
    workingDir,
    pid,
  ) =>
    set((state) => {
      const existing = state.executions[id];
      const execution: Execution = existing
        ? {
            ...existing,
            commandId: existing.commandId ?? commandId,
            commandName: existing.commandName || commandName,
            script: existing.script ?? script,
            shell: existing.shell ?? shell,
            variables: existing.variables ?? variables,
            env: existing.env ?? env,
            variableValuesRaw: existing.variableValuesRaw ?? variableValuesRaw,
            target: existing.target ?? target,
            workingDir: existing.workingDir ?? workingDir,
            pid: existing.pid ?? pid,
            // If a stub was created by an out-of-order log event, mark it
            // running here (it already was, but be explicit).
            status: existing.status,
          }
        : {
            id,
            commandId,
            commandName,
            script,
            shell,
            variables,
            env,
            variableValuesRaw,
            target,
            workingDir,
            pid,
            status: "running",
            startedAt: Date.now(),
            log: [],
          };
      return {
        executions: { ...state.executions, [id]: execution },
        recentIds: pushRecent(state.recentIds, id, leadingPinnedCount(state.recentIds, state.executions)),
        activeExecutionId: id,
        panelOpen: true,
      };
    }),

  startWorkflowExecution: (runId, title, workflowId) =>
    set((state) => {
      const existing = state.executions[runId];
      // Idempotent: a re-entrant start (e.g. an out-of-order node event
      // already stubbed the id) keeps the existing log/started time and
      // only ensures the workflow marker + a non-empty title are set.
      const execution: Execution = existing
        ? {
            ...existing,
            commandName: existing.commandName || title,
            isWorkflow: true,
            workflowId: existing.workflowId ?? workflowId,
          }
        : {
            id: runId,
            commandName: title,
            isWorkflow: true,
            workflowId,
            status: "running",
            startedAt: Date.now(),
            log: [],
          };
      return {
        executions: { ...state.executions, [runId]: execution },
        recentIds: pushRecent(state.recentIds, runId, leadingPinnedCount(state.recentIds, state.executions)),
        activeExecutionId: runId,
        panelOpen: true,
      };
    }),

  appendWorkflowStepHeader: (runId, text, variant) =>
    set((state) => {
      const existing = state.executions[runId];
      if (!existing) return {};
      const line: ExecutionLogLine = {
        stream: "meta",
        line: text,
        ts: Date.now(),
        ...(variant !== undefined ? { variant } : {}),
      };
      const updated: Execution = {
        ...existing,
        log: [...existing.log, line],
      };
      return {
        executions: { ...state.executions, [runId]: updated },
      };
    }),

  appendLog: (id, line) =>
    set((state) => {
      const existing = state.executions[id];
      if (!existing) {
        // Out-of-order delivery: stdout/stderr arrived before `started`
        // (or `started` was lost during the listener registration race).
        // Create a minimal stub so the line isn't silently dropped — the
        // later `started` event will merge real fields into this stub.
        const stub: Execution = {
          id,
          commandName: "",
          status: "running",
          startedAt: Date.now(),
          log: [line],
        };
        return {
          executions: { ...state.executions, [id]: stub },
          recentIds: pushRecent(state.recentIds, id, leadingPinnedCount(state.recentIds, state.executions)),
          activeExecutionId: state.activeExecutionId ?? id,
          panelOpen: true,
        };
      }
      const updated: Execution = {
        ...existing,
        log: [...existing.log, line],
      };
      return {
        executions: { ...state.executions, [id]: updated },
      };
    }),

  setExecutionResult: (id, result) =>
    set((state) => {
      const existing = state.executions[id];
      if (!existing) {
        // Out-of-order: `result` arrived before `started`. Create a stub
        // so the extraction isn't dropped; later events merge into it.
        const stub: Execution = {
          id,
          commandName: "",
          status: "running",
          startedAt: Date.now(),
          log: [],
          result,
        };
        return {
          executions: { ...state.executions, [id]: stub },
          recentIds: pushRecent(state.recentIds, id, leadingPinnedCount(state.recentIds, state.executions)),
          activeExecutionId: state.activeExecutionId ?? id,
          panelOpen: true,
        };
      }
      const updated: Execution = { ...existing, result };
      return {
        executions: { ...state.executions, [id]: updated },
      };
    }),

  finishExecution: (id, patch) =>
    set((state) => {
      const existing = state.executions[id];
      if (!existing) {
        // Out-of-order: `finished` arrived before `started`. Create a stub
        // so the terminal status is preserved rather than dropped.
        const stub: Execution = {
          id,
          commandName: "",
          status: patch.status ?? "success",
          startedAt: Date.now(),
          finishedAt: patch.finishedAt ?? Date.now(),
          exitCode: patch.exitCode ?? undefined,
          durationMs: patch.durationMs,
          error: patch.error,
          timedOut: patch.timedOut,
          log: [],
        };
        return {
          executions: { ...state.executions, [id]: stub },
          recentIds: pushRecent(state.recentIds, id, leadingPinnedCount(state.recentIds, state.executions)),
          activeExecutionId: state.activeExecutionId ?? id,
        };
      }
      const updated: Execution = {
        ...existing,
        status: setStatusIfMissing(existing, patch),
        exitCode: patch.exitCode ?? existing.exitCode,
        durationMs: patch.durationMs ?? existing.durationMs,
        finishedAt: patch.finishedAt ?? existing.finishedAt ?? Date.now(),
        error: patch.error ?? existing.error,
        // Carry the timeout flag through so the panel/terminal can show a
        // "timed out" status + explanatory line instead of a bare error.
        // Without this the flag was silently dropped and every timeout
        // looked like a generic failure.
        timedOut: patch.timedOut ?? existing.timedOut,
      };
      return {
        executions: { ...state.executions, [id]: updated },
      };
    }),

  setActiveExecution: (id) => set({ activeExecutionId: id }),
  setPanelOpen: (open) => set({ panelOpen: open }),
  setPanelHeight: (height) =>
    set({
      panelHeight: clampPanelHeight(
        height,
        typeof window !== "undefined" ? window.innerHeight : height,
      ),
    }),
  setPanelWidth: (width) =>
    set({
      panelWidth: clampPanelWidth(
        width,
        typeof window !== "undefined" ? window.innerWidth : width,
      ),
    }),
  setConsolePosition: (position) => set({ consolePosition: position }),

  clearExecution: (id) =>
    set((state) => {
      const next = { ...state.executions };
      delete next[id];
      const recentIds = state.recentIds.filter((r) => r !== id);
      const activeExecutionId =
        state.activeExecutionId === id
          ? (recentIds[0] ?? null)
          : state.activeExecutionId;
      return { executions: next, recentIds, activeExecutionId };
    }),

  clearAll: () =>
    set((state) => {
      // "Clear all" keeps pinned runs — the user pinned them precisely so a
      // bulk clear would not drop them. Everything else is removed.
      const kept: Record<string, Execution> = {};
      for (const [id, exec] of Object.entries(state.executions)) {
        if (exec.pinned) kept[id] = exec;
      }
      const recentIds = state.recentIds.filter((id) => kept[id] !== undefined);
      const activeExecutionId =
        state.activeExecutionId !== null &&
        kept[state.activeExecutionId] !== undefined
          ? state.activeExecutionId
          : (recentIds[0] ?? null);
      return { executions: kept, recentIds, activeExecutionId };
    }),

  renameExecution: (id, name) =>
    set((state) => {
      const existing = state.executions[id];
      if (!existing) return {};
      const trimmed = name.trim();
      const updated: Execution = {
        ...existing,
        // An empty rename clears the custom name, falling back to commandName.
        customName: trimmed === "" ? undefined : trimmed,
      };
      return { executions: { ...state.executions, [id]: updated } };
    }),

  setPinned: (id, pinned) =>
    set((state) => {
      const existing = state.executions[id];
      if (!existing) return {};
      const executions = {
        ...state.executions,
        [id]: { ...existing, pinned },
      };
      // Re-partition so the (un)pinned run lands in the correct block: pinning
      // moves it into the pinned block (kept ahead of unpinned); unpinning
      // moves it to the front of the unpinned block.
      return {
        executions,
        recentIds: partitionByPinned(state.recentIds, executions),
      };
    }),

  reorderRecent: (activeId, overId) =>
    set((state) => ({
      recentIds: moveWithinPartition(
        state.recentIds,
        state.executions,
        activeId,
        overId,
      ),
    })),

  clearTerminated: () =>
    set((state) => {
      // Keep executions that are still in progress OR pinned. A pinned run
      // is never auto-cleared so the user's saved entries persist.
      const kept: Record<string, Execution> = {};
      for (const [id, exec] of Object.entries(state.executions)) {
        if (isActiveStatus(exec.status) || exec.pinned) {
          kept[id] = exec;
        }
      }
      const recentIds = state.recentIds.filter((id) => kept[id] !== undefined);
      // If the active execution was cleared, fall back to the most recent
      // surviving one, or null when nothing is left.
      const activeStillPresent =
        state.activeExecutionId !== null &&
        kept[state.activeExecutionId] !== undefined;
      const activeExecutionId = activeStillPresent
        ? state.activeExecutionId
        : (recentIds[0] ?? null);
      return { executions: kept, recentIds, activeExecutionId };
    }),
    }),
    {
      name: "procmix-executions",
      // Persist ONLY pinned runs (see PersistedExecutionState). Restored
      // entries are always terminal — a pinned run is pinned after it has
      // finished — so no zombie "running" state is reintroduced.
      partialize: (state): PersistedExecutionState => {
        const executions: Record<string, Execution> = {};
        for (const [id, exec] of Object.entries(state.executions)) {
          if (exec.pinned) executions[id] = exec;
        }
        const recentIds = state.recentIds.filter(
          (id) => executions[id] !== undefined,
        );
        return { executions, recentIds };
      },
    },
  ),
);
