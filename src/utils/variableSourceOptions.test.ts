import { describe, expect, it } from "vitest";
import type { Command } from "../types";
import type { WorkflowFlowEdge, WorkflowFlowNode } from "./workflowGraph";
import {
  dominatingDataNodeVariableNames,
  variableSourceOptions,
} from "./variableSourceOptions";

function node(
  id: string,
  kind: WorkflowFlowNode["data"]["kind"],
  extra: Partial<WorkflowFlowNode["data"]> = {},
): WorkflowFlowNode {
  return {
    id,
    type: kind,
    position: { x: 0, y: 0 },
    data: { kind, ...extra },
  };
}

function dataNode(id: string, varNames: string[]): WorkflowFlowNode {
  return node(id, "data", {
    data: varNames.map((name) => ({
      name,
      value: "",
      source: { kind: "manual", value: "" },
    })),
  });
}

function edge(source: string, target: string): WorkflowFlowEdge {
  return { id: `${source}-${target}`, source, target };
}

function command(id: string, withSchema: boolean): Command {
  return {
    id,
    name: id,
    script: "echo",
    shell: "bash",
    variables: [],
    tags: [],
    favorite: false,
    createdAt: "",
    updatedAt: "",
    outputSchema: withSchema
      ? { pipeline: [{ parser: "regex", fields: [{ name: "f" }] }] }
      : undefined,
  } as unknown as Command;
}

describe("dominatingDataNodeVariableNames", () => {
  it("includes vars from a data node on the single path before the target", () => {
    // start → set(a) → cmd
    const nodes = [
      node("start", "start"),
      dataNode("set", ["a"]),
      node("cmd", "command"),
    ];
    const edges = [edge("start", "set"), edge("set", "cmd")];
    expect(dominatingDataNodeVariableNames(nodes, edges, "cmd")).toEqual(["a"]);
  });

  it("excludes a data node that runs AFTER the target", () => {
    // start → cmd → set(a). `set` runs after `cmd`, so not offered.
    const nodes = [
      node("start", "start"),
      node("cmd", "command"),
      dataNode("set", ["a"]),
    ];
    const edges = [edge("start", "cmd"), edge("cmd", "set")];
    expect(dominatingDataNodeVariableNames(nodes, edges, "cmd")).toEqual([]);
  });

  it("excludes a data node on a PARALLEL branch the target doesn't depend on", () => {
    // start → cond ─then→ set(a) → join
    //              └else→ cmd ───→ join
    // `cmd` is reached via the else branch only; `set` (then branch) is NOT
    // guaranteed before `cmd`.
    const nodes = [
      node("start", "start"),
      node("cond", "condition"),
      dataNode("set", ["a"]),
      node("cmd", "command"),
      node("join", "command"),
    ];
    const edges = [
      edge("start", "cond"),
      edge("cond", "set"),
      edge("set", "join"),
      edge("cond", "cmd"),
      edge("cmd", "join"),
    ];
    expect(dominatingDataNodeVariableNames(nodes, edges, "cmd")).toEqual([]);
  });

  it("includes a data node that dominates the target across a branch merge", () => {
    // start → set(a) → cond ─then→ cmd
    //                       └else→ cmd
    // Every path to `cmd` passes through `set`, so `a` IS offered.
    const nodes = [
      node("start", "start"),
      dataNode("set", ["a"]),
      node("cond", "condition"),
      node("cmd", "command"),
    ];
    const edges = [
      edge("start", "set"),
      edge("set", "cond"),
      edge("cond", "cmd"),
    ];
    expect(dominatingDataNodeVariableNames(nodes, edges, "cmd")).toEqual(["a"]);
  });

  it("returns nothing when there is no start node", () => {
    const nodes = [dataNode("set", ["a"]), node("cmd", "command")];
    const edges = [edge("set", "cmd")];
    expect(dominatingDataNodeVariableNames(nodes, edges, "cmd")).toEqual([]);
  });
});

describe("variableSourceOptions", () => {
  const ids = (
    predecessor: WorkflowFlowNode | null,
    commands: Command[],
    nodes: WorkflowFlowNode[],
    edges: WorkflowFlowEdge[],
    currentId: string,
  ): string[] =>
    variableSourceOptions(predecessor, commands, nodes, edges, currentId).map(
      (o) => o.id,
    );

  it("omits schemaOutput when the predecessor command has no schema", () => {
    const pred = node("p", "command", { commandId: "c1" });
    const cur = node("cur", "command");
    const got = ids(
      pred,
      [command("c1", false)],
      [node("start", "start"), pred, cur],
      [edge("start", "p"), edge("p", "cur")],
      "cur",
    );
    expect(got).not.toContain("schemaOutput");
    expect(got).toEqual(["manual", "atRun", "rawOutput", "exitCode"]);
  });

  it("offers schemaOutput when the predecessor command has a schema", () => {
    const pred = node("p", "command", { commandId: "c1" });
    const cur = node("cur", "command");
    const got = ids(
      pred,
      [command("c1", true)],
      [node("start", "start"), pred, cur],
      [edge("start", "p"), edge("p", "cur")],
      "cur",
    );
    expect(got).toContain("schemaOutput");
  });

  it("offers a dataVar option only for a dominating data node", () => {
    const before = dataNode("before", ["token"]);
    const cur = node("cur", "command");
    const after = dataNode("after", ["late"]);
    const got = ids(
      before,
      [],
      [node("start", "start"), before, cur, after],
      [edge("start", "before"), edge("before", "cur"), edge("cur", "after")],
      "cur",
    );
    expect(got).toContain("dataVar:token");
    expect(got).not.toContain("dataVar:late");
  });
});
