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
