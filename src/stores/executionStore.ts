import { create } from "zustand";
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
  ) => void;
  /**
   * Create (or reuse) the single aggregated execution for a workflow run,
   * keyed by the workflow `runId`. Marks it `isWorkflow` so the panel cancels
   * the workflow and hides Re-run, opens the panel, and makes it active —
   * mirroring `startExecution`'s panel behavior. Idempotent on the same id.
   */
  startWorkflowExecution: (runId: string, title: string) => void;
  /**
   * Append an app-injected `meta` separator line (step header / exit
   * trailer) to the aggregated workflow execution. No-op if the execution
   * does not exist yet — the bridge always starts the run before appending.
   */
  appendWorkflowStepHeader: (runId: string, text: string) => void;
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

function pushRecent(recentIds: string[], id: string): string[] {
  return [id, ...recentIds.filter((r) => r !== id)].slice(0, MAX_RECENT);
}

export const useExecutionStore = create<ExecutionState>()((set) => ({
  executions: {},
  recentIds: [],
  activeExecutionId: null,
  panelOpen: false,
  panelHeight: DEFAULT_PANEL_HEIGHT,
  panelWidth: DEFAULT_PANEL_WIDTH,
  consolePosition: "bottom",

  startExecution: (id, commandId, commandName, script, shell, variables, env, variableValuesRaw) =>
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
            status: "running",
            startedAt: Date.now(),
            log: [],
          };
      return {
        executions: { ...state.executions, [id]: execution },
        recentIds: pushRecent(state.recentIds, id),
        activeExecutionId: id,
        panelOpen: true,
      };
    }),

  startWorkflowExecution: (runId, title) =>
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
          }
        : {
            id: runId,
            commandName: title,
            isWorkflow: true,
            status: "running",
            startedAt: Date.now(),
            log: [],
          };
      return {
        executions: { ...state.executions, [runId]: execution },
        recentIds: pushRecent(state.recentIds, runId),
        activeExecutionId: runId,
        panelOpen: true,
      };
    }),

  appendWorkflowStepHeader: (runId, text) =>
    set((state) => {
      const existing = state.executions[runId];
      if (!existing) return {};
      const line: ExecutionLogLine = {
        stream: "meta",
        line: text,
        ts: Date.now(),
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
          recentIds: pushRecent(state.recentIds, id),
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
          recentIds: pushRecent(state.recentIds, id),
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
          recentIds: pushRecent(state.recentIds, id),
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
    set({
      executions: {},
      recentIds: [],
      activeExecutionId: null,
    }),

  clearTerminated: () =>
    set((state) => {
      // Keep only the executions that are still in progress.
      const kept: Record<string, Execution> = {};
      for (const [id, exec] of Object.entries(state.executions)) {
        if (isActiveStatus(exec.status)) {
          kept[id] = exec;
        }
      }
      const recentIds = state.recentIds.filter((id) => kept[id] !== undefined);
      // If the active execution was cleared, fall back to the most recent
      // surviving (running) one, or null when nothing is left.
      const activeStillPresent =
        state.activeExecutionId !== null &&
        kept[state.activeExecutionId] !== undefined;
      const activeExecutionId = activeStillPresent
        ? state.activeExecutionId
        : (recentIds[0] ?? null);
      return { executions: kept, recentIds, activeExecutionId };
    }),
}));
