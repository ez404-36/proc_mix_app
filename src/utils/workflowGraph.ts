// Pure conversion layer between the persisted `Workflow` graph and the
// reactflow `Node` / `Edge` shapes the visual editor renders. Keeping this
// logic out of the React component means it is unit-testable (and fully
// covered) without mounting a canvas in jsdom — see workflowGraph.test.ts.
//
// The mapping is deliberately total and lossless for the fields the runner
// cares about:
//   - `WorkflowNode.position`  <-> reactflow `node.position`
//   - `WorkflowNode.kind`      -> reactflow `node.type` (the registered
//     custom-node key) AND carried in `node.data.kind` so node components
//     can render without a second lookup.
//   - `WorkflowEdge.branch`    <-> reactflow `edge.sourceHandle`. A
//     `condition` node has two source handles (`then` / `else`); every
//     other node has a single `out` handle. reactflow stores the handle a
//     connection left from in `sourceHandle`, so the branch round-trips
//     through it with no extra bookkeeping.

import type { Edge, Node } from "@xyflow/react";
import type {
  DataAssignment,
  DataSource,
  LoopConfig,
  OutputSchema,
  RetryConfig,
  SwitchCase,
  Workflow,
  WorkflowCondition,
  WorkflowEdge,
  WorkflowEdgeBranch,
  WorkflowNode,
  WorkflowNodeKind,
} from "../types";

/**
 * Data payload carried on every reactflow node. `kind` drives which custom
 * component renders; `commandId` / `label` mirror the persisted node. The
 * live-run fields are layered on at render time by the canvas (see
 * `applyRunStateToNodes`) and are absent on a freshly-converted graph.
 *
 * Declared as a `type` (not an `interface`) on purpose: @xyflow/react v12
 * constrains a node's data to `Record<string, unknown>`, which an object-type
 * alias satisfies but an `interface` does not (interfaces have no implicit
 * index signature). See `Node<WorkflowNodeData>` below.
 */
export type WorkflowNodeData = {
  kind: WorkflowNodeKind;
  commandId?: string;
  label?: string;
  /**
   * Advanced-node config, carried verbatim so the inspector can edit it and
   * `flowNodeToNode` can persist it. Each is meaningful for one kind only
   * (`condition` → condition, `switch` → cases, `loop` → loop, `try` → retry,
   * `data` → data); absent for every other kind.
   */
  condition?: WorkflowCondition;
  cases?: SwitchCase[];
  loop?: LoopConfig;
  retry?: RetryConfig;
  data?: DataAssignment[];
  /** Per-variable value sources for the node's command (see WorkflowNode). */
  variableSources?: Record<string, DataSource>;
  /** Output-schema pipeline a `parser` node applies (see WorkflowNode). */
  parser?: OutputSchema;
  /** Template text a `text` node composes (see WorkflowNode). */
  text?: string;
  /** Bound join barrier for a `parallel` (fork) node (see WorkflowNode). */
  joinNodeId?: string;
  /**
   * Editor-only WIRED branch count for a `parallel` (fork) node — the number
   * of slots needed to cover its highest wired `branch:<n>` edge (i.e.
   * `highestWiredIndex + 1`, or 0 for a fresh fork). Drives how many output
   * handles `ParallelNode` renders, so a node knows its branches from its own
   * DATA at first paint rather than reading the global edge store (which is
   * empty at mount, making `branch:<n>` edges fail to render — see the v12
   * migration note in failures.md).
   *
   * DERIVED, never persisted: `workflowToFlow` computes it from the edges, the
   * canvas keeps it in sync as branches are wired/unwired, and
   * `flowNodeToNode` drops it (the persisted source of truth is the edges,
   * which `flowToWorkflow` re-indexes densely on save). Absent for every
   * non-parallel kind.
   */
  parallelBranchCount?: number;
  /** Per-run lifecycle status, injected for live highlighting. */
  runStatus?: "pending" | "running" | "finished";
  /** Exit code once the node finished, for the node badge. */
  exitCode?: number | null;
  /** Current loop iteration (1-based), injected for live highlighting. */
  loopIteration?: number;
  /** Current retry attempt (1-based), injected for live highlighting. */
  retryAttempt?: number;
  /**
   * Transient flag set while a palette command is dragged over the edge
   * connecting this node to its neighbour: `true` marks the two nodes the
   * dropped command would be inserted BETWEEN, so they render a highlighted
   * border. Injected at render time by `markInsertNeighbors`; never persisted.
   */
  insertNeighbor?: boolean;
};

export type WorkflowFlowNode = Node<WorkflowNodeData>;
export type WorkflowFlowEdge = Edge;

/**
 * The single source handle id used by `start` / `command` / `end`-adjacent
 * nodes. `condition` nodes use the branch ids `then` / `else` directly.
 */
const DEFAULT_SOURCE_HANDLE: WorkflowEdgeBranch = "out";

function nodeToFlowNode(node: WorkflowNode): WorkflowFlowNode {
  return {
    id: node.id,
    type: node.kind,
    position: { x: node.position.x, y: node.position.y },
    data: {
      kind: node.kind,
      commandId: node.commandId,
      label: node.label,
      condition: node.condition,
      cases: node.cases,
      loop: node.loop,
      retry: node.retry,
      data: node.data,
      variableSources: node.variableSources,
      parser: node.parser,
      text: node.text,
      joinNodeId: node.joinNodeId,
    },
  };
}

function edgeToFlowEdge(edge: WorkflowEdge): WorkflowFlowEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    // `then`/`else` for condition nodes, `out` otherwise. reactflow keys the
    // outgoing connection off this handle id so it round-trips on save.
    sourceHandle: edge.branch,
  };
}

/** Convert a persisted workflow into reactflow nodes + edges for the canvas. */
export function workflowToFlow(workflow: Workflow): {
  nodes: WorkflowFlowNode[];
  edges: WorkflowFlowEdge[];
} {
  const edges = workflow.edges.map(edgeToFlowEdge);
  // With both nodes and edges in hand, seed every `parallel` fork's editor-only
  // wired-branch count so `ParallelNode` renders the right handle set at first
  // paint (its `branch:<n>` handles must exist for the saved branch edges to
  // render — see `parallelBranchCount` / the v12 migration note).
  const nodes = workflow.nodes.map((node) => withParallelBranchCount(
    nodeToFlowNode(node),
    edges,
  ));
  return { nodes, edges };
}

/**
 * Stamp a `parallel` node's editor-only `data.parallelBranchCount` from the
 * current edges; every other kind passes through unchanged. Returns a new node
 * only when the count actually changes, so callers can use it both to seed the
 * initial graph and to keep counts in sync without churning identity. Pure.
 */
function withParallelBranchCount(
  node: WorkflowFlowNode,
  edges: ReadonlyArray<WorkflowFlowEdge>,
): WorkflowFlowNode {
  if ((node.type ?? node.data.kind) !== "parallel") return node;
  const count = parallelBranchCount(node.id, edges);
  if (node.data.parallelBranchCount === count) return node;
  return { ...node, data: { ...node.data, parallelBranchCount: count } };
}

/**
 * Keep every `parallel` fork's editor-only `data.parallelBranchCount` in sync
 * with the live edges, returning a NEW array only when at least one fork's
 * count changed (otherwise the SAME array reference, so a no-op never triggers
 * a state update / render loop). The canvas calls this after any edge mutation
 * (connect, delete, change) so a wired/unwired branch grows/shrinks the
 * rendered handle set immediately.
 */
export function syncParallelBranchCounts(
  nodes: WorkflowFlowNode[],
  edges: ReadonlyArray<WorkflowFlowEdge>,
): WorkflowFlowNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    const updated = withParallelBranchCount(node, edges);
    if (updated !== node) changed = true;
    return updated;
  });
  return changed ? next : nodes;
}

/**
 * Decode a reactflow node back into a persisted `WorkflowNode`. The node's
 * `type` is the authoritative kind (it is what the canvas registered and
 * what the user sees); `data.kind` mirrors it but `type` wins because
 * reactflow guarantees it stays in sync with the registered component.
 */
function flowNodeToNode(node: WorkflowFlowNode): WorkflowNode {
  const kind = (node.type ?? node.data.kind) as WorkflowNodeKind;
  return {
    id: node.id,
    kind,
    commandId: node.data.commandId,
    label: node.data.label,
    condition: node.data.condition,
    cases: node.data.cases,
    loop: node.data.loop,
    retry: node.data.retry,
    data: node.data.data,
    variableSources: node.data.variableSources,
    parser: node.data.parser,
    text: node.data.text,
    joinNodeId: node.data.joinNodeId,
    position: { x: node.position.x, y: node.position.y },
  };
}

/** Source-handle ids that map 1:1 to a static branch label. `case:<id>` is
 * handled separately (dynamic id). Anything else falls back to `out`. */
const STATIC_BRANCH_HANDLES: ReadonlySet<WorkflowEdgeBranch> =
  new Set<WorkflowEdgeBranch>([
    "out",
    "then",
    "else",
    "default",
    "body",
    "done",
    "ok",
    "catch",
  ]);

function branchFromHandle(
  sourceHandle: string | null | undefined,
): WorkflowEdgeBranch {
  if (sourceHandle == null) return DEFAULT_SOURCE_HANDLE;
  // A `switch` case handle carries its user-authored id (`case:<id>`).
  if (sourceHandle.startsWith("case:")) {
    return sourceHandle as WorkflowEdgeBranch;
  }
  // A `parallel` fork handle carries its branch index (`branch:<n>`). Only a
  // well-formed numeric suffix round-trips; anything else falls back to `out`.
  if (sourceHandle.startsWith("branch:")) {
    const index = sourceHandle.slice("branch:".length);
    if (/^\d+$/.test(index)) {
      return sourceHandle as WorkflowEdgeBranch;
    }
    return DEFAULT_SOURCE_HANDLE;
  }
  if (STATIC_BRANCH_HANDLES.has(sourceHandle as WorkflowEdgeBranch)) {
    return sourceHandle as WorkflowEdgeBranch;
  }
  return DEFAULT_SOURCE_HANDLE;
}

/**
 * The source-handle a node uses to CONTINUE a linear chain — i.e. the branch
 * an inserted node's outgoing edge leaves from when it is spliced onto an
 * existing edge. Single-exit kinds (`start` / `command` / `data` / `end`) use
 * `out`. Branching kinds use their "happy path" / always-present exit so the
 * chain stays connected after the insert, leaving the user to wire the other
 * branches:
 *   - `condition` → `then`   (success)
 *   - `switch`    → `default` (the always-present fallback)
 *   - `loop`      → `done`   (continue AFTER the loop, not into its body)
 *   - `try`       → `ok`     (success)
 *   - `parallel`  → `branch:0` (the first fork branch, always present)
 *   - `join`      → `out`    (single exit after the branches synchronise)
 */
export function primaryOutHandle(kind: WorkflowNodeKind): WorkflowEdgeBranch {
  switch (kind) {
    case "condition":
      return "then";
    case "switch":
      return "default";
    case "loop":
      return "done";
    case "try":
      return "ok";
    case "parallel":
      return "branch:0";
    default:
      return "out";
  }
}

function flowEdgeToEdge(edge: WorkflowFlowEdge): WorkflowEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    branch: branchFromHandle(edge.sourceHandle),
  };
}

/**
 * Close gaps in every `parallel` fork's `branch:<n>` indices so the persisted
 * graph is always densely numbered (`branch:0`, `branch:1`, …) with no holes.
 *
 * Holes appear when the user deletes a middle branch edge (e.g. leaving
 * `branch:0` + `branch:2`). The engine tolerates holes — `edges_for_branch_multi`
 * sorts by index and just runs the present branches — but the editor renders a
 * handle per slot `0..max`, so a hole shows an empty, unwired handle. Rather
 * than paper over it in the node component (which cannot rewrite edges), we fix
 * the source of truth: on save, each fork's surviving branch edges are
 * re-indexed in ascending order of their old index, preserving their relative
 * order and target. Only `branch:<n>` source handles of `parallel` nodes are
 * touched; every other edge passes through unchanged.
 */
function normalizeParallelBranchEdges(
  nodes: WorkflowFlowNode[],
  edges: WorkflowFlowEdge[],
): WorkflowFlowEdge[] {
  const parallelIds = new Set(
    nodes
      .filter((n) => (n.type ?? n.data.kind) === "parallel")
      .map((n) => n.id),
  );
  if (parallelIds.size === 0) return edges;

  // Per fork: its branch edges with the parsed old index, in stored order.
  const branchOrder = new Map<
    string,
    { edgeId: string; oldIndex: number }[]
  >();
  for (const edge of edges) {
    if (!parallelIds.has(edge.source)) continue;
    const handle = edge.sourceHandle;
    if (handle == null || !handle.startsWith("branch:")) continue;
    const oldIndex = Number.parseInt(handle.slice("branch:".length), 10);
    if (!Number.isInteger(oldIndex)) continue;
    const list = branchOrder.get(edge.source) ?? [];
    list.push({ edgeId: edge.id, oldIndex });
    branchOrder.set(edge.source, list);
  }

  // Map each branch edge id → its new dense index (ascending by old index).
  const newHandleByEdgeId = new Map<string, string>();
  for (const list of branchOrder.values()) {
    list
      .slice()
      .sort((a, b) => a.oldIndex - b.oldIndex)
      .forEach((entry, denseIndex) => {
        newHandleByEdgeId.set(entry.edgeId, `branch:${denseIndex}`);
      });
  }
  if (newHandleByEdgeId.size === 0) return edges;

  return edges.map((edge) => {
    const next = newHandleByEdgeId.get(edge.id);
    return next === undefined ? edge : { ...edge, sourceHandle: next };
  });
}

/**
 * Horizontal offset placed between a leaf node and the implicit `end` node
 * auto-appended to it on save, so the synthesized end sits to the node's right
 * rather than stacked on its origin.
 */
const IMPLICIT_END_OFFSET_X = 200;

/**
 * Auto-append an `end` node + edge to every node that has NO outgoing edge
 * (and is not itself an `end`). The engine is deliberately strict — a node
 * with no outgoing edge fails at run time with `NoOutgoingEdge`, because an
 * unwired node is ambiguous (deliberate end vs forgotten link). Rather than
 * relax the engine, the editor resolves the ambiguity on save by drawing the
 * `end` the user would otherwise have to add by hand.
 *
 * The rule is purely "zero outgoing edges → exactly one end": this uniformly
 * covers a lone command/data/parser/text node, a fork's branch commands that
 * dead-end, and even a freshly-dropped branching node with nothing wired yet.
 * A branching node that ALREADY has ≥1 outgoing edge is left untouched — its
 * other unfilled ports remain a validation concern, not something to silently
 * terminate. `end` nodes (zero outgoing by nature) are excluded so this never
 * chains ends onto ends.
 *
 * The synthesized edge leaves the node's PRIMARY out handle (see
 * {@link primaryOutHandle}) so a bare branching node gets its happy-path branch
 * wired to the end. Pure: returns fresh arrays.
 */
function appendImplicitEnds(
  nodes: WorkflowFlowNode[],
  edges: WorkflowFlowEdge[],
): { nodes: WorkflowFlowNode[]; edges: WorkflowFlowEdge[] } {
  const hasOutgoing = new Set<string>();
  for (const edge of edges) {
    hasOutgoing.add(edge.source);
  }

  const newNodes: WorkflowFlowNode[] = [];
  const newEdges: WorkflowFlowEdge[] = [];
  for (const node of nodes) {
    const kind = (node.type ?? node.data.kind) as WorkflowNodeKind;
    if (kind === "end") continue;
    if (hasOutgoing.has(node.id)) continue;

    const endNode: WorkflowFlowNode = {
      id: makeGraphId("node"),
      type: "end",
      position: {
        x: node.position.x + IMPLICIT_END_OFFSET_X,
        y: node.position.y,
      },
      data: { kind: "end" },
    };
    newNodes.push(endNode);
    newEdges.push({
      id: makeGraphId("edge"),
      source: node.id,
      target: endNode.id,
      sourceHandle: primaryOutHandle(kind),
    });
  }

  if (newNodes.length === 0) return { nodes, edges };
  return {
    nodes: [...nodes, ...newNodes],
    edges: [...edges, ...newEdges],
  };
}

/**
 * Fold the live canvas state back into the persisted shape, merging the
 * authored fields (name/description/tags/etc.) from `base` with the current
 * nodes/edges. The caller owns identity (`id`) and timestamps via the store;
 * this only rebuilds the graph portion plus the passed-through metadata.
 */
export function flowToWorkflow(
  base: Pick<
    Workflow,
    "name" | "description" | "icon" | "tags" | "categoryId"
  >,
  nodes: WorkflowFlowNode[],
  edges: WorkflowFlowEdge[],
): Pick<
  Workflow,
  "name" | "description" | "icon" | "tags" | "categoryId" | "nodes" | "edges"
> {
  // Re-index every parallel fork's branch edges to a dense 0..k before
  // persisting, so a fork left with index gaps (a deleted middle branch) never
  // saves a hole that the editor would render as an empty handle.
  const normalizedEdges = normalizeParallelBranchEdges(nodes, edges);
  // Auto-terminate every leaf node (zero outgoing edges) with an implicit
  // `end`, so a saved graph never trips the engine's strict `NoOutgoingEdge`
  // for an unwired node the user simply meant to finish.
  const withEnds = appendImplicitEnds(nodes, normalizedEdges);
  return {
    name: base.name,
    description: base.description,
    icon: base.icon,
    tags: base.tags,
    categoryId: base.categoryId,
    nodes: withEnds.nodes.map(flowNodeToNode),
    edges: withEnds.edges.map(flowEdgeToEdge),
  };
}

/**
 * For a workflow graph, map every node that lies inside a `parallel` fork's
 * branch to that branch's 1-based slot number, so the console can prefix a
 * node's step header with `(ветка N)`. Operates on the PERSISTED graph shape
 * (`WorkflowNode` / `WorkflowEdge`), which is what the run bridge has.
 *
 * For each parallel fork, its `branch:<n>` edges are walked in ascending index
 * order; from each branch target we BFS forward marking every reachable node
 * with that branch's slot (`n + 1`), stopping at the fork's bound join
 * (`joinNodeId`, which belongs to no branch) and never crossing into another
 * fork's already-claimed nodes (first match wins, so an outer fork's slot is
 * not overwritten by an inner one). `end` nodes are marked too (harmless — they
 * emit no header) but are not traversed past.
 *
 * The result is a plain `Record<nodeId, slot>`; a node absent from the map is
 * not inside any branch and gets a plain header. This is intentionally
 * conservative: when in doubt (e.g. a malformed graph) a node simply gets no
 * slot rather than a wrong one.
 */
export function branchSlotsByNode(
  nodes: ReadonlyArray<WorkflowNode>,
  edges: ReadonlyArray<WorkflowEdge>,
): Record<string, number> {
  const parallelIds = new Set(
    nodes.filter((n) => n.kind === "parallel").map((n) => n.id),
  );
  if (parallelIds.size === 0) return {};

  const joinByFork = new Map<string, string | undefined>();
  for (const node of nodes) {
    if (node.kind === "parallel") joinByFork.set(node.id, node.joinNodeId);
  }

  // Adjacency: source → list of target node ids (for forward BFS).
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.source);
    if (list === undefined) outgoing.set(edge.source, [edge.target]);
    else list.push(edge.target);
  }

  const slotByNode: Record<string, number> = {};

  for (const forkId of parallelIds) {
    const join = joinByFork.get(forkId);
    // The fork's branch edges, sorted by ascending branch index so slot
    // numbers are stable (branch:0 → slot 1, branch:1 → slot 2, …).
    const branchEdges = edges
      .filter(
        (e) => e.source === forkId && e.branch.startsWith("branch:"),
      )
      .map((e) => ({
        target: e.target,
        index: Number.parseInt(e.branch.slice("branch:".length), 10),
      }))
      .filter((b) => Number.isInteger(b.index))
      .sort((a, b) => a.index - b.index);

    branchEdges.forEach((branch, slotZeroBased) => {
      const slot = slotZeroBased + 1;
      // BFS forward from the branch's entry node, claiming unclaimed nodes for
      // this slot. Stop at the bound join (a barrier shared by all branches)
      // and never re-enter the fork itself or a node already claimed.
      const stack = [branch.target];
      const visited = new Set<string>();
      while (stack.length > 0) {
        const current = stack.pop() as string;
        if (visited.has(current)) continue;
        visited.add(current);
        if (current === join) continue; // the join is not part of any branch
        if (current === forkId) continue; // never claim the fork node itself
        if (slotByNode[current] === undefined) {
          slotByNode[current] = slot;
        }
        for (const next of outgoing.get(current) ?? []) {
          if (!visited.has(next)) stack.push(next);
        }
      }
    });
  }

  return slotByNode;
}

/**
 * Generate a UUID-like id for a node/edge created on the canvas. Mirrors the
 * fallback in the stores so tests under a minimal `crypto` polyfill stay
 * deterministic-ish without throwing.
 */
export function makeGraphId(prefix: "node" | "edge"): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `${prefix}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/**
 * Per-node run snapshot used to drive live highlighting. Mirrors the
 * relevant slice of `WorkflowRun.nodes[id]` from the run store, decoupled
 * from the store type so this pure module has no store dependency.
 */
export interface NodeRunSnapshot {
  status: "pending" | "running" | "finished";
  exitCode?: number | null;
}

/**
 * Live-run overlays a node can receive, beyond its per-node lifecycle
 * snapshot: the current `loop` iteration and `try` retry attempt, both keyed
 * by node id. Bundled so `applyRunStateToNodes` keeps a small signature.
 */
export interface RunOverlays {
  loopIterations?: Record<string, number>;
  retryAttempts?: Record<string, number>;
}

/**
 * Overlay live run state onto the canvas nodes. Returns a NEW array with new
 * `data` objects only where the run state changed a node, leaving identity
 * stable for untouched nodes so reactflow can bail out of re-rendering them.
 * When `runNodes` is undefined (no active run) every node is stripped of any
 * stale `runStatus` / iteration / attempt so the canvas returns to its static
 * appearance.
 */
export function applyRunStateToNodes(
  nodes: WorkflowFlowNode[],
  runNodes: Record<string, NodeRunSnapshot> | undefined,
  overlays?: RunOverlays,
): WorkflowFlowNode[] {
  return nodes.map((node) => {
    const snapshot = runNodes?.[node.id];
    const nextStatus = snapshot?.status;
    const nextExit = snapshot?.exitCode;
    const nextLoop = overlays?.loopIterations?.[node.id];
    const nextRetry = overlays?.retryAttempts?.[node.id];
    if (
      node.data.runStatus === nextStatus &&
      node.data.exitCode === nextExit &&
      node.data.loopIteration === nextLoop &&
      node.data.retryAttempt === nextRetry
    ) {
      return node;
    }
    return {
      ...node,
      data: {
        ...node.data,
        runStatus: nextStatus,
        exitCode: nextExit,
        loopIteration: nextLoop,
        retryAttempt: nextRetry,
      },
    };
  });
}

/**
 * Mark the edges that were followed during a run so the canvas can highlight
 * the realised path. Returns a new array; an edge whose `taken` flag is
 * unchanged keeps its identity.
 */
export function markTakenEdges(
  edges: WorkflowFlowEdge[],
  takenEdgeIds: ReadonlyArray<string> | undefined,
): WorkflowFlowEdge[] {
  const taken = new Set(takenEdgeIds ?? []);
  return edges.map((edge) => {
    const isTaken = taken.has(edge.id);
    const wasTaken = edge.animated === true;
    if (isTaken === wasTaken) return edge;
    return {
      ...edge,
      animated: isTaken,
      className: isTaken ? "wf-edge--taken" : undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// Auto-connect helpers for palette drag-drop / click-to-append.
//
// These are pure graph queries + transforms so the canvas component stays a
// thin wiring layer and the geometry/branching rules are unit-tested without
// a real reactflow layout engine. All coordinates are FLOW coordinates (what
// `screenToFlowPosition` returns), matching `node.position`.
// ---------------------------------------------------------------------------

/** Point in flow coordinates. */
export interface FlowPoint {
  x: number;
  y: number;
}

/**
 * Approximate on-canvas dimensions of a node, used to derive handle anchor
 * points from a node's top-left `position`. reactflow measures real sizes at
 * render time, but for hit-testing a straight edge segment a fixed estimate
 * (matching the `.wf-node` min-width / typical height in theme.css) is more
 * than accurate enough and keeps this module pure (no DOM).
 */
const NODE_WIDTH = 150;
const NODE_HEIGHT = 52;

/** Horizontal gap placed between a node and a node appended to its right. */
export const APPEND_GAP_X = 180;

/**
 * Horizontal distance the downstream subgraph is pushed right when a node is
 * spliced into an edge, so the inserted node has room and the chain stays
 * evenly spaced (a node's footprint + the standard append gap).
 */
export const INSERT_SHIFT_X = NODE_WIDTH + APPEND_GAP_X;

/** Distance threshold (flow units) for treating a drop as "on" an edge. */
export const EDGE_HIT_THRESHOLD = 28;

/** The source (right-side, output) anchor point of a node. */
function sourceAnchor(node: WorkflowFlowNode): FlowPoint {
  return {
    x: node.position.x + NODE_WIDTH,
    y: node.position.y + NODE_HEIGHT / 2,
  };
}

/** The target (left-side, input) anchor point of a node. */
function targetAnchor(node: WorkflowFlowNode): FlowPoint {
  return { x: node.position.x, y: node.position.y + NODE_HEIGHT / 2 };
}

/** Shortest distance from point `p` to the segment `a`–`b` (flow units). */
function distanceToSegment(p: FlowPoint, a: FlowPoint, b: FlowPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    // Degenerate segment (a === b): distance to the point.
    return Math.hypot(p.x - a.x, p.y - a.y);
  }
  // Project p onto the segment, clamped to [0, 1].
  let tParam = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  tParam = Math.max(0, Math.min(1, tParam));
  const projX = a.x + tParam * dx;
  const projY = a.y + tParam * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

/**
 * Find the edge whose straight source→target segment is closest to `point`,
 * within `threshold` flow units. Returns the nearest edge's id, or `null`
 * when no edge is close enough (or an edge references a missing node).
 * Used to highlight + splice-insert on drop.
 */
export function findEdgeNearPoint(
  nodes: WorkflowFlowNode[],
  edges: WorkflowFlowEdge[],
  point: FlowPoint,
  threshold: number = EDGE_HIT_THRESHOLD,
): string | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let bestId: string | null = null;
  let bestDist = threshold;
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) continue;
    const dist = distanceToSegment(
      point,
      sourceAnchor(source),
      targetAnchor(target),
    );
    if (dist <= bestDist) {
      bestDist = dist;
      bestId = edge.id;
    }
  }
  return bestId;
}

/**
 * Flow-coordinate CENTRE point at which to draw the insert preview for the
 * given edge: the midpoint of the A→B segment (A's output anchor to B's input
 * anchor). Returns `null` when the edge or either endpoint is missing. The
 * canvas converts this to screen space to position the translucent preview.
 */
export function insertPreviewPoint(
  nodes: WorkflowFlowNode[],
  edges: WorkflowFlowEdge[],
  edgeId: string | null,
): FlowPoint | null {
  if (edgeId === null) return null;
  const edge = edges.find((e) => e.id === edgeId);
  if (edge === undefined) return null;
  const source = nodes.find((n) => n.id === edge.source);
  const target = nodes.find((n) => n.id === edge.target);
  if (source === undefined || target === undefined) return null;
  const a = sourceAnchor(source);
  const b = targetAnchor(target);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * The WIRED branch count of a `parallel` (fork) node: the number of slots
 * needed to cover its highest wired `branch:<n>` edge — i.e.
 * `highestWiredIndex + 1`, or 0 when nothing is wired. A temporary gap (e.g.
 * `branch:0` + `branch:2`, before save densifies it) still counts the high
 * index, so its wired handle is preserved (returns 3 here, covering 0..2).
 *
 * This is what `workflowToFlow` stores in `data.parallelBranchCount` and what
 * the canvas recomputes whenever a fork's branch edge is added or removed, so
 * {@link ParallelNode} can derive its handles from node DATA (available at
 * first paint) rather than the global edge store (empty at mount).
 */
export function parallelBranchCount(
  nodeId: string,
  edges: ReadonlyArray<WorkflowFlowEdge>,
): number {
  let highest = -1;
  for (const edge of edges) {
    if (edge.source !== nodeId) continue;
    const handle = edge.sourceHandle;
    if (handle == null || !handle.startsWith("branch:")) continue;
    const index = Number.parseInt(handle.slice("branch:".length), 10);
    if (Number.isInteger(index) && index >= 0 && index > highest) {
      highest = index;
    }
  }
  return highest + 1;
}

/**
 * The `branch:<n>` source-handle indices a `parallel` (fork) node renders,
 * sorted ascending, derived from its WIRED branch `count` (see
 * {@link parallelBranchCount}). Renders one handle per slot `0..count-1` (so
 * every wired branch, including one past a temporary gap, keeps its handle)
 * PLUS exactly ONE trailing free index (`count`) — the next unused slot the
 * user drags a new branch from.
 *
 * A fresh, unwired fork (`count === 0`) therefore shows a single empty handle
 * (`branch:0`); wiring it grows the count to 1 and reveals `branch:1` as the
 * next free slot; and so on. On save, {@link flowToWorkflow} re-indexes the
 * wired branches densely, so any gap collapses and persisted forks never
 * carry a hole.
 */
export function parallelBranchIndices(count: number): number[] {
  const slots = Math.max(0, Math.trunc(count)) + 1;
  return Array.from({ length: slots }, (_unused, index) => index);
}

/**
 * Whether a node exposes a free single `out` source port — i.e. it is a
 * single-exit kind (`start` / `command` / `data`) with no edge already
 * leaving its `out` handle. Multi-exit / branching kinds (`condition`,
 * `switch`, `loop`, `try`, `parallel`, `join`) are deliberately EXCLUDED:
 * their branch ports (`then`/`else`, `case:*`/`default`, `body`/`done`,
 * `ok`/`catch`, `branch:<n>`) are too ambiguous to auto-pick, so they are
 * only wired manually or via edge-insertion. `end` nodes have no source port.
 */
function hasFreeOutPort(
  node: WorkflowFlowNode,
  edges: WorkflowFlowEdge[],
): boolean {
  const kind = node.type ?? node.data.kind;
  if (kind !== "start" && kind !== "command" && kind !== "data") return false;
  return !edges.some(
    (e) =>
      e.source === node.id &&
      (e.sourceHandle === "out" ||
        e.sourceHandle === null ||
        e.sourceHandle === undefined),
  );
}

/**
 * The unique node feeding into `nodeId`, when there is exactly one. A `data`
 * node pulls values from "the previous node"; the editor can only offer the
 * right kind-specific source options when that predecessor is unambiguous.
 *
 * Returns the single predecessor node, or `null` when there are zero or many
 * (converging branches) — in which case the inspector falls back to the
 * universal sources (manual / raw output / exit code). At RUN time the engine
 * always resolves the real previous node regardless of this static ambiguity.
 */
export function findSinglePredecessor(
  nodeId: string,
  nodes: WorkflowFlowNode[],
  edges: WorkflowFlowEdge[],
): WorkflowFlowNode | null {
  const sources = edges
    .filter((e) => e.target === nodeId)
    .map((e) => e.source);
  const unique = Array.from(new Set(sources));
  if (unique.length !== 1) return null;
  return nodes.find((n) => n.id === unique[0]) ?? null;
}

/**
 * Find the node to auto-attach a dropped command to: the `start`/`command`
 * node with a FREE `out` port whose output anchor is nearest to `point`.
 * Returns `null` when no such tail exists (the dropped node is then left
 * unconnected). Never auto-attaches to a `condition` branch.
 */
export function findAttachTail(
  nodes: WorkflowFlowNode[],
  edges: WorkflowFlowEdge[],
  point: FlowPoint,
): string | null {
  let bestId: string | null = null;
  let bestDist = Infinity;
  for (const node of nodes) {
    if (!hasFreeOutPort(node, edges)) continue;
    const anchor = sourceAnchor(node);
    const dist = Math.hypot(point.x - anchor.x, point.y - anchor.y);
    if (dist < bestDist) {
      bestDist = dist;
      bestId = node.id;
    }
  }
  return bestId;
}

/**
 * Deterministically pick the "last" node of the graph for click-to-append:
 * the `start`/`command` node with a free `out` port that is furthest to the
 * RIGHT (largest x); ties broken by the later position in the node array
 * (most recently added). Returns `null` when no attachable tail exists.
 */
export function findLastNode(
  nodes: WorkflowFlowNode[],
  edges: WorkflowFlowEdge[],
): string | null {
  let best: { id: string; x: number; index: number } | null = null;
  nodes.forEach((node, index) => {
    if (!hasFreeOutPort(node, edges)) return;
    const x = node.position.x;
    if (
      best === null ||
      x > best.x ||
      (x === best.x && index > best.index)
    ) {
      best = { id: node.id, x, index };
    }
  });
  return best === null ? null : (best as { id: string }).id;
}

/**
 * Connect a tail node's `out` port to `newNode` and append the node. Pure:
 * returns fresh `nodes` / `edges` arrays. Does nothing extra when `tailId`
 * is null (just appends the node unconnected).
 */
export function connectTailToNode(
  nodes: WorkflowFlowNode[],
  edges: WorkflowFlowEdge[],
  tailId: string | null,
  newNode: WorkflowFlowNode,
): { nodes: WorkflowFlowNode[]; edges: WorkflowFlowEdge[] } {
  const nextNodes = [...nodes, newNode];
  if (tailId === null) {
    return { nodes: nextNodes, edges };
  }
  const edge: WorkflowFlowEdge = {
    id: makeGraphId("edge"),
    source: tailId,
    target: newNode.id,
    sourceHandle: "out",
  };
  return { nodes: nextNodes, edges: [...edges, edge] };
}

/**
 * Remove a node and re-stitch the graph: every predecessor `A → X` is
 * bridged to every successor `X → B` so the chain stays connected after `X`
 * is gone. The bridge edge inherits the INCOMING edge's `sourceHandle`, so
 * deleting a node in the middle of `A.(branch) → X → B` yields
 * `A.(branch) → B` (preserving which branch A left on). Self-loops (`A === B`)
 * and edges that already exist between the same source/handle/target are
 * skipped, so re-stitching never creates duplicates or cycles-of-one. Pure:
 * returns fresh arrays.
 */
export function removeNodeReconnecting(
  nodes: WorkflowFlowNode[],
  edges: WorkflowFlowEdge[],
  nodeId: string,
): { nodes: WorkflowFlowNode[]; edges: WorkflowFlowEdge[] } {
  const incoming = edges.filter((e) => e.target === nodeId);
  const outgoing = edges.filter((e) => e.source === nodeId);
  // Drop the node and every edge touching it.
  const remaining = edges.filter(
    (e) => e.source !== nodeId && e.target !== nodeId,
  );
  const nextNodes = nodes.filter((n) => n.id !== nodeId);

  const bridges: WorkflowFlowEdge[] = [];
  const exists = (
    source: string,
    target: string,
    handle: string | null | undefined,
  ): boolean =>
    remaining.some(
      (e) =>
        e.source === source &&
        e.target === target &&
        (e.sourceHandle ?? null) === (handle ?? null),
    ) ||
    bridges.some(
      (e) =>
        e.source === source &&
        e.target === target &&
        (e.sourceHandle ?? null) === (handle ?? null),
    );

  for (const inEdge of incoming) {
    for (const outEdge of outgoing) {
      if (inEdge.source === outEdge.target) continue; // no self-loop
      if (exists(inEdge.source, outEdge.target, inEdge.sourceHandle)) continue;
      bridges.push({
        id: makeGraphId("edge"),
        source: inEdge.source,
        target: outEdge.target,
        sourceHandle: inEdge.sourceHandle,
      });
    }
  }

  return { nodes: nextNodes, edges: [...remaining, ...bridges] };
}

/**
 * Collect every node reachable from `startId` by following edges in the
 * source→target direction (the node's descendants), NOT including `startId`
 * itself. Cycle-safe via a visited set. Pure; used to translate the
 * downstream subgraph when a node is inserted into an edge.
 */
export function collectDownstream(
  edges: WorkflowFlowEdge[],
  startId: string,
): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.source);
    if (list === undefined) {
      outgoing.set(edge.source, [edge.target]);
    } else {
      list.push(edge.target);
    }
  }
  const downstream = new Set<string>();
  const stack = [startId];
  const visited = new Set<string>([startId]);
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const next of outgoing.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      downstream.add(next);
      stack.push(next);
    }
  }
  return downstream;
}

/**
 * Splice `newNode` into the path of an existing edge: given `A → B` via
 * `edgeId`, remove that edge and add `A.(originalBranch) → newNode` and
 * `newNode.out → B`. Preserves the branch the original edge left A on (so an
 * insertion onto a condition's `then` edge keeps `then` on the A side).
 *
 * LAYOUT: to keep the chain visually even, the new node takes B's slot
 * (B's current position) and B together with its entire downstream subgraph
 * is shifted right by `INSERT_SHIFT_X`, making room without overlapping. The
 * `newNode`'s own incoming `position` is ignored in favour of B's slot so the
 * inserted node lands on the existing row regardless of the exact drop point.
 *
 * Pure: returns fresh arrays. When `edgeId` is not found, the node is appended
 * unconnected at its given position (defensive — callers pass a known id).
 */
export function insertNodeOnEdge(
  nodes: WorkflowFlowNode[],
  edges: WorkflowFlowEdge[],
  newNode: WorkflowFlowNode,
  edgeId: string,
): { nodes: WorkflowFlowNode[]; edges: WorkflowFlowEdge[] } {
  const original = edges.find((e) => e.id === edgeId);
  if (original === undefined) {
    return { nodes: [...nodes, newNode], edges };
  }

  const targetNode = nodes.find((n) => n.id === original.target);
  // The inserted node takes B's slot so it sits on the existing chain row.
  const placedNode: WorkflowFlowNode =
    targetNode === undefined
      ? newNode
      : { ...newNode, position: { ...targetNode.position } };

  // Shift B and its descendants right to open a gap for the inserted node.
  const toShift = collectDownstream(edges, original.source);
  // `collectDownstream(source)` includes B (the target) and everything past
  // it, but not A (the source) nor unrelated branches. That is exactly the
  // set that must move.
  const shiftedNodes = nodes.map((node) =>
    toShift.has(node.id)
      ? {
          ...node,
          position: { x: node.position.x + INSERT_SHIFT_X, y: node.position.y },
        }
      : node,
  );

  const remaining = edges.filter((e) => e.id !== edgeId);
  const intoNew: WorkflowFlowEdge = {
    id: makeGraphId("edge"),
    source: original.source,
    target: placedNode.id,
    sourceHandle: original.sourceHandle,
  };
  const outOfNew: WorkflowFlowEdge = {
    id: makeGraphId("edge"),
    source: placedNode.id,
    target: original.target,
    // Continue the chain on the inserted node's primary exit. A branching
    // node (condition / switch / loop / try) has no `out` handle, so use its
    // happy-path branch; the user wires the remaining branches afterwards.
    sourceHandle: primaryOutHandle(placedNode.data.kind),
  };
  return {
    nodes: [...shiftedNodes, placedNode],
    edges: [...remaining, intoNew, outOfNew],
  };
}

/**
 * Whether `nodeId` is a free-floating node — present on the canvas but in no
 * edge (neither source nor target). Only such a node may be spliced onto an
 * edge by dragging it there: a node already wired into the graph keeps its
 * connections (dragging it just repositions it).
 */
export function isUnconnectedNode(
  nodeId: string,
  edges: WorkflowFlowEdge[],
): boolean {
  return !edges.some((e) => e.source === nodeId || e.target === nodeId);
}

/**
 * Splice an EXISTING, currently-unconnected node onto an edge — the canvas
 * calls this when the user drags a free-floating node (one they already added
 * but never wired) over a connection. Unlike {@link insertNodeOnEdge} the node
 * is already in `nodes` so it is NOT duplicated; edges change to `A → node`
 * (preserving A's branch) and `node.(primary) → B`.
 *
 * LAYOUT: identical to {@link insertNodeOnEdge} — the spliced node takes B's
 * slot (so it lands on the existing chain row, not wherever it was dropped),
 * and B plus its whole downstream subgraph shifts right by `INSERT_SHIFT_X` to
 * open a gap. This matches the visual result of dragging a node from the
 * palette onto the same edge.
 *
 * Returns `null` (caller leaves the graph as-is) when the splice is invalid:
 * the node is already connected, the node is not free, the edge is unknown, or
 * the edge touches the node itself (which would self-loop). Pure otherwise.
 */
export function spliceExistingNodeOnEdge(
  nodes: WorkflowFlowNode[],
  edges: WorkflowFlowEdge[],
  nodeId: string,
  edgeId: string,
): { nodes: WorkflowFlowNode[]; edges: WorkflowFlowEdge[] } | null {
  if (!isUnconnectedNode(nodeId, edges)) return null;
  const original = edges.find((e) => e.id === edgeId);
  if (original === undefined) return null;
  // Splicing onto an edge that already touches the node is meaningless and
  // would create a self-loop.
  if (original.source === nodeId || original.target === nodeId) return null;
  const node = nodes.find((n) => n.id === nodeId);
  if (node === undefined) return null;

  // Shift B and its descendants right to open a gap, then drop the spliced
  // node into B's vacated slot. `collectDownstream(source)` is B + everything
  // past it (not A, not unrelated branches, and not the still-unconnected
  // spliced node) — exactly the set that must move.
  const targetNode = nodes.find((n) => n.id === original.target);
  const toShift = collectDownstream(edges, original.source);
  const nextNodes = nodes.map((n) => {
    if (n.id === nodeId) {
      return targetNode === undefined
        ? n
        : { ...n, position: { ...targetNode.position } };
    }
    return toShift.has(n.id)
      ? { ...n, position: { x: n.position.x + INSERT_SHIFT_X, y: n.position.y } }
      : n;
  });

  const remaining = edges.filter((e) => e.id !== edgeId);
  const intoNode: WorkflowFlowEdge = {
    id: makeGraphId("edge"),
    source: original.source,
    target: nodeId,
    sourceHandle: original.sourceHandle,
  };
  const outOfNode: WorkflowFlowEdge = {
    id: makeGraphId("edge"),
    source: nodeId,
    target: original.target,
    sourceHandle: primaryOutHandle(node.data.kind),
  };
  return { nodes: nextNodes, edges: [...remaining, intoNode, outOfNode] };
}

/**
 * Mark a single edge as the active drop-target (insertion preview) so the
 * canvas can render the "will be inserted here" hint. Returns a new array;
 * only the targeted edge's object changes identity, so reactflow re-renders
 * just that edge — every other edge keeps its reference (mirrors
 * `markTakenEdges`). `dropTargetId === null` clears any prior highlight.
 */
export function markDropTargetEdge(
  edges: WorkflowFlowEdge[],
  dropTargetId: string | null,
): WorkflowFlowEdge[] {
  return edges.map((edge) => {
    const isTarget = edge.id === dropTargetId;
    const wasTarget = edge.className?.includes("wf-edge--drop-target") ?? false;
    if (isTarget === wasTarget) return edge;
    // Preserve any taken-edge class so live-run highlight + drop hint coexist.
    const base = (edge.className ?? "")
      .split(" ")
      .filter((c) => c !== "" && c !== "wf-edge--drop-target");
    const nextClasses = isTarget ? [...base, "wf-edge--drop-target"] : base;
    const className = nextClasses.length > 0 ? nextClasses.join(" ") : undefined;
    return { ...edge, className };
  });
}

/**
 * Flag the two nodes a dragged command would be inserted BETWEEN — the
 * `source` (A) and `target` (B) of the edge currently under the cursor — so
 * the canvas can render a highlighted border on exactly those two. Returns a
 * NEW object only for the two neighbours (and for any node clearing a stale
 * flag); every other node keeps its reference, so reactflow re-renders just
 * the affected nodes (mirrors `applyRunStateToNodes` / `markTakenEdges`).
 *
 * `dropTargetEdgeId === null` clears every flag. Composes with
 * `applyRunStateToNodes`: it only ever touches `data.insertNeighbor`, leaving
 * `runStatus` / `exitCode` intact, so the two overlays can be chained in
 * either order without clobbering each other.
 */
export function markInsertNeighbors(
  nodes: WorkflowFlowNode[],
  edges: WorkflowFlowEdge[],
  dropTargetEdgeId: string | null,
): WorkflowFlowNode[] {
  const target =
    dropTargetEdgeId === null
      ? undefined
      : edges.find((e) => e.id === dropTargetEdgeId);
  const neighbourIds =
    target === undefined
      ? new Set<string>()
      : new Set<string>([target.source, target.target]);
  return nodes.map((node) => {
    const isNeighbour = neighbourIds.has(node.id);
    const wasNeighbour = node.data.insertNeighbor === true;
    if (isNeighbour === wasNeighbour) return node;
    return {
      ...node,
      data: { ...node.data, insertNeighbor: isNeighbour ? true : undefined },
    };
  });
}

/**
 * Build the starting graph for a brand-new workflow: a single `start` node,
 * no edges. Every workflow has exactly one start node, created here and never
 * duplicated by the palette.
 */
export function makeInitialFlow(): {
  nodes: WorkflowFlowNode[];
  edges: WorkflowFlowEdge[];
} {
  const startId = makeGraphId("node");
  return {
    nodes: [
      {
        id: startId,
        type: "start",
        position: { x: 80, y: 80 },
        data: { kind: "start" },
      },
    ],
    edges: [],
  };
}
