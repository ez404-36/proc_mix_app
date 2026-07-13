import { create } from "zustand";
import type {
  ExecutionLogLine,
  ExtractedResult,
  WorkflowEdgeBranch,
  WorkflowStatus,
} from "../types";

/**
 * Captured output of a single workflow node within a run, used by the editor's
 * node modal to show that node's input/result examples. Distinct from the
 * aggregated console process (which folds every node's stdout into one entry):
 * this keeps each node's own stdout + structured result addressable by node id
 * so a downstream node's "example input" can read its predecessor's result.
 */
export interface WorkflowNodeOutput {
  /** Joined stdout/stderr lines this node produced (the raw output). */
  stdout: string;
  /** Structured output-schema extraction, when the node's command (or a
   * parser node) produced one. */
  result?: ExtractedResult;
}

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
  /**
   * Per-node captured output (raw stdout + structured result), keyed by node
   * id. Populated by the execution bridge as each node streams. Read by the
   * editor's node modal to show input/result examples after a run.
   */
  nodeOutputs: Record<string, WorkflowNodeOutput>;
  /**
   * Per-node BUFFER of console log lines (stdout/stderr) awaiting flush to the
   * aggregated workflow process, keyed by node id. The execution bridge buffers
   * each node's lines here as they stream; the workflow bridge flushes a node's
   * buffer as one contiguous block under that node's step header when the node
   * finishes (or, for still-open nodes, at run end). This is what keeps a
   * parallel fork's interleaved branch output grouped per node rather than
   * smeared together in arrival order. Distinct from `nodeOutputs` (which is the
   * permanent per-node capture the editor's node modal reads): a buffer entry is
   * transient and is removed the instant it is flushed.
   */
  lineBuffers: Record<string, ExecutionLogLine[]>;
  /** Error message for a failed run (`status: "error"`). */
  error?: string;
}

/**
 * The RESOLVED working directory each node's command actually launched in,
 * keyed by the node's `executionId`. Captured from the backend `started`
 * execution-event — authoritative: it reflects a per-node `workingDirSource`
 * override, a `${var}` expansion, a run-time prompt answer, or the home-dir
 * fallback, none of which the static `command.workingDir` shows.
 *
 * Kept as a MODULE-LEVEL map rather than per-run state on purpose: the
 * `started` execution-event can arrive on its own channel BEFORE the run is
 * registered in the store (a frontend Run only calls `startRun` after the
 * `execute_workflow` invoke resolves, and the runner streams events from a
 * background task). A per-run field would drop those early writes; this map
 * accepts them unconditionally. Entries are cleared per-run by `clearRun` /
 * `clearAll` via `dropExecutionWorkingDirs`.
 */
const executionWorkingDirs = new Map<string, string>();

/**
 * The resolved working directory recorded for `executionId`, or `undefined`
 * when none was captured (never started, or a home-dir/remote run reported an
 * empty dir). Read by the console step-header builder.
 */
export function getExecutionWorkingDir(
  executionId: string,
): string | undefined {
  return executionWorkingDirs.get(executionId);
}

/**
 * Drop the recorded working dirs for a run's executions. Called on
 * `clearRun` / `clearAll` so the module map does not grow unbounded across
 * many runs. Takes the run's node execution ids (the only keys it owns).
 */
function dropExecutionWorkingDirs(run: WorkflowRun | undefined): void {
  if (run === undefined) return;
  for (const node of Object.values(run.nodes)) {
    if (node.executionId !== undefined) {
      executionWorkingDirs.delete(node.executionId);
    }
  }
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
  /** Append a captured stdout/stderr line to a node's output, resolving the
   * node by its `executionId` within the run. No-op when the execution id is
   * not (yet) mapped to a node. */
  appendNodeOutputLine: (
    runId: string,
    executionId: string,
    line: string,
  ) => void;
  /** Attach the structured output-schema result to a node's output, resolving
   * the node by its `executionId` within the run. */
  setNodeOutputResult: (
    runId: string,
    executionId: string,
    result: ExtractedResult,
  ) => void;
  /**
   * Record the resolved working directory a node's command launched in,
   * keyed by `executionId`. Called from the execution bridge on the node's
   * `started` event so the console step header can show the REAL directory
   * (override / expanded var / prompt answer / home fallback), not the
   * command's static `workingDir`. No-op with an empty/absent dir.
   */
  setExecutionWorkingDir: (
    runId: string,
    executionId: string,
    workingDir: string | undefined,
  ) => void;
  /**
   * Buffer a console log line against the node owning `executionId`, awaiting
   * flush to the aggregated workflow process. No-op when the execution id is not
   * (yet) mapped to a node within the run.
   */
  bufferNodeLine: (
    runId: string,
    executionId: string,
    line: ExecutionLogLine,
  ) => void;
  /**
   * Remove and return a node's buffered log lines (keyed by node id). Returns an
   * empty array when there is nothing buffered. Called by the workflow bridge to
   * flush a node's grouped output under its step header on finish.
   */
  takeNodeBuffer: (runId: string, nodeId: string) => ExecutionLogLine[];
  /**
   * Remove and return EVERY node's still-buffered lines for a run, as
   * `[nodeId, lines]` pairs. Used at run end (finish/cancel/error) to flush
   * output of nodes that never produced an explicit finish so partial output is
   * not lost. The pairs preserve insertion order of the buffers.
   */
  takeAllBuffers: (runId: string) => Array<[string, ExecutionLogLine[]]>;
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

/** Resolve the node id whose run-state carries `executionId` within a run.
 * The execution bridge tags node output with the execution id only, so this
 * maps it back to a node (set by `markNodeStarted`). Returns null if unmapped
 * (e.g. an event arrived before the matching `nodeStarted`). */
function nodeIdForExecution(
  run: WorkflowRun,
  executionId: string,
): string | null {
  for (const [nodeId, state] of Object.entries(run.nodes)) {
    if (state.executionId === executionId) return nodeId;
  }
  return null;
}

export const useWorkflowRunStore = create<WorkflowRunState>()((set, get) => ({
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
        nodeOutputs: {},
        lineBuffers: {},
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

  appendNodeOutputLine: (runId, executionId, line) =>
    set((state) => {
      const run = state.runs[runId];
      if (!run) return {};
      const nodeId = nodeIdForExecution(run, executionId);
      if (nodeId === null) return {};
      const existing = run.nodeOutputs[nodeId];
      const stdout =
        existing === undefined || existing.stdout === ""
          ? line
          : `${existing.stdout}\n${line}`;
      const next: WorkflowNodeOutput = { ...existing, stdout };
      return {
        runs: {
          ...state.runs,
          [runId]: {
            ...run,
            nodeOutputs: { ...run.nodeOutputs, [nodeId]: next },
          },
        },
      };
    }),

  setNodeOutputResult: (runId, executionId, result) =>
    set((state) => {
      const run = state.runs[runId];
      if (!run) return {};
      const nodeId = nodeIdForExecution(run, executionId);
      if (nodeId === null) return {};
      const existing = run.nodeOutputs[nodeId];
      const next: WorkflowNodeOutput = {
        stdout: existing?.stdout ?? "",
        result,
      };
      return {
        runs: {
          ...state.runs,
          [runId]: {
            ...run,
            nodeOutputs: { ...run.nodeOutputs, [nodeId]: next },
          },
        },
      };
    }),

  setExecutionWorkingDir: (_runId, executionId, workingDir) => {
    // Write UNCONDITIONALLY into the module map — no run-existence guard. The
    // `started` event can land before the run is registered (cross-channel /
    // pre-`startRun` timing); a run-gated write would silently drop it, which
    // is exactly why every step's directory failed to appear. `runId` is
    // unused (the map is global, keyed by the globally-unique execution id).
    const dir = workingDir?.trim();
    if (dir === undefined || dir === "") return;
    executionWorkingDirs.set(executionId, dir);
  },

  bufferNodeLine: (runId, executionId, line) =>
    set((state) => {
      const run = state.runs[runId];
      if (!run) return {};
      const nodeId = nodeIdForExecution(run, executionId);
      if (nodeId === null) return {};
      const existing = run.lineBuffers[nodeId] ?? [];
      return {
        runs: {
          ...state.runs,
          [runId]: {
            ...run,
            lineBuffers: {
              ...run.lineBuffers,
              [nodeId]: [...existing, line],
            },
          },
        },
      };
    }),

  takeNodeBuffer: (runId, nodeId) => {
    const run = get().runs[runId];
    const lines = run?.lineBuffers[nodeId] ?? [];
    if (lines.length === 0) return [];
    set((state) => {
      const current = state.runs[runId];
      if (!current) return {};
      const nextBuffers = { ...current.lineBuffers };
      delete nextBuffers[nodeId];
      return {
        runs: {
          ...state.runs,
          [runId]: { ...current, lineBuffers: nextBuffers },
        },
      };
    });
    return lines;
  },

  takeAllBuffers: (runId) => {
    const run = get().runs[runId];
    const entries = run ? Object.entries(run.lineBuffers) : [];
    if (entries.length === 0) return [];
    set((state) => {
      const current = state.runs[runId];
      if (!current) return {};
      return {
        runs: {
          ...state.runs,
          [runId]: { ...current, lineBuffers: {} },
        },
      };
    });
    return entries;
  },

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
      dropExecutionWorkingDirs(state.runs[runId]);
      const next = { ...state.runs };
      delete next[runId];
      return {
        runs: next,
        recentRunIds: state.recentRunIds.filter((r) => r !== runId),
      };
    }),

  clearAll: () => {
    executionWorkingDirs.clear();
    set({ runs: {}, recentRunIds: [] });
  },
}));
