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
 * Build the value-source options offered for ONE command variable on a
 * command-bearing node, given the node's single resolved predecessor (or null),
 * every node + edge in the graph, and the current node's id.
 *
 * Order: manual entry, run-time prompt, then the predecessor-derived sources
 * (raw output / schema fields / exit code / specials — `schemaOutput` only when
 * the predecessor command declares a schema), then one `dataVar` option per
 * distinct variable from a `data` node guaranteed to run before this node.
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

  return options;
}

/** The dropdown option id for a stored variable {@link DataSource}. Inverse of
 * the `id` assigned in {@link variableSourceOptions}. */
export function variableSourceId(source: DataSource): string {
  if (source.kind === "field") return `field:${source.field}`;
  if (source.kind === "dataVar") return `dataVar:${source.name}`;
  return source.kind;
}
