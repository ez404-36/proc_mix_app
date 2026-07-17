// Value-source options for a command-bearing node's individual command
// variables (Feature 4). A node variable can draw its value from:
//   - manual entry (a literal the author types here),
//   - a run-time prompt ("ввести при запуске"),
//   - the previous node's output (raw stdout, output-schema fields, exit code,
//     and the kind-specific specials — reusing `dataSourceOptions`),
//   - a variable produced by a `data` node that is GUARANTEED to run before
//     this node (a graph dominator — see `dominatingDataNodeVariableNames`).
//
// This mirrors the `data`-assignment source picker but adds the `atRun` and
// `dataVar` options and always offers manual entry first. Pure / testable.

import type { Command, DataSource } from "../types";
import { dataSourceOptions, type DataSourceOption } from "./dataSourceOptions";
import type { WorkflowFlowEdge, WorkflowFlowNode } from "./workflowGraph";

/**
 * Whether `start` can still reach `target` when `blocked` is removed from the
 * graph. Used to decide domination: if `target` becomes UNREACHABLE without
 * `blocked`, then every path to `target` passed through `blocked`, so `blocked`
 * is guaranteed to run before `target`. Cycle-safe.
 */
function reachableWithoutNode(
  edges: ReadonlyArray<WorkflowFlowEdge>,
  startId: string,
  targetId: string,
  blockedId: string,
): boolean {
  if (startId === blockedId) return false;
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.source === blockedId || edge.target === blockedId) continue;
    const list = outgoing.get(edge.source);
    if (list === undefined) outgoing.set(edge.source, [edge.target]);
    else list.push(edge.target);
  }
  const stack = [startId];
  const visited = new Set<string>([startId]);
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === targetId) return true;
    for (const next of outgoing.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      stack.push(next);
    }
  }
  return false;
}

/**
 * Distinct variable names assigned by every `data` node that is GUARANTEED to
 * execute before `currentNodeId` — i.e. every `data` node that DOMINATES the
 * current node (lies on every path from `start` to it). A `data` node that is
 * only on one branch, parallel to, or downstream of the current node is
 * excluded, because its variable may not be set when the current node runs.
 *
 * Names are returned in graph order (start→… via the edge list's node order),
 * deduped. Requires exactly one `start` node; with none, nothing qualifies.
 */
export function dominatingDataNodeVariableNames(
  nodes: ReadonlyArray<WorkflowFlowNode>,
  edges: ReadonlyArray<WorkflowFlowEdge>,
  currentNodeId: string,
): string[] {
  const start = nodes.find((n) => n.data.kind === "start");
  if (start === undefined) return [];

  const seen = new Set<string>();
  const names: string[] = [];
  for (const node of nodes) {
    if (node.data.kind !== "data") continue;
    if (node.id === currentNodeId) continue;
    // The node dominates the current node iff removing it disconnects the
    // current node from start (every path to current went through it).
    const dominates = !reachableWithoutNode(
      edges,
      start.id,
      currentNodeId,
      node.id,
    );
    if (!dominates) continue;
    for (const assignment of node.data.data ?? []) {
      const name = assignment.name.trim();
      if (name !== "" && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }
  return names;
}

/**
 * The nearest LOOP node (count mode) whose `body` subgraph encloses
 * `currentNodeId` — i.e. `currentNodeId` is reachable by following edges
 * forward from the loop's `body` edge, without re-entering the loop node
 * itself (which would mean crossing back out via its `done`/re-entry point).
 *
 * When several loops' bodies both reach `currentNodeId` (nested loops), the
 * one whose `body` edge is FEWEST hops away wins — nesting is not otherwise
 * disambiguated (there is no per-loop id carried on the `loopItem` source),
 * so only a single "nearest enclosing loop" is ever offered.
 *
 * Returns `undefined` when no loop node's body reaches `currentNodeId` (the
 * node is not inside any loop), so a `loopItem` option is simply not offered.
 */
export function enclosingLoopNodeId(
  nodes: ReadonlyArray<WorkflowFlowNode>,
  edges: ReadonlyArray<WorkflowFlowEdge>,
  currentNodeId: string,
): string | undefined {
  const outgoing = new Map<string, WorkflowFlowEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.source);
    if (list === undefined) outgoing.set(edge.source, [edge]);
    else list.push(edge);
  }

  let bestLoopId: string | undefined;
  let bestDistance = Infinity;

  for (const node of nodes) {
    if (node.data.kind !== "loop") continue;
    const bodyEdge = (outgoing.get(node.id) ?? []).find(
      (e) => e.sourceHandle === "body",
    );
    if (bodyEdge === undefined) continue;

    // BFS forward from the body's entry node, stopping the moment we would
    // re-enter the loop node itself (its outgoing edges — `body` re-entry or
    // `done` exit — are never followed here, since both lie OUTSIDE this
    // traversal of "what the body reaches").
    const distances = new Map<string, number>([[bodyEdge.target, 0]]);
    const queue: string[] = [bodyEdge.target];
    let head = 0;
    while (head < queue.length) {
      const current = queue[head];
      head += 1;
      if (current === node.id) continue; // do not expand past the loop node
      const currentDistance = distances.get(current) ?? 0;
      for (const edge of outgoing.get(current) ?? []) {
        if (distances.has(edge.target)) continue;
        distances.set(edge.target, currentDistance + 1);
        queue.push(edge.target);
      }
    }

    const distance = distances.get(currentNodeId);
    if (distance !== undefined && distance < bestDistance) {
      bestDistance = distance;
      bestLoopId = node.id;
    }
  }

  return bestLoopId;
}

/**
 * Build the value-source options offered for ONE command variable on a
 * command-bearing node, given the node's single resolved predecessor (or null),
 * every node + edge in the graph, and the current node's id.
 *
 * Order: manual entry, run-time prompt, then the predecessor-derived sources
 * (raw output / schema fields / exit code / specials — `schemaOutput` only when
 * the predecessor command declares a schema), then one `dataVar` option per
 * distinct variable from a `data` node guaranteed to run before this node,
 * then — only when this node lies inside a `loop` node's body (see
 * {@link enclosingLoopNodeId}) — the `loopItem` option.
 */
export function variableSourceOptions(
  predecessor: WorkflowFlowNode | null,
  commands: ReadonlyArray<Command>,
  allNodes: ReadonlyArray<WorkflowFlowNode>,
  edges: ReadonlyArray<WorkflowFlowEdge>,
  currentNodeId: string,
): DataSourceOption[] {
  const options: DataSourceOption[] = [
    {
      id: "manual",
      source: { kind: "manual", value: "" },
      labelKey: "editor.inspector.variables.source.manual",
    },
    {
      id: "atRun",
      source: { kind: "atRun" },
      labelKey: "editor.inspector.variables.source.atRun",
    },
  ];

  // Predecessor-derived sources. `dataSourceOptions` already gates
  // `schemaOutput` on the predecessor command actually declaring a schema, and
  // always leads with its own `manual` entry; drop that (we offer manual +
  // atRun above).
  for (const opt of dataSourceOptions(predecessor, commands)) {
    if (opt.id === "manual") continue;
    options.push(opt);
  }

  for (const name of dominatingDataNodeVariableNames(
    allNodes,
    edges,
    currentNodeId,
  )) {
    options.push({
      id: `dataVar:${name}`,
      source: { kind: "dataVar", name },
      labelKey: "editor.inspector.variables.source.dataVar",
      field: name,
    });
  }

  if (enclosingLoopNodeId(allNodes, edges, currentNodeId) !== undefined) {
    options.push({
      id: "loopItem",
      source: { kind: "loopItem" },
      labelKey: "editor.inspector.variables.source.loopItem",
    });
  }

  return options;
}

/** The dropdown option id for a stored variable {@link DataSource}. Inverse of
 * the `id` assigned in {@link variableSourceOptions}. */
export function variableSourceId(source: DataSource): string {
  if (source.kind === "field") return `field:${source.field}`;
  if (source.kind === "dataVar") return `dataVar:${source.name}`;
  return source.kind;
}

/**
 * Build the value-source options offered for a command-bearing node's
 * WORKING DIRECTORY (`WorkflowNode.workingDirSource`), meaningful only when
 * the referenced command has `promptWorkingDir: true`.
 *
 * A directory has no predecessor-output shape (unlike a variable, which can
 * read a prior node's exit code / schema field / etc.), so the vocabulary is
 * deliberately narrower than {@link variableSourceOptions}:
 *   - `none`    → no override; the node inherits the command's own persisted
 *     `workingDir` (or the runtime prompt, if the caller still wants one).
 *     This is the implicit default (`workingDirSource === undefined`).
 *   - `manual`  → a literal path typed on the node (may itself reference
 *     `${var}` — resolved the same way a `data`-node manual value is).
 *   - `atRun`   → prompt the user for a directory when the workflow runs
 *     (reuses the same working-dir prompt modal a direct command run opens).
 *   - `dataVar` → one option per distinct variable from a `data` node
 *     guaranteed to run before this node (same dominance analysis as
 *     {@link variableSourceOptions}).
 */
export function workingDirSourceOptions(
  allNodes: ReadonlyArray<WorkflowFlowNode>,
  edges: ReadonlyArray<WorkflowFlowEdge>,
  currentNodeId: string,
): DataSourceOption[] {
  const options: DataSourceOption[] = [
    {
      id: "none",
      source: { kind: "manual", value: "" },
      labelKey: "editor.inspector.workingDir.source.none",
    },
    {
      id: "manual",
      source: { kind: "manual", value: "" },
      labelKey: "editor.inspector.workingDir.source.manual",
    },
    {
      id: "atRun",
      source: { kind: "atRun" },
      labelKey: "editor.inspector.workingDir.source.atRun",
    },
  ];

  for (const name of dominatingDataNodeVariableNames(
    allNodes,
    edges,
    currentNodeId,
  )) {
    options.push({
      id: `dataVar:${name}`,
      source: { kind: "dataVar", name },
      labelKey: "editor.inspector.workingDir.source.dataVar",
      field: name,
    });
  }

  if (enclosingLoopNodeId(allNodes, edges, currentNodeId) !== undefined) {
    options.push({
      id: "loopItem",
      source: { kind: "loopItem" },
      labelKey: "editor.inspector.workingDir.source.loopItem",
    });
  }

  return options;
}

/**
 * The dropdown option id for a node's stored `workingDirSource` — `"none"`
 * when absent (the implicit default), else the same encoding
 * {@link variableSourceId} uses for `manual` / `atRun` / `dataVar`.
 */
export function workingDirSourceId(source: DataSource | undefined): string {
  if (source === undefined) return "none";
  return variableSourceId(source);
}
