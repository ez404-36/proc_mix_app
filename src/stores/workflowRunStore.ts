import { create } from "zustand";
import type {
  WorkflowEdgeBranch,
  WorkflowStatus,
} from "../types";

const MAX_RECENT = 50;

/**
 * Per-node lifecycle state within a single workflow run, used by the visual
 * editor (Phase 5) to highlight the graph as it executes.
 *   - "pending"  → not yet reached.
 *   - "running"  → the node's command is in flight.
 *   - "finished" → the node completed (exit code captured separately).
 */
export type WorkflowNodeRunStatus = "pending" | "running" | "finished";

export interface WorkflowNodeRunState {
  status: WorkflowNodeRunStatus;
  /** Exit code once finished; null when not applicable / cancelled. */
  exitCode?: number | null;
  /**
   * Execution id of the underlying command run, when this node is a
   * `command` node. Lets the editor deep-link to the OutputPanel entry.
   */
  executionId?: string;
}

export interface WorkflowRun {
  runId: string;
  workflowId: string;
  status: WorkflowStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  /** Per-node run state, keyed by node id. */
  nodes: Record<string, WorkflowNodeRunState>;
  /**
   * Edge ids that were followed, in order. Drives branch highlighting and
   * lets the editor draw the realised path through the graph.
   */
  takenEdgeIds: string[];
  /** Branch chosen at each condition node, keyed by node id. */
  branches: Record<string, WorkflowEdgeBranch>;
  /** Current iteration (1-based) of each `loop` node, keyed by node id.
   * Updated on every `loopIteration` event for live progress display. */
  loopIterations: Record<string, number>;
  /** Current attempt (1-based) of each `try` node that is retrying, keyed by
   * node id. Updated on every `nodeRetry` event. */
  retryAttempts: Record<string, number>;
  /**
   * Maps each node id to the command id it runs, captured at run start
   * from the workflow graph. Lets consumers (e.g. the console step headers)
   * resolve a node's command — and thus its name and script — even when the
   * run is an UNSAVED draft that is absent from `workflowStore`.
   */
  nodeCommandIds: Record<string, string>;
  /** Error message for a failed run (`status: "error"`). */
  error?: string;
}

interface WorkflowRunState {
  runs: Record<string, WorkflowRun>;
  recentRunIds: string[];

  startRun: (
    runId: string,
    workflowId: string,
    nodeCommandIds?: Record<string, string>,
  ) => void;
  markNodeStarted: (
    runId: string,
    nodeId: string,
    executionId?: string,
  ) => void;
  markNodeFinished: (
    runId: string,
    nodeId: string,
    exitCode: number | null,
  ) => void;
  markBranchTaken: (
    runId: string,
    nodeId: string,
    branch: WorkflowEdgeBranch,
    edgeId: string,
  ) => void;
  markLoopIteration: (runId: string, nodeId: string, iteration: number) => void;
  markRetry: (runId: string, nodeId: string, attempt: number) => void;
  finishRun: (
    runId: string,
    status: Extract<WorkflowStatus, "success" | "error" | "cancelled">,
    patch?: { durationMs?: number; error?: string },
  ) => void;
  clearRun: (runId: string) => void;
  clearAll: () => void;
}

function pushRecent(recentRunIds: string[], runId: string): string[] {
  return [runId, ...recentRunIds.filter((r) => r !== runId)].slice(
    0,
    MAX_RECENT,
  );
}

export const useWorkflowRunStore = create<WorkflowRunState>()((set) => ({
  runs: {},
  recentRunIds: [],

  startRun: (runId, workflowId, nodeCommandIds) =>
    set((state) => {
      const existing = state.runs[runId];
      const run: WorkflowRun = existing ?? {
        runId,
        workflowId,
        status: "running",
        startedAt: Date.now(),
        nodes: {},
        takenEdgeIds: [],
        branches: {},
        loopIterations: {},
        retryAttempts: {},
        nodeCommandIds: nodeCommandIds ?? {},
      };
      return {
        runs: { ...state.runs, [runId]: run },
        recentRunIds: pushRecent(state.recentRunIds, runId),
      };
    }),

  markNodeStarted: (runId, nodeId, executionId) =>
    set((state) => {
      const run = state.runs[runId];
      if (!run) return {};
      const node: WorkflowNodeRunState = {
        ...run.nodes[nodeId],
        status: "running",
        executionId: executionId ?? run.nodes[nodeId]?.executionId,
      };
      return {
        runs: {
          ...state.runs,
          [runId]: { ...run, nodes: { ...run.nodes, [nodeId]: node } },
        },
      };
    }),

  markNodeFinished: (runId, nodeId, exitCode) =>
    set((state) => {
      const run = state.runs[runId];
      if (!run) return {};
      const node: WorkflowNodeRunState = {
        ...run.nodes[nodeId],
        status: "finished",
        exitCode,
      };
      return {
        runs: {
          ...state.runs,
          [runId]: { ...run, nodes: { ...run.nodes, [nodeId]: node } },
        },
      };
    }),

  markBranchTaken: (runId, nodeId, branch, edgeId) =>
    set((state) => {
      const run = state.runs[runId];
      if (!run) return {};
      return {
        runs: {
          ...state.runs,
          [runId]: {
            ...run,
            branches: { ...run.branches, [nodeId]: branch },
            takenEdgeIds: run.takenEdgeIds.includes(edgeId)
              ? run.takenEdgeIds
              : [...run.takenEdgeIds, edgeId],
          },
        },
      };
    }),

  markLoopIteration: (runId, nodeId, iteration) =>
    set((state) => {
      const run = state.runs[runId];
      if (!run) return {};
      return {
        runs: {
          ...state.runs,
          [runId]: {
            ...run,
            loopIterations: { ...run.loopIterations, [nodeId]: iteration },
          },
        },
      };
    }),

  markRetry: (runId, nodeId, attempt) =>
    set((state) => {
      const run = state.runs[runId];
      if (!run) return {};
      return {
        runs: {
          ...state.runs,
          [runId]: {
            ...run,
            retryAttempts: { ...run.retryAttempts, [nodeId]: attempt },
          },
        },
      };
    }),

  finishRun: (runId, status, patch) =>
    set((state) => {
      const run = state.runs[runId];
      if (!run) return {};
      return {
        runs: {
          ...state.runs,
          [runId]: {
            ...run,
            status,
            finishedAt: Date.now(),
            durationMs: patch?.durationMs ?? run.durationMs,
            error: patch?.error ?? run.error,
          },
        },
      };
    }),

  clearRun: (runId) =>
    set((state) => {
      const next = { ...state.runs };
      delete next[runId];
      return {
        runs: next,
        recentRunIds: state.recentRunIds.filter((r) => r !== runId),
      };
    }),

  clearAll: () => set({ runs: {}, recentRunIds: [] }),
}));
