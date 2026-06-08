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

import type { Edge, Node } from "reactflow";
import type {
  Workflow,
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
 */
export interface WorkflowNodeData {
  kind: WorkflowNodeKind;
  commandId?: string;
  label?: string;
  /** Per-run lifecycle status, injected for live highlighting. */
  runStatus?: "pending" | "running" | "finished";
  /** Exit code once the node finished, for the node badge. */
  exitCode?: number | null;
  /**
   * Transient flag set while a palette command is dragged over the edge
   * connecting this node to its neighbour: `true` marks the two nodes the
   * dropped command would be inserted BETWEEN, so they render a highlighted
   * border. Injected at render time by `markInsertNeighbors`; never persisted.
   */
  insertNeighbor?: boolean;
}

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
  return {
    nodes: workflow.nodes.map(nodeToFlowNode),
    edges: workflow.edges.map(edgeToFlowEdge),
  };
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
    position: { x: node.position.x, y: node.position.y },
  };
}

function branchFromHandle(
  sourceHandle: string | null | undefined,
): WorkflowEdgeBranch {
  if (sourceHandle === "then" || sourceHandle === "else") {
    return sourceHandle;
  }
  return DEFAULT_SOURCE_HANDLE;
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
  return {
    name: base.name,
    description: base.description,
    icon: base.icon,
    tags: base.tags,
    categoryId: base.categoryId,
    nodes: nodes.map(flowNodeToNode),
    edges: edges.map(flowEdgeToEdge),
  };
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
 * Overlay live run state onto the canvas nodes. Returns a NEW array with new
 * `data` objects only where the run state changed a node, leaving identity
 * stable for untouched nodes so reactflow can bail out of re-rendering them.
 * When `runNodes` is undefined (no active run) every node is stripped of any
 * stale `runStatus` so the canvas returns to its static appearance.
 */
export function applyRunStateToNodes(
  nodes: WorkflowFlowNode[],
  runNodes: Record<string, NodeRunSnapshot> | undefined,
): WorkflowFlowNode[] {
  return nodes.map((node) => {
    const snapshot = runNodes?.[node.id];
    const nextStatus = snapshot?.status;
    const nextExit = snapshot?.exitCode;
    if (node.data.runStatus === nextStatus && node.data.exitCode === nextExit) {
      return node;
    }
    return {
      ...node,
      data: { ...node.data, runStatus: nextStatus, exitCode: nextExit },
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
 * Whether a node exposes a free single `out` source port — i.e. it is a
 * `start` or `command` node with no edge already leaving its `out` handle.
 * `condition` nodes are deliberately EXCLUDED: their `then`/`else` branches
 * are too ambiguous to auto-pick, so they are only wired manually or via
 * edge-insertion. `end` nodes have no source port.
 */
function hasFreeOutPort(
  node: WorkflowFlowNode,
  edges: WorkflowFlowEdge[],
): boolean {
  const kind = node.type ?? node.data.kind;
  if (kind !== "start" && kind !== "command") return false;
  return !edges.some(
    (e) =>
      e.source === node.id &&
      (e.sourceHandle === "out" ||
        e.sourceHandle === null ||
        e.sourceHandle === undefined),
  );
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
    sourceHandle: "out",
  };
  return {
    nodes: [...shiftedNodes, placedNode],
    edges: [...remaining, intoNew, outOfNew],
  };
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
