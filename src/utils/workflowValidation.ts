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

  // Command-running kinds must reference a command. `data` / `loop` run no
  // command; `start` / `end` never do.
  const COMMAND_KINDS = new Set(["command", "condition", "switch", "try"]);
  for (const node of graph.nodes) {
    if (
      COMMAND_KINDS.has(node.kind) &&
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

  // Branching nodes should wire every exit they can take, else that branch
  // dead-ends at run time. We only count edges whose source node still
  // exists, so a dangling edge does not mask a missing branch (it is already
  // reported above). All branch-completeness problems are warnings: a
  // half-wired branch runs but the missing path stops the workflow.
  for (const node of graph.nodes) {
    const outgoing = graph.edges.filter((e) => e.source === node.id);
    const has = (branch: string): boolean =>
      outgoing.some((e) => e.branch === branch);

    if (node.kind === "condition") {
      if (!has("then") || !has("else")) {
        problems.push({
          key: "editor.validation.conditionBranches",
          params: { label: node.label ?? node.id },
          severity: "warning",
        });
      }
    } else if (node.kind === "switch") {
      // Every declared case needs its `case:<id>` edge, and a `default` edge
      // is required (the runner errors with NoMatchingCase otherwise).
      const cases = node.cases ?? [];
      const everyCaseWired = cases.every((c) => has(`case:${c.id}`));
      if (!everyCaseWired || !has("default")) {
        problems.push({
          key: "editor.validation.switchBranches",
          params: { label: node.label ?? node.id },
          severity: "warning",
        });
      }
    } else if (node.kind === "loop") {
      if (!has("body") || !has("done")) {
        problems.push({
          key: "editor.validation.loopBranches",
          params: { label: node.label ?? node.id },
          severity: "warning",
        });
      }
      // A loop with neither/both of count & while is a hard misconfiguration
      // (the runner rejects it with LoopMisconfigured).
      const loop = node.loop;
      const hasCount = loop?.count !== undefined;
      const hasWhile = loop?.while !== undefined;
      if (loop === undefined || hasCount === hasWhile) {
        problems.push({
          key: "editor.validation.loopConfig",
          params: { label: node.label ?? node.id },
          severity: "error",
        });
      }
    } else if (node.kind === "try") {
      if (!has("ok") || !has("catch")) {
        problems.push({
          key: "editor.validation.tryBranches",
          params: { label: node.label ?? node.id },
          severity: "warning",
        });
      }
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
