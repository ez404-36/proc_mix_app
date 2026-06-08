// Pure structural validation for a workflow graph, run before Save (warn)
// and Run (block). Operates on the persisted `WorkflowNode` / `WorkflowEdge`
// shape — i.e. the output of `flowToWorkflow` — so it is fully unit-testable
// without a canvas. Each problem carries a stable i18n `key` (plus optional
// interpolation `params`) rather than a baked English string, so the canvas
// owns localization and this module stays presentation-free.

import type { WorkflowEdge, WorkflowNode } from "../types";

/**
 * A single validation problem. `key` is an i18next key under
 * `editor.validation.*`; `params` are interpolation values (e.g. a node
 * label). `severity` distinguishes a hard `error` (blocks Run) from a soft
 * `warning` (allowed on Save of a draft).
 */
export interface WorkflowProblem {
  key: string;
  params?: Record<string, string | number>;
  severity: "error" | "warning";
}

export interface WorkflowValidationResult {
  problems: WorkflowProblem[];
  /** True when there is no `error`-severity problem (Run is allowed). */
  runnable: boolean;
}

interface ValidatableGraph {
  nodes: ReadonlyArray<WorkflowNode>;
  edges: ReadonlyArray<WorkflowEdge>;
}

/**
 * Walk the graph from the unique start node and return the set of reachable
 * node ids. Cycle-safe via a visited set. Used to decide whether at least
 * one `end` node is reachable.
 */
function reachableFrom(
  startId: string,
  adjacency: Map<string, string[]>,
): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [startId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const next = adjacency.get(id);
    if (next) {
      for (const target of next) stack.push(target);
    }
  }
  return seen;
}

/**
 * Validate a workflow graph. Rules (each maps to one `editor.validation.*`
 * key):
 *   - exactly one `start` node (error if zero or more than one)
 *   - every `command` / `condition` node references a `commandId` (error)
 *   - every edge connects two existing nodes — no dangling source/target
 *     (error)
 *   - at least one `end` node, and at least one reachable from start (error
 *     when no end exists; warning when an end exists but is unreachable)
 *   - every `condition` node has BOTH a `then` and an `else` outgoing edge
 *     (warning — a half-wired condition runs but the missing branch dead-ends)
 *
 * The happy path returns `{ problems: [], runnable: true }`.
 */
export function validateWorkflow(
  graph: ValidatableGraph,
): WorkflowValidationResult {
  const problems: WorkflowProblem[] = [];
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  const startNodes = graph.nodes.filter((n) => n.kind === "start");
  const singleStart =
    startNodes.length === 1 ? startNodes[0] : undefined;
  if (startNodes.length === 0) {
    problems.push({ key: "editor.validation.noStart", severity: "error" });
  } else if (startNodes.length > 1) {
    problems.push({
      key: "editor.validation.multipleStart",
      params: { count: startNodes.length },
      severity: "error",
    });
  }

  for (const node of graph.nodes) {
    if (
      (node.kind === "command" || node.kind === "condition") &&
      (node.commandId === undefined || node.commandId === "")
    ) {
      problems.push({
        key: "editor.validation.nodeMissingCommand",
        params: { label: node.label ?? node.id },
        severity: "error",
      });
    }
  }

  // Dangling edges: a source or target id with no matching node. This is a
  // data-integrity error rather than something to silently drop on save.
  for (const edge of graph.edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) {
      problems.push({
        key: "editor.validation.danglingEdge",
        params: { id: edge.id },
        severity: "error",
      });
    }
  }

  // condition nodes should wire both branches. We only count edges whose
  // source node still exists, so a dangling edge does not mask a missing
  // branch (it is already reported above).
  for (const node of graph.nodes) {
    if (node.kind !== "condition") continue;
    const outgoing = graph.edges.filter((e) => e.source === node.id);
    const hasThen = outgoing.some((e) => e.branch === "then");
    const hasElse = outgoing.some((e) => e.branch === "else");
    if (!hasThen || !hasElse) {
      problems.push({
        key: "editor.validation.conditionBranches",
        params: { label: node.label ?? node.id },
        severity: "warning",
      });
    }
  }

  // End reachability. Build adjacency only from edges whose endpoints exist
  // so the traversal cannot follow a dangling edge.
  const endNodes = graph.nodes.filter((n) => n.kind === "end");
  if (endNodes.length === 0) {
    problems.push({ key: "editor.validation.noEnd", severity: "error" });
  } else if (singleStart !== undefined) {
    const adjacency = new Map<string, string[]>();
    for (const edge of graph.edges) {
      if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
      const list = adjacency.get(edge.source) ?? [];
      list.push(edge.target);
      adjacency.set(edge.source, list);
    }
    const reachable = reachableFrom(singleStart.id, adjacency);
    const anyEndReachable = endNodes.some((n) => reachable.has(n.id));
    if (!anyEndReachable) {
      problems.push({
        key: "editor.validation.endUnreachable",
        severity: "warning",
      });
    }
  }

  const runnable = !problems.some((p) => p.severity === "error");
  return { problems, runnable };
}
