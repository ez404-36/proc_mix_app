import { describe, expect, it } from "vitest";
import type { WorkflowEdge, WorkflowNode } from "../types";
import { validateWorkflow } from "./workflowValidation";

function node(
  id: string,
  kind: WorkflowNode["kind"],
  extra: Partial<WorkflowNode> = {},
): WorkflowNode {
  return { id, kind, position: { x: 0, y: 0 }, ...extra };
}

function edge(
  id: string,
  source: string,
  target: string,
  branch: WorkflowEdge["branch"] = "out",
): WorkflowEdge {
  return { id, source, target, branch };
}

/** A minimal valid graph: start → command → end. */
function validGraph(): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  return {
    nodes: [
      node("s", "start"),
      node("c", "command", { commandId: "cmd1" }),
      node("e", "end"),
    ],
    edges: [edge("e1", "s", "c"), edge("e2", "c", "e")],
  };
}

function keys(result: ReturnType<typeof validateWorkflow>): string[] {
  return result.problems.map((p) => p.key);
}

describe("validateWorkflow happy path", () => {
  it("returns no problems and runnable for a complete graph", () => {
    const result = validateWorkflow(validGraph());
    expect(result.problems).toEqual([]);
    expect(result.runnable).toBe(true);
  });

  it("accepts a condition with both branches wired", () => {
    const graph = {
      nodes: [
        node("s", "start"),
        node("c", "condition", { commandId: "cmd1" }),
        node("e1", "end"),
        node("e2", "end"),
      ],
      edges: [
        edge("x0", "s", "c"),
        edge("x1", "c", "e1", "then"),
        edge("x2", "c", "e2", "else"),
      ],
    };
    expect(validateWorkflow(graph).problems).toEqual([]);
  });
});

describe("validateWorkflow start node", () => {
  it("flags a missing start as an error", () => {
    const graph = validGraph();
    graph.nodes = graph.nodes.filter((n) => n.kind !== "start");
    graph.edges = graph.edges.filter((e) => e.source !== "s");
    const result = validateWorkflow(graph);
    expect(keys(result)).toContain("editor.validation.noStart");
    expect(result.runnable).toBe(false);
  });

  it("flags multiple start nodes as an error with the count", () => {
    const graph = validGraph();
    graph.nodes.push(node("s2", "start"));
    const result = validateWorkflow(graph);
    const problem = result.problems.find(
      (p) => p.key === "editor.validation.multipleStart",
    );
    expect(problem?.params?.count).toBe(2);
    expect(result.runnable).toBe(false);
  });
});

describe("validateWorkflow command binding", () => {
  it("flags a command node with no commandId", () => {
    const graph = validGraph();
    const cmd = graph.nodes.find((n) => n.id === "c");
    if (cmd) cmd.commandId = undefined;
    const result = validateWorkflow(graph);
    expect(keys(result)).toContain("editor.validation.nodeMissingCommand");
    expect(result.runnable).toBe(false);
  });

  it("flags a condition node with an empty commandId and uses the label", () => {
    const graph = {
      nodes: [
        node("s", "start"),
        node("c", "condition", { commandId: "", label: "Check" }),
        node("e", "end"),
      ],
      edges: [edge("e1", "s", "c"), edge("e2", "c", "e", "then")],
    };
    const result = validateWorkflow(graph);
    const problem = result.problems.find(
      (p) => p.key === "editor.validation.nodeMissingCommand",
    );
    expect(problem?.params?.label).toBe("Check");
  });
});

describe("validateWorkflow edges", () => {
  it("flags a dangling edge as an error", () => {
    const graph = validGraph();
    graph.edges.push(edge("bad", "c", "ghost"));
    const result = validateWorkflow(graph);
    const problem = result.problems.find(
      (p) => p.key === "editor.validation.danglingEdge",
    );
    expect(problem?.params?.id).toBe("bad");
    expect(result.runnable).toBe(false);
  });
});

describe("validateWorkflow end reachability", () => {
  it("flags the absence of any end node", () => {
    const graph = {
      nodes: [node("s", "start"), node("c", "command", { commandId: "x" })],
      edges: [edge("e1", "s", "c")],
    };
    const result = validateWorkflow(graph);
    expect(keys(result)).toContain("editor.validation.noEnd");
    expect(result.runnable).toBe(false);
  });

  it("warns (but stays runnable) when an end exists but is unreachable", () => {
    const graph = {
      nodes: [
        node("s", "start"),
        node("c", "command", { commandId: "x" }),
        node("e", "end"),
      ],
      // start connects to the command, but nothing reaches the end node.
      edges: [edge("e1", "s", "c")],
    };
    const result = validateWorkflow(graph);
    expect(keys(result)).toContain("editor.validation.endUnreachable");
    const endProblem = result.problems.find(
      (p) => p.key === "editor.validation.endUnreachable",
    );
    expect(endProblem?.severity).toBe("warning");
    expect(result.runnable).toBe(true);
  });

  it("does not check reachability when there is no single start", () => {
    const graph = {
      nodes: [node("c", "command", { commandId: "x" }), node("e", "end")],
      edges: [],
    };
    const result = validateWorkflow(graph);
    // noStart is reported, but endUnreachable is NOT (no start to walk from).
    expect(keys(result)).toContain("editor.validation.noStart");
    expect(keys(result)).not.toContain("editor.validation.endUnreachable");
  });
});

describe("validateWorkflow condition branches", () => {
  it("warns when a condition is missing the else branch", () => {
    const graph = {
      nodes: [
        node("s", "start"),
        node("c", "condition", { commandId: "x", label: "Q" }),
        node("e", "end"),
      ],
      edges: [edge("e1", "s", "c"), edge("e2", "c", "e", "then")],
    };
    const result = validateWorkflow(graph);
    const problem = result.problems.find(
      (p) => p.key === "editor.validation.conditionBranches",
    );
    expect(problem?.severity).toBe("warning");
    expect(problem?.params?.label).toBe("Q");
    // A missing branch is only a warning, so the graph is still runnable.
    expect(result.runnable).toBe(true);
  });
});

describe("validateWorkflow advanced-node command binding", () => {
  it.each(["switch", "try"] as const)(
    "errors when a %s node has no command",
    (kind) => {
      const graph = {
        nodes: [node("s", "start"), node("x", kind), node("e", "end")],
        edges: [edge("e1", "s", "x")],
      };
      const result = validateWorkflow(graph);
      expect(keys(result)).toContain("editor.validation.nodeMissingCommand");
      expect(result.runnable).toBe(false);
    },
  );

  it.each(["loop", "data"] as const)(
    "does not require a command for a %s node",
    (kind) => {
      const extra =
        kind === "loop" ? { loop: { count: 1, maxIterations: 10 } } : {};
      const graph = {
        nodes: [node("s", "start"), node("x", kind, extra), node("e", "end")],
        edges: [edge("e1", "s", "x")],
      };
      const result = validateWorkflow(graph);
      expect(keys(result)).not.toContain("editor.validation.nodeMissingCommand");
    },
  );
});

describe("validateWorkflow switch branches", () => {
  it("warns when a declared case or the default branch is unwired", () => {
    const graph = {
      nodes: [
        node("s", "start"),
        node("sw", "switch", {
          commandId: "x",
          label: "Pick",
          cases: [
            {
              id: "a",
              condition: { subject: { kind: "exitCode" }, op: "eq", value: "0" },
            },
          ],
        }),
        node("e", "end"),
      ],
      // Wire the case but NOT the default → warning.
      edges: [edge("e1", "s", "sw"), edge("e2", "sw", "e", "case:a")],
    };
    const result = validateWorkflow(graph);
    const problem = result.problems.find(
      (p) => p.key === "editor.validation.switchBranches",
    );
    expect(problem?.severity).toBe("warning");
    expect(result.runnable).toBe(true);
  });

  it("is clean when every case and the default are wired", () => {
    const graph = {
      nodes: [
        node("s", "start"),
        node("sw", "switch", {
          commandId: "x",
          cases: [
            {
              id: "a",
              condition: { subject: { kind: "exitCode" }, op: "eq", value: "0" },
            },
          ],
        }),
        node("e1n", "end"),
        node("e2n", "end"),
      ],
      edges: [
        edge("e1", "s", "sw"),
        edge("e2", "sw", "e1n", "case:a"),
        edge("e3", "sw", "e2n", "default"),
      ],
    };
    const result = validateWorkflow(graph);
    expect(keys(result)).not.toContain("editor.validation.switchBranches");
  });
});

describe("validateWorkflow loop config + branches", () => {
  it("errors when a loop sets neither count nor while", () => {
    const graph = {
      nodes: [
        node("s", "start"),
        node("lp", "loop", { label: "L" }),
        node("e", "end"),
      ],
      edges: [
        edge("e1", "s", "lp"),
        edge("e2", "lp", "e", "body"),
        edge("e3", "lp", "e", "done"),
      ],
    };
    const result = validateWorkflow(graph);
    expect(keys(result)).toContain("editor.validation.loopConfig");
    expect(result.runnable).toBe(false);
  });

  it("errors when a loop sets BOTH count and while", () => {
    const graph = {
      nodes: [
        node("s", "start"),
        node("lp", "loop", {
          loop: {
            count: 2,
            while: { subject: { kind: "exitCode" }, op: "eq", value: "0" },
            maxIterations: 10,
          },
        }),
        node("e", "end"),
      ],
      edges: [
        edge("e1", "s", "lp"),
        edge("e2", "lp", "e", "body"),
        edge("e3", "lp", "e", "done"),
      ],
    };
    const result = validateWorkflow(graph);
    expect(keys(result)).toContain("editor.validation.loopConfig");
  });

  it("warns when body or done branch is missing", () => {
    const graph = {
      nodes: [
        node("s", "start"),
        node("lp", "loop", { loop: { count: 1, maxIterations: 10 } }),
        node("e", "end"),
      ],
      edges: [edge("e1", "s", "lp"), edge("e2", "lp", "e", "body")],
    };
    const result = validateWorkflow(graph);
    expect(keys(result)).toContain("editor.validation.loopBranches");
  });
});

describe("validateWorkflow try branches", () => {
  it("warns when ok or catch branch is missing", () => {
    const graph = {
      nodes: [
        node("s", "start"),
        node("tr", "try", { commandId: "x" }),
        node("e", "end"),
      ],
      edges: [edge("e1", "s", "tr"), edge("e2", "tr", "e", "ok")],
    };
    const result = validateWorkflow(graph);
    const problem = result.problems.find(
      (p) => p.key === "editor.validation.tryBranches",
    );
    expect(problem?.severity).toBe("warning");
    expect(result.runnable).toBe(true);
  });
});

describe("validateWorkflow parallel branches", () => {
  it("errors when a parallel node has no branch edges", () => {
    const graph = {
      nodes: [
        node("s", "start"),
        node("p", "parallel", { label: "Fork" }),
        node("e", "end"),
      ],
      // The parallel has only its incoming edge — no `branch:<n>` exit.
      edges: [edge("e1", "s", "p")],
    };
    const result = validateWorkflow(graph);
    const problem = result.problems.find(
      (p) => p.key === "editor.validation.parallelNoBranches",
    );
    expect(problem?.severity).toBe("error");
    expect(problem?.params?.label).toBe("Fork");
    expect(result.runnable).toBe(false);
  });

  it("accepts a parallel with a single branch edge", () => {
    const graph = {
      nodes: [
        node("s", "start"),
        node("p", "parallel"),
        node("c", "command", { commandId: "x" }),
        node("e", "end"),
      ],
      edges: [
        edge("e1", "s", "p"),
        edge("e2", "p", "c", "branch:0"),
        edge("e3", "c", "e"),
      ],
    };
    const result = validateWorkflow(graph);
    expect(keys(result)).not.toContain(
      "editor.validation.parallelNoBranches",
    );
    expect(result.runnable).toBe(true);
  });
});

describe("validateWorkflow parallel join binding", () => {
  it("errors when joinNodeId points at a missing node", () => {
    const graph = {
      nodes: [
        node("s", "start"),
        node("p", "parallel", { label: "Fork", joinNodeId: "ghost" }),
        node("c", "command", { commandId: "x" }),
        node("e", "end"),
      ],
      edges: [
        edge("e1", "s", "p"),
        edge("e2", "p", "c", "branch:0"),
        edge("e3", "c", "e"),
      ],
    };
    const result = validateWorkflow(graph);
    const problem = result.problems.find(
      (p) => p.key === "editor.validation.parallelJoinMissing",
    );
    expect(problem?.severity).toBe("error");
    expect(result.runnable).toBe(false);
  });

  it("errors when joinNodeId points at a non-join node", () => {
    const graph = {
      nodes: [
        node("s", "start"),
        node("p", "parallel", { joinNodeId: "c" }),
        node("c", "command", { commandId: "x" }),
        node("e", "end"),
      ],
      edges: [
        edge("e1", "s", "p"),
        edge("e2", "p", "c", "branch:0"),
        edge("e3", "c", "e"),
      ],
    };
    const result = validateWorkflow(graph);
    const problem = result.problems.find(
      (p) => p.key === "editor.validation.parallelJoinNotJoin",
    );
    expect(problem?.severity).toBe("error");
    expect(result.runnable).toBe(false);
  });

  it("accepts a parallel bound to a real join reachable from every branch", () => {
    const graph = {
      nodes: [
        node("s", "start"),
        node("p", "parallel", { joinNodeId: "j" }),
        node("c", "command", { commandId: "x" }),
        node("j", "join"),
        node("e", "end"),
      ],
      edges: [
        edge("e1", "s", "p"),
        edge("e2", "p", "c", "branch:0"),
        edge("e3", "c", "j"),
        edge("e4", "j", "e"),
      ],
    };
    const result = validateWorkflow(graph);
    expect(keys(result)).not.toContain(
      "editor.validation.parallelJoinMissing",
    );
    expect(keys(result)).not.toContain(
      "editor.validation.parallelJoinNotJoin",
    );
    expect(keys(result)).not.toContain(
      "editor.validation.parallelJoinUnreachable",
    );
    expect(result.runnable).toBe(true);
  });

  it("errors when a bound join is unreachable from a branch", () => {
    const graph = {
      nodes: [
        node("s", "start"),
        node("p", "parallel", { label: "Fork", joinNodeId: "j" }),
        node("c", "command", { commandId: "x" }),
        node("j", "join"),
        node("e", "end"),
      ],
      // The branch dead-ends at `c` and never reaches the bound join `j`. At
      // runtime the engine now faults (BranchEndedBeforeJoin), so this must
      // BLOCK Run, not merely warn.
      edges: [
        edge("e1", "s", "p"),
        edge("e2", "p", "c", "branch:0"),
        edge("e4", "j", "e"),
      ],
    };
    const result = validateWorkflow(graph);
    const problem = result.problems.find(
      (p) => p.key === "editor.validation.parallelJoinUnreachable",
    );
    expect(problem?.severity).toBe("error");
    expect(problem?.params?.label).toBe("Fork");
    // An error blocks Run.
    expect(result.runnable).toBe(false);
  });

  it("errors when a bound join has no outgoing edge", () => {
    const graph = {
      nodes: [
        node("s", "start"),
        node("p", "parallel", { joinNodeId: "j" }),
        node("c", "command", { commandId: "x" }),
        node("j", "join", { label: "Sync" }),
        node("e", "end"),
      ],
      // Every branch reaches the join, but the join has no `out` edge — the
      // engine would die with NoOutgoingEdge resuming the parent path.
      edges: [
        edge("e1", "s", "p"),
        edge("e2", "p", "c", "branch:0"),
        edge("e3", "c", "j"),
      ],
    };
    const result = validateWorkflow(graph);
    const problem = result.problems.find(
      (p) => p.key === "editor.validation.joinNoOutgoing",
    );
    expect(problem?.severity).toBe("error");
    expect(problem?.params?.label).toBe("Sync");
    expect(result.runnable).toBe(false);
  });

  it("does not flag a bound join that has an out edge and is reachable from all branches", () => {
    const graph = {
      nodes: [
        node("s", "start"),
        node("p", "parallel", { joinNodeId: "j" }),
        node("a", "command", { commandId: "x" }),
        node("b", "command", { commandId: "y" }),
        node("j", "join"),
        node("e", "end"),
      ],
      edges: [
        edge("e1", "s", "p"),
        edge("e2", "p", "a", "branch:0"),
        edge("e3", "p", "b", "branch:1"),
        edge("e4", "a", "j"),
        edge("e5", "b", "j"),
        edge("e6", "j", "e"),
      ],
    };
    const result = validateWorkflow(graph);
    expect(keys(result)).not.toContain(
      "editor.validation.parallelJoinUnreachable",
    );
    expect(keys(result)).not.toContain("editor.validation.joinNoOutgoing");
    expect(result.runnable).toBe(true);
  });
});

describe("validateWorkflow end reachability through a fork", () => {
  it("treats the end as reachable when the only path runs through fork branches", () => {
    const graph = {
      nodes: [
        node("s", "start"),
        node("p", "parallel", { joinNodeId: "j" }),
        node("a", "command", { commandId: "x" }),
        node("b", "command", { commandId: "y" }),
        node("j", "join"),
        node("e", "end"),
      ],
      edges: [
        edge("e1", "s", "p"),
        edge("e2", "p", "a", "branch:0"),
        edge("e3", "p", "b", "branch:1"),
        edge("e4", "a", "j"),
        edge("e5", "b", "j"),
        edge("e6", "j", "e"),
      ],
    };
    const result = validateWorkflow(graph);
    expect(keys(result)).not.toContain("editor.validation.endUnreachable");
    expect(result.runnable).toBe(true);
  });
});

describe("validateWorkflow vars discarded inside a branch", () => {
  it("warns for a data node with assignments inside a parallel branch", () => {
    const graph = {
      nodes: [
        node("s", "start"),
        node("p", "parallel", { joinNodeId: "j" }),
        node("d", "data", {
          label: "Set",
          data: [{ name: "v", value: "1" }],
        }),
        node("j", "join"),
        node("e", "end"),
      ],
      edges: [
        edge("e1", "s", "p"),
        edge("e2", "p", "d", "branch:0"),
        edge("e3", "d", "j"),
        edge("e4", "j", "e"),
      ],
    };
    const result = validateWorkflow(graph);
    const problem = result.problems.find(
      (p) => p.key === "editor.validation.parallelVarsDiscarded",
    );
    expect(problem?.severity).toBe("warning");
    expect(problem?.params?.label).toBe("Set");
    expect(result.runnable).toBe(true);
  });

  it("does not warn for a data node after the join (back on the main path)", () => {
    const graph = {
      nodes: [
        node("s", "start"),
        node("p", "parallel", { joinNodeId: "j" }),
        node("c", "command", { commandId: "x" }),
        node("j", "join"),
        node("d", "data", { data: [{ name: "v", value: "1" }] }),
        node("e", "end"),
      ],
      edges: [
        edge("e1", "s", "p"),
        edge("e2", "p", "c", "branch:0"),
        edge("e3", "c", "j"),
        edge("e4", "j", "d"),
        edge("e5", "d", "e"),
      ],
    };
    const result = validateWorkflow(graph);
    expect(keys(result)).not.toContain(
      "editor.validation.parallelVarsDiscarded",
    );
  });

  it("does not warn for a data node on a purely sequential path", () => {
    const graph = {
      nodes: [
        node("s", "start"),
        node("d", "data", { data: [{ name: "v", value: "1" }] }),
        node("e", "end"),
      ],
      edges: [edge("e1", "s", "d"), edge("e2", "d", "e")],
    };
    const result = validateWorkflow(graph);
    expect(keys(result)).not.toContain(
      "editor.validation.parallelVarsDiscarded",
    );
  });
});
