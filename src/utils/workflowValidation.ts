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
 * Like {@link reachableFrom}, but the walk does not expand past `stopId`
 * (the stop node is included in the result, its successors are not). Used to
 * collect the nodes that live INSIDE a parallel branch up to — but not beyond
 * — its bound join barrier. When `stopId` is undefined the walk is unbounded.
 */
function reachableUntil(
  startId: string,
  adjacency: Map<string, string[]>,
  stopId: string | undefined,
): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [startId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    if (id === stopId) continue;
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
 *   - every `parallel` fork has at least one `branch:<n>` exit (error — the
 *     engine fails with ParallelNoBranches otherwise)
 *   - a `parallel`'s `joinNodeId`, when set, references an existing node (error)
 *     of kind `join` (error); for a bound join, every branch can reach it
 *     (error — else the engine faults with BranchEndedBeforeJoin); and a bound
 *     join has an outgoing `out` edge (error — else NoOutgoingEdge at runtime)
 *   - a `data` node that assigns variables inside a parallel branch (warning —
 *     the writes are dropped at the join per the read-only-snapshot rule)
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
    } else if (node.kind === "parallel") {
      // A fork needs at least one `branch:<n>` exit, else the engine fails
      // with ParallelNoBranches. Min is 1 (one branch = a transparent fork),
      // not 2 — per the approved decision. `outgoing` already excludes edges
      // whose source node is missing, and dangling targets are reported above.
      const hasBranch = outgoing.some((e) => e.branch.startsWith("branch:"));
      if (!hasBranch) {
        problems.push({
          key: "editor.validation.parallelNoBranches",
          params: { label: node.label ?? node.id },
          severity: "error",
        });
      }

      // A bound join must reference an existing `join` node. When absent, the
      // fork has no explicit barrier (each branch ends at its own `end`) — not
      // an error.
      const joinId = node.joinNodeId;
      if (joinId !== undefined && joinId !== "") {
        const joinNode = nodeById.get(joinId);
        if (joinNode === undefined) {
          problems.push({
            key: "editor.validation.parallelJoinMissing",
            params: { label: node.label ?? node.id },
            severity: "error",
          });
        } else if (joinNode.kind !== "join") {
          problems.push({
            key: "editor.validation.parallelJoinNotJoin",
            params: { label: node.label ?? node.id },
            severity: "error",
          });
        }
      }
    }
  }

  // Parallel-fork data-flow rules (warnings). Both need a graph walk, so we
  // build adjacency once here, from valid edges only (dangling ones are
  // reported above and must not steer the traversal). The same adjacency is
  // reused for end reachability below.
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    const list = adjacency.get(edge.source) ?? [];
    list.push(edge.target);
    adjacency.set(edge.source, list);
  }

  for (const node of graph.nodes) {
    if (node.kind !== "parallel") continue;
    const joinId = node.joinNodeId;
    const boundJoin =
      joinId !== undefined && joinId !== "" && nodeById.get(joinId)?.kind === "join"
        ? joinId
        : undefined;

    // The set of branch entry nodes (targets of this fork's `branch:<n>`
    // edges that still exist).
    const branchTargets = graph.edges
      .filter(
        (e) =>
          e.source === node.id &&
          e.branch.startsWith("branch:") &&
          nodeById.has(e.target),
      )
      .map((e) => e.target);

    // R2 reachability (ERROR): when a join is explicitly bound, every branch
    // must be able to reach it, else that branch dead-ends before the barrier.
    // At runtime the engine now FAULTS (`BranchEndedBeforeJoin`) when a bound
    // branch reaches an `end` instead of its join, so this must BLOCK Run, not
    // merely warn. Only checked for a real bound join (the `missing`/`notJoin`
    // errors above cover the other cases), so it cannot fire as a false
    // positive on the unbound-fork pattern (branches ending at their own `end`).
    if (boundJoin !== undefined) {
      const everyBranchReachesJoin = branchTargets.every((target) =>
        reachableFrom(target, adjacency).has(boundJoin),
      );
      if (branchTargets.length > 0 && !everyBranchReachesJoin) {
        problems.push({
          key: "editor.validation.parallelJoinUnreachable",
          params: { label: node.label ?? node.id },
          severity: "error",
        });
      }
    }

    // R1 vars-discarded (warning): a `data` node that assigns variables while
    // it sits INSIDE one of this fork's branches has its writes dropped at the
    // join (vars are a read-only snapshot per branch). "Inside a branch" =
    // reachable from a branch entry, but stopping the walk at the bound join so
    // nodes AFTER the barrier (back on the main path) are not falsely flagged.
    // With no bound join the branches run to their own `end`, so the whole
    // downstream of each branch counts as inside.
    const insideBranch = new Set<string>();
    for (const target of branchTargets) {
      for (const id of reachableUntil(target, adjacency, boundJoin)) {
        insideBranch.add(id);
      }
    }
    for (const inner of graph.nodes) {
      if (
        inner.kind === "data" &&
        insideBranch.has(inner.id) &&
        (inner.data?.length ?? 0) > 0
      ) {
        problems.push({
          key: "editor.validation.parallelVarsDiscarded",
          params: { label: inner.label ?? inner.id },
          severity: "warning",
        });
      }
    }
  }

  // A bound join (referenced by some parallel's `joinNodeId`) MUST have an
  // outgoing `out` edge: after all branches converge, the engine resumes the
  // parent path from the join's single `out` edge (`continue_after_join`). With
  // no such edge the run dies mid-flight with `NoOutgoingEdge`, so this is a
  // hard ERROR. Only bound joins are checked — an unbound/orphan join is a
  // separate concern and must not be over-flagged here.
  const boundJoinIds = new Set<string>();
  for (const node of graph.nodes) {
    if (node.kind !== "parallel") continue;
    const joinId = node.joinNodeId;
    if (
      joinId !== undefined &&
      joinId !== "" &&
      nodeById.get(joinId)?.kind === "join"
    ) {
      boundJoinIds.add(joinId);
    }
  }
  for (const joinId of boundJoinIds) {
    const join = nodeById.get(joinId);
    const hasOut = graph.edges.some(
      (e) => e.source === joinId && e.branch === "out",
    );
    if (!hasOut) {
      problems.push({
        key: "editor.validation.joinNoOutgoing",
        params: { label: join?.label ?? joinId },
        severity: "error",
      });
    }
  }

  // End reachability. Reuses the adjacency built above (valid edges only), so
  // the traversal cannot follow a dangling edge. Note this adjacency already
  // includes every `branch:<n>` fork exit, so end-reachability correctly
  // follows parallel branches.
  const endNodes = graph.nodes.filter((n) => n.kind === "end");
  if (endNodes.length === 0) {
    problems.push({ key: "editor.validation.noEnd", severity: "error" });
  } else if (singleStart !== undefined) {
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
