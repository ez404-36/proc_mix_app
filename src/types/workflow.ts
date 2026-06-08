// Workflow data model — the persisted graph an automation runs, plus
// the runtime event stream the backend emits while executing it.
//
// The shapes here are the UI-facing types (using `undefined` for absent
// optionals). The repository layer (`utils/workflowRepository.ts`,
// added in Phase 3) owns the `null` <-> `undefined` translation against
// the Rust `WorkflowRecord` wire format, exactly like `commandRepository`
// does for `Command`. The runtime event union mirrors `execution.ts`.

/**
 * Kind discriminator for a node in the workflow graph.
 *   - "start"     → unique entry node; exactly one per workflow. Has a
 *     single `out` edge.
 *   - "command"   → runs a referenced `Command` (by `commandId`). Picks
 *     its single `out` edge once the command finishes.
 *   - "condition" → branches on the previous command's exit code:
 *     exit 0 takes the `then` edge, any non-zero takes the `else` edge.
 *   - "end"       → terminal node; stops traversal. A workflow may have
 *     several end nodes (e.g. one per branch).
 */
export type WorkflowNodeKind = "start" | "command" | "condition" | "end";

/**
 * Branch label on an edge leaving a node. `out` is the default single
 * exit (start / command nodes). `then` / `else` are the two exits of a
 * `condition` node, selected by the upstream exit code (see
 * {@link WorkflowNodeKind}).
 */
export type WorkflowEdgeBranch = "out" | "then" | "else";

/**
 * A single node in the graph. `position` is canvas coordinates owned by
 * the visual editor (reactflow); the runner ignores it. `commandId` is
 * required for `command` nodes and absent for every other kind — the
 * editor validates this before save (Phase 5).
 */
export interface WorkflowNode {
  id: string;
  kind: WorkflowNodeKind;
  /** Reference to the `Command` this node runs. `command` nodes only. */
  commandId?: string;
  /** Optional human label shown on the canvas; falls back to the kind. */
  label?: string;
  /** Canvas coordinates for the visual editor. */
  position: { x: number; y: number };
}

/**
 * A directed edge connecting `source` → `target`. `branch` disambiguates
 * the two exits of a `condition` node; `out` is used for the single exit
 * of start / command nodes.
 */
export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  branch: WorkflowEdgeBranch;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  tags: string[];
  categoryId?: string;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  runCount: number;
}

export type WorkflowEventKind =
  | "nodeStarted"
  | "nodeFinished"
  | "branchTaken"
  | "workflowFinished"
  | "workflowCancelled"
  | "workflowError";

export interface WorkflowEventBase {
  kind: WorkflowEventKind;
  /** Run id assigned when the workflow was triggered. */
  runId: string;
  workflowId: string;
}

export interface WorkflowNodeStartedEvent extends WorkflowEventBase {
  kind: "nodeStarted";
  nodeId: string;
  /**
   * For `command` nodes, the execution id of the underlying command run
   * (the same id carried on the `execution-event` channel) so the UI can
   * cross-link graph progress to the OutputPanel. Absent for non-command
   * nodes that perform no execution.
   */
  executionId?: string;
}

export interface WorkflowNodeFinishedEvent extends WorkflowEventBase {
  kind: "nodeFinished";
  nodeId: string;
  /** Exit code of the node's command, or null when not applicable. */
  exitCode: number | null;
}

export interface WorkflowBranchTakenEvent extends WorkflowEventBase {
  kind: "branchTaken";
  /** The condition node whose branch was selected. */
  nodeId: string;
  branch: WorkflowEdgeBranch;
  /** The edge id that was followed. */
  edgeId: string;
}

export interface WorkflowFinishedEvent extends WorkflowEventBase {
  kind: "workflowFinished";
  durationMs: number;
}

export interface WorkflowCancelledEvent extends WorkflowEventBase {
  kind: "workflowCancelled";
}

export interface WorkflowErrorEvent extends WorkflowEventBase {
  kind: "workflowError";
  message: string;
}

export type WorkflowEvent =
  | WorkflowNodeStartedEvent
  | WorkflowNodeFinishedEvent
  | WorkflowBranchTakenEvent
  | WorkflowFinishedEvent
  | WorkflowCancelledEvent
  | WorkflowErrorEvent;

export type WorkflowStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "cancelled";
