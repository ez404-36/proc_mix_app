import { describe, expect, it } from "vitest";
import type { Workflow, WorkflowNode } from "../types";
import {
  applyRunStateToNodes,
  collectDownstream,
  connectTailToNode,
  findAttachTail,
  findEdgeNearPoint,
  findLastNode,
  findSinglePredecessor,
  flowToWorkflow,
  insertNodeOnEdge,
  INSERT_SHIFT_X,
  isUnconnectedNode,
  makeGraphId,
  makeInitialFlow,
  markDropTargetEdge,
  markInsertNeighbors,
  markTakenEdges,
  primaryOutHandle,
  removeNodeReconnecting,
  spliceExistingNodeOnEdge,
  workflowToFlow,
  type WorkflowFlowEdge,
  type WorkflowFlowNode,
} from "./workflowGraph";

/** A `command`/`start`/`end` node with a known top-left position. */
function flowNode(
  id: string,
  kind: "start" | "command" | "condition" | "end",
  x: number,
  y: number,
): WorkflowFlowNode {
  return { id, type: kind, position: { x, y }, data: { kind } };
}

function newCommandNode(id: string, x = 0, y = 0): WorkflowFlowNode {
  return {
    id,
    type: "command",
    position: { x, y },
    data: { kind: "command", commandId: "cmd-x" },
  };
}

function sampleWorkflow(): Workflow {
  return {
    id: "wf1",
    name: "Deploy",
    description: "desc",
    icon: "rocket",
    tags: ["ci"],
    categoryId: "cat1",
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
    nodes: [
      { id: "n-start", kind: "start", position: { x: 0, y: 0 } },
      {
        id: "n-cmd",
        kind: "command",
        commandId: "c1",
        label: "Build",
        position: { x: 100, y: 50 },
      },
      {
        id: "n-cond",
        kind: "condition",
        commandId: "c2",
        position: { x: 200, y: 50 },
      },
      { id: "n-end", kind: "end", position: { x: 300, y: 50 } },
    ],
    edges: [
      { id: "e1", source: "n-start", target: "n-cmd", branch: "out" },
      { id: "e2", source: "n-cmd", target: "n-cond", branch: "out" },
      { id: "e3", source: "n-cond", target: "n-end", branch: "then" },
      { id: "e4", source: "n-cond", target: "n-end", branch: "else" },
    ],
  };
}

describe("workflowToFlow", () => {
  it("maps node kind to type, position, and command data", () => {
    const { nodes } = workflowToFlow(sampleWorkflow());
    const cmd = nodes.find((n) => n.id === "n-cmd");
    expect(cmd?.type).toBe("command");
    expect(cmd?.position).toEqual({ x: 100, y: 50 });
    expect(cmd?.data.commandId).toBe("c1");
    expect(cmd?.data.label).toBe("Build");
    expect(cmd?.data.kind).toBe("command");
  });

  it("maps edge branch to sourceHandle", () => {
    const { edges } = workflowToFlow(sampleWorkflow());
    expect(edges.find((e) => e.id === "e1")?.sourceHandle).toBe("out");
    expect(edges.find((e) => e.id === "e3")?.sourceHandle).toBe("then");
    expect(edges.find((e) => e.id === "e4")?.sourceHandle).toBe("else");
  });
});

describe("flowToWorkflow round-trip", () => {
  it("preserves nodes, edges, positions, and branches", () => {
    const wf = sampleWorkflow();
    const { nodes, edges } = workflowToFlow(wf);
    const back = flowToWorkflow(
      {
        name: wf.name,
        description: wf.description,
        icon: wf.icon,
        tags: wf.tags,
        categoryId: wf.categoryId,
      },
      nodes,
      edges,
    );
    expect(back.nodes).toEqual(wf.nodes);
    expect(back.edges).toEqual(wf.edges);
    expect(back.name).toBe("Deploy");
    expect(back.tags).toEqual(["ci"]);
    expect(back.categoryId).toBe("cat1");
  });

  it("derives kind from node.type and defaults a missing sourceHandle to out", () => {
    const nodes: WorkflowFlowNode[] = [
      {
        id: "x",
        type: "end",
        position: { x: 1, y: 2 },
        data: { kind: "command" },
      },
    ];
    const edges: WorkflowFlowEdge[] = [
      { id: "e", source: "a", target: "b" },
    ];
    const back = flowToWorkflow(
      { name: "n", description: undefined, icon: undefined, tags: [] },
      nodes,
      edges,
    );
    // node.type wins over the stale data.kind
    expect(back.nodes[0]?.kind).toBe("end");
    // a null/undefined sourceHandle collapses to the "out" branch
    expect(back.edges[0]?.branch).toBe("out");
  });

  it("falls back to data.kind when node.type is absent", () => {
    const nodes: WorkflowFlowNode[] = [
      { id: "x", position: { x: 0, y: 0 }, data: { kind: "condition" } },
    ];
    const back = flowToWorkflow(
      { name: "n", tags: [] },
      nodes,
      [],
    );
    expect(back.nodes[0]?.kind).toBe("condition");
  });

  it("preserves advanced-node config (switch cases, loop, retry, data, predicate) through a flow round-trip", () => {
    const switchNode: WorkflowNode = {
      id: "sw",
      kind: "switch",
      commandId: "cmd",
      cases: [
        {
          id: "ok",
          condition: { subject: { kind: "exitCode" }, op: "eq", value: "0" },
        },
      ],
      position: { x: 0, y: 0 },
    };
    const loopNode: WorkflowNode = {
      id: "lp",
      kind: "loop",
      loop: { count: 3, maxIterations: 100 },
      position: { x: 1, y: 1 },
    };
    const tryNode: WorkflowNode = {
      id: "tr",
      kind: "try",
      commandId: "cmd",
      retry: { retries: 2, backoffMs: 50 },
      position: { x: 2, y: 2 },
    };
    const dataNode: WorkflowNode = {
      id: "dt",
      kind: "data",
      data: [{ name: "who", value: "world" }],
      position: { x: 3, y: 3 },
    };
    const condNode: WorkflowNode = {
      id: "cn",
      kind: "condition",
      commandId: "cmd",
      condition: { subject: { kind: "stdout" }, op: "contains", value: "OK" },
      position: { x: 4, y: 4 },
    };
    const wf: Workflow = {
      ...sampleWorkflow(),
      nodes: [switchNode, loopNode, tryNode, dataNode, condNode],
      edges: [],
    };
    const { nodes, edges } = workflowToFlow(wf);
    const back = flowToWorkflow(
      { name: wf.name, tags: wf.tags },
      nodes,
      edges,
    );
    expect(back.nodes).toEqual(wf.nodes);
  });

  it("round-trips a switch case:<id> branch through the source handle", () => {
    const nodes: WorkflowFlowNode[] = [
      { id: "sw", type: "switch", position: { x: 0, y: 0 }, data: { kind: "switch" } },
      { id: "t", type: "end", position: { x: 1, y: 0 }, data: { kind: "end" } },
    ];
    const edges: WorkflowFlowEdge[] = [
      { id: "e", source: "sw", target: "t", sourceHandle: "case:prod" },
    ];
    const back = flowToWorkflow({ name: "n", tags: [] }, nodes, edges);
    expect(back.edges[0]?.branch).toBe("case:prod");
  });

  it.each(["default", "body", "done", "ok", "catch"] as const)(
    "round-trips the %s branch handle",
    (branch) => {
      const nodes: WorkflowFlowNode[] = [
        { id: "a", type: "loop", position: { x: 0, y: 0 }, data: { kind: "loop" } },
        { id: "b", type: "end", position: { x: 1, y: 0 }, data: { kind: "end" } },
      ];
      const edges: WorkflowFlowEdge[] = [
        { id: "e", source: "a", target: "b", sourceHandle: branch },
      ];
      const back = flowToWorkflow({ name: "n", tags: [] }, nodes, edges);
      expect(back.edges[0]?.branch).toBe(branch);
    },
  );
});

describe("makeGraphId", () => {
  it("produces unique ids", () => {
    const a = makeGraphId("node");
    const b = makeGraphId("node");
    expect(a).not.toBe(b);
  });

  it("falls back to a prefixed random id when crypto.randomUUID is absent", () => {
    const original = globalThis.crypto;
    // Simulate a runtime without crypto.randomUUID (the defensive branch).
    Object.defineProperty(globalThis, "crypto", {
      value: undefined,
      configurable: true,
    });
    try {
      const id = makeGraphId("edge");
      expect(id.startsWith("edge-")).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        value: original,
        configurable: true,
      });
    }
  });
});

describe("makeInitialFlow", () => {
  it("creates a single start node and no edges", () => {
    const { nodes, edges } = makeInitialFlow();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.type).toBe("start");
    expect(nodes[0]?.data.kind).toBe("start");
    expect(edges).toHaveLength(0);
  });
});

describe("applyRunStateToNodes", () => {
  const base: WorkflowFlowNode[] = [
    { id: "a", type: "command", position: { x: 0, y: 0 }, data: { kind: "command" } },
    { id: "b", type: "end", position: { x: 0, y: 0 }, data: { kind: "end" } },
  ];

  it("overlays run status + exit code onto matching nodes", () => {
    const result = applyRunStateToNodes(base, {
      a: { status: "finished", exitCode: 0 },
    });
    const a = result.find((n) => n.id === "a");
    expect(a?.data.runStatus).toBe("finished");
    expect(a?.data.exitCode).toBe(0);
  });

  it("keeps node identity when run state is unchanged", () => {
    const result = applyRunStateToNodes(base, undefined);
    // No run state and none before → identical references preserved.
    expect(result[0]).toBe(base[0]);
    expect(result[1]).toBe(base[1]);
  });

  it("clears stale run status when the run ends", () => {
    const withStatus = applyRunStateToNodes(base, {
      a: { status: "running" },
    });
    const cleared = applyRunStateToNodes(withStatus, undefined);
    expect(cleared.find((n) => n.id === "a")?.data.runStatus).toBeUndefined();
  });
});

describe("markTakenEdges", () => {
  const base: WorkflowFlowEdge[] = [
    { id: "e1", source: "a", target: "b" },
    { id: "e2", source: "b", target: "c" },
  ];

  it("animates and classes taken edges, leaves others untouched", () => {
    const result = markTakenEdges(base, ["e1"]);
    const e1 = result.find((e) => e.id === "e1");
    const e2 = result.find((e) => e.id === "e2");
    expect(e1?.animated).toBe(true);
    expect(e1?.className).toBe("wf-edge--taken");
    // e2 unchanged keeps identity
    expect(e2).toBe(base[1]);
  });

  it("treats undefined taken list as none", () => {
    const result = markTakenEdges(base, undefined);
    expect(result[0]).toBe(base[0]);
    expect(result[1]).toBe(base[1]);
  });
});

describe("findEdgeNearPoint", () => {
  // start (out anchor ~ x=150,y=26) → cmd (target anchor x=300,y=326).
  const nodes = [flowNode("a", "start", 0, 0), flowNode("b", "command", 300, 300)];
  const edges: WorkflowFlowEdge[] = [{ id: "e1", source: "a", target: "b" }];

  it("returns the edge id when the point is on the segment", () => {
    // Midpoint of the segment a.source(150,26) → b.target(300,326) ≈ (225,176).
    expect(findEdgeNearPoint(nodes, edges, { x: 225, y: 176 })).toBe("e1");
  });

  it("returns null when the point is far from every edge", () => {
    expect(findEdgeNearPoint(nodes, edges, { x: 900, y: 900 })).toBeNull();
  });

  it("picks the nearest of multiple edges", () => {
    const three = [
      flowNode("a", "start", 0, 0),
      flowNode("b", "command", 0, 200),
      flowNode("c", "command", 0, 400),
    ];
    const manyEdges: WorkflowFlowEdge[] = [
      { id: "top", source: "a", target: "b" },
      { id: "bottom", source: "b", target: "c" },
    ];
    // Near the bottom edge (b.source(150,226) → c.target(0,426)) midpoint.
    const near = findEdgeNearPoint(three, manyEdges, { x: 75, y: 326 });
    expect(near).toBe("bottom");
  });

  it("ignores edges whose endpoints are missing", () => {
    const dangling: WorkflowFlowEdge[] = [
      { id: "x", source: "ghost", target: "b" },
    ];
    expect(findEdgeNearPoint(nodes, dangling, { x: 225, y: 176 })).toBeNull();
  });
});

describe("findAttachTail", () => {
  it("returns a lone start node (free out port)", () => {
    const nodes = [flowNode("s", "start", 0, 0)];
    const tail = findAttachTail(nodes, [], { x: 400, y: 0 });
    expect(tail).toBe("s");
  });

  it("excludes a start whose out port is already used", () => {
    const nodes = [flowNode("s", "start", 0, 0), flowNode("c", "command", 300, 0)];
    const edges: WorkflowFlowEdge[] = [
      { id: "e", source: "s", target: "c", sourceHandle: "out" },
    ];
    // s.out is taken → only c (free out) qualifies.
    expect(findAttachTail(nodes, edges, { x: 600, y: 0 })).toBe("c");
  });

  it("never auto-attaches to a condition node", () => {
    const nodes = [flowNode("cond", "condition", 0, 0)];
    expect(findAttachTail(nodes, [], { x: 200, y: 0 })).toBeNull();
  });

  it("picks the tail whose output is nearest the point", () => {
    const nodes = [
      flowNode("a", "command", 0, 0),
      flowNode("b", "command", 0, 400),
    ];
    // a.out ≈ (150,26); b.out ≈ (150,426). Point near b.
    expect(findAttachTail(nodes, [], { x: 150, y: 420 })).toBe("b");
  });

  it("returns null when no tail has a free out port", () => {
    const nodes = [flowNode("e", "end", 0, 0)];
    expect(findAttachTail(nodes, [], { x: 0, y: 0 })).toBeNull();
  });
});

describe("findLastNode", () => {
  it("returns the lone start when it is the only attachable node", () => {
    expect(findLastNode([flowNode("s", "start", 0, 0)], [])).toBe("s");
  });

  it("picks the rightmost free-out node", () => {
    const nodes = [
      flowNode("s", "start", 0, 0),
      flowNode("mid", "command", 200, 0),
      flowNode("right", "command", 500, 0),
    ];
    // s.out is used, mid.out + right.out free → rightmost = right.
    const edges: WorkflowFlowEdge[] = [
      { id: "e", source: "s", target: "mid", sourceHandle: "out" },
    ];
    expect(findLastNode(nodes, edges)).toBe("right");
  });

  it("breaks an x-tie by the later (more recent) array position", () => {
    const nodes = [
      flowNode("older", "command", 100, 0),
      flowNode("newer", "command", 100, 80),
    ];
    expect(findLastNode(nodes, [])).toBe("newer");
  });

  it("returns null when nothing is attachable", () => {
    expect(findLastNode([flowNode("e", "end", 0, 0)], [])).toBeNull();
  });
});

describe("connectTailToNode", () => {
  it("appends the node and wires tail.out → node", () => {
    const nodes = [flowNode("s", "start", 0, 0)];
    const node = newCommandNode("n1", 300, 0);
    const next = connectTailToNode(nodes, [], "s", node);
    expect(next.nodes).toHaveLength(2);
    expect(next.edges).toHaveLength(1);
    const edge = next.edges[0];
    expect(edge?.source).toBe("s");
    expect(edge?.target).toBe("n1");
    expect(edge?.sourceHandle).toBe("out");
  });

  it("appends unconnected when tailId is null", () => {
    const node = newCommandNode("n1");
    const next = connectTailToNode([], [], null, node);
    expect(next.nodes).toHaveLength(1);
    expect(next.edges).toHaveLength(0);
  });
});

describe("collectDownstream", () => {
  it("returns descendants of a node, excluding itself", () => {
    const edges: WorkflowFlowEdge[] = [
      { id: "e1", source: "a", target: "b" },
      { id: "e2", source: "b", target: "c" },
    ];
    const set = collectDownstream(edges, "a");
    expect(set.has("a")).toBe(false);
    expect(set.has("b")).toBe(true);
    expect(set.has("c")).toBe(true);
  });

  it("follows every branch of a fork", () => {
    const edges: WorkflowFlowEdge[] = [
      { id: "e1", source: "cond", target: "ok", sourceHandle: "then" },
      { id: "e2", source: "cond", target: "fail", sourceHandle: "else" },
      { id: "e3", source: "ok", target: "done" },
    ];
    const set = collectDownstream(edges, "cond");
    expect([...set].sort()).toEqual(["done", "fail", "ok"]);
  });

  it("is cycle-safe", () => {
    const edges: WorkflowFlowEdge[] = [
      { id: "e1", source: "a", target: "b" },
      { id: "e2", source: "b", target: "a" },
    ];
    const set = collectDownstream(edges, "a");
    // a→b→a: b is downstream of a; a is not included (it is the start).
    expect(set.has("b")).toBe(true);
    expect(set.has("a")).toBe(false);
  });
});

describe("insertNodeOnEdge", () => {
  const nodes = [flowNode("a", "start", 0, 0), flowNode("b", "command", 300, 0)];

  it("splices A → new → B and removes the original edge", () => {
    const edges: WorkflowFlowEdge[] = [
      { id: "e1", source: "a", target: "b", sourceHandle: "out" },
    ];
    const node = newCommandNode("mid", 150, 0);
    const next = insertNodeOnEdge(nodes, edges, node, "e1");
    expect(next.nodes.map((n) => n.id)).toContain("mid");
    // original removed, two new edges added
    expect(next.edges.find((e) => e.id === "e1")).toBeUndefined();
    expect(next.edges).toHaveLength(2);
    const into = next.edges.find((e) => e.target === "mid");
    const out = next.edges.find((e) => e.source === "mid");
    expect(into?.source).toBe("a");
    expect(out?.target).toBe("b");
    expect(out?.sourceHandle).toBe("out");
  });

  it("places the new node on B's slot (the existing chain row)", () => {
    const edges: WorkflowFlowEdge[] = [
      { id: "e1", source: "a", target: "b", sourceHandle: "out" },
    ];
    // Drop point is irrelevant to placement: the node takes B's slot.
    const node = newCommandNode("mid", 999, 999);
    const next = insertNodeOnEdge(nodes, edges, node, "e1");
    const mid = next.nodes.find((n) => n.id === "mid");
    // B's original position was (300, 0).
    expect(mid?.position).toEqual({ x: 300, y: 0 });
  });

  it("shifts B and its descendants right, leaving A and unrelated nodes put", () => {
    const chain = [
      flowNode("a", "start", 0, 0),
      flowNode("b", "command", 300, 0),
      flowNode("c", "command", 600, 0),
      // An unrelated, disconnected node that must NOT move.
      flowNode("iso", "command", 50, 400),
    ];
    const edges: WorkflowFlowEdge[] = [
      { id: "e1", source: "a", target: "b", sourceHandle: "out" },
      { id: "e2", source: "b", target: "c", sourceHandle: "out" },
    ];
    const node = newCommandNode("mid");
    const next = insertNodeOnEdge(chain, edges, node, "e1");
    const byId = new Map(next.nodes.map((n) => [n.id, n]));
    expect(byId.get("a")?.position.x).toBe(0); // A unmoved
    expect(byId.get("iso")?.position.x).toBe(50); // unrelated unmoved
    expect(byId.get("b")?.position.x).toBe(300 + INSERT_SHIFT_X);
    expect(byId.get("c")?.position.x).toBe(600 + INSERT_SHIFT_X);
  });

  it("preserves the original source branch on the A → new edge", () => {
    const edges: WorkflowFlowEdge[] = [
      { id: "eThen", source: "a", target: "b", sourceHandle: "then" },
    ];
    const node = newCommandNode("mid");
    const next = insertNodeOnEdge(nodes, edges, node, "eThen");
    const into = next.edges.find((e) => e.target === "mid");
    // A side keeps `then`; the new node's own out is the default `out`.
    expect(into?.sourceHandle).toBe("then");
    const out = next.edges.find((e) => e.source === "mid");
    expect(out?.sourceHandle).toBe("out");
  });

  it("appends unconnected when the edge id is unknown", () => {
    const node = newCommandNode("mid");
    const next = insertNodeOnEdge(nodes, [], node, "missing");
    expect(next.nodes.map((n) => n.id)).toContain("mid");
    expect(next.edges).toHaveLength(0);
  });

  it("continues the chain on a branching node's primary handle", () => {
    // Inserting a `condition` between A and B: the A → cond edge keeps `out`,
    // and the cond → B edge must leave the condition's `then` handle (it has
    // no `out`), so the chain stays connected on the happy path.
    const edges: WorkflowFlowEdge[] = [
      { id: "e1", source: "a", target: "b", sourceHandle: "out" },
    ];
    const cond: WorkflowFlowNode = {
      id: "cond",
      type: "condition",
      position: { x: 0, y: 0 },
      data: { kind: "condition" },
    };
    const next = insertNodeOnEdge(nodes, edges, cond, "e1");
    const out = next.edges.find((e) => e.source === "cond");
    expect(out?.sourceHandle).toBe("then");
    expect(out?.target).toBe("b");
  });
});

describe("primaryOutHandle", () => {
  it("maps single-exit kinds to out", () => {
    expect(primaryOutHandle("start")).toBe("out");
    expect(primaryOutHandle("command")).toBe("out");
    expect(primaryOutHandle("data")).toBe("out");
    expect(primaryOutHandle("end")).toBe("out");
  });

  it("maps branching kinds to their happy-path branch", () => {
    expect(primaryOutHandle("condition")).toBe("then");
    expect(primaryOutHandle("switch")).toBe("default");
    expect(primaryOutHandle("loop")).toBe("done");
    expect(primaryOutHandle("try")).toBe("ok");
  });
});

describe("findSinglePredecessor", () => {
  const nodes: WorkflowFlowNode[] = [
    flowNode("a", "command", 0, 0),
    flowNode("b", "command", 100, 0),
    flowNode("d", "command", 200, 0),
  ];

  it("returns the sole predecessor", () => {
    const edges: WorkflowFlowEdge[] = [{ id: "e", source: "a", target: "d" }];
    expect(findSinglePredecessor("d", nodes, edges)?.id).toBe("a");
  });

  it("returns null when there is no predecessor", () => {
    expect(findSinglePredecessor("d", nodes, [])).toBeNull();
  });

  it("returns null when multiple distinct nodes converge", () => {
    const edges: WorkflowFlowEdge[] = [
      { id: "e1", source: "a", target: "d" },
      { id: "e2", source: "b", target: "d" },
    ];
    expect(findSinglePredecessor("d", nodes, edges)).toBeNull();
  });

  it("treats two edges from the SAME source as a single predecessor", () => {
    const edges: WorkflowFlowEdge[] = [
      { id: "e1", source: "a", target: "d", sourceHandle: "then" },
      { id: "e2", source: "a", target: "d", sourceHandle: "else" },
    ];
    expect(findSinglePredecessor("d", nodes, edges)?.id).toBe("a");
  });
});

describe("isUnconnectedNode", () => {
  const edges: WorkflowFlowEdge[] = [{ id: "e", source: "a", target: "b" }];
  it("is true for a node touched by no edge", () => {
    expect(isUnconnectedNode("free", edges)).toBe(true);
  });
  it("is false for a node that is an edge source or target", () => {
    expect(isUnconnectedNode("a", edges)).toBe(false);
    expect(isUnconnectedNode("b", edges)).toBe(false);
  });
});

describe("spliceExistingNodeOnEdge", () => {
  const nodes: WorkflowFlowNode[] = [
    flowNode("a", "start", 0, 0),
    flowNode("b", "command", 300, 0),
    // A free-floating node the user added but never wired.
    flowNode("free", "command", 150, 200),
  ];
  const edges: WorkflowFlowEdge[] = [
    { id: "e1", source: "a", target: "b", sourceHandle: "out" },
  ];

  it("rewires A → node → B without duplicating the node", () => {
    const next = spliceExistingNodeOnEdge(nodes, edges, "free", "e1");
    expect(next).not.toBeNull();
    if (next === null) return;
    // No node added (same count) and the original edge replaced by two.
    expect(next.nodes).toHaveLength(3);
    expect(next.edges.find((e) => e.id === "e1")).toBeUndefined();
    const into = next.edges.find((e) => e.target === "free");
    const out = next.edges.find((e) => e.source === "free");
    expect(into?.source).toBe("a");
    expect(into?.sourceHandle).toBe("out");
    expect(out?.target).toBe("b");
  });

  it("places the spliced node in B's slot and shifts B right (like palette insert)", () => {
    const next = spliceExistingNodeOnEdge(nodes, edges, "free", "e1");
    const free = next?.nodes.find((n) => n.id === "free");
    const b = next?.nodes.find((n) => n.id === "b");
    // The spliced node takes B's original slot (300,0)…
    expect(free?.position).toEqual({ x: 300, y: 0 });
    // …and B is pushed right by one insert step.
    expect(b?.position.x).toBe(300 + INSERT_SHIFT_X);
  });

  it("uses a branching node's primary handle for the outgoing edge", () => {
    const withCond: WorkflowFlowNode[] = [
      ...nodes,
      flowNode("cond", "condition", 150, 300),
    ];
    const next = spliceExistingNodeOnEdge(withCond, edges, "cond", "e1");
    const out = next?.edges.find((e) => e.source === "cond");
    expect(out?.sourceHandle).toBe("then");
  });

  it("returns null when the node is already connected", () => {
    const connected: WorkflowFlowEdge[] = [
      ...edges,
      { id: "e2", source: "free", target: "b" },
    ];
    expect(spliceExistingNodeOnEdge(nodes, connected, "free", "e1")).toBeNull();
  });

  it("returns null for an unknown edge", () => {
    expect(spliceExistingNodeOnEdge(nodes, edges, "free", "nope")).toBeNull();
  });
});

describe("markInsertNeighbors", () => {
  const nodes = [
    flowNode("a", "start", 0, 0),
    flowNode("b", "command", 300, 0),
    flowNode("c", "command", 600, 0),
  ];
  const edges: WorkflowFlowEdge[] = [
    { id: "e1", source: "a", target: "b" },
    { id: "e2", source: "b", target: "c" },
  ];

  it("flags exactly the two neighbours of the target edge", () => {
    const result = markInsertNeighbors(nodes, edges, "e1");
    const byId = new Map(result.map((n) => [n.id, n]));
    expect(byId.get("a")?.data.insertNeighbor).toBe(true);
    expect(byId.get("b")?.data.insertNeighbor).toBe(true);
    expect(byId.get("c")?.data.insertNeighbor).toBeUndefined();
  });

  it("keeps identity for unaffected nodes", () => {
    const result = markInsertNeighbors(nodes, edges, "e1");
    // `c` is not a neighbour and had no prior flag → same reference.
    expect(result.find((n) => n.id === "c")).toBe(nodes[2]);
  });

  it("clears all flags when the target is null", () => {
    const marked = markInsertNeighbors(nodes, edges, "e1");
    const cleared = markInsertNeighbors(marked, edges, null);
    for (const node of cleared) {
      expect(node.data.insertNeighbor).toBeUndefined();
    }
  });

  it("does not clobber run-state data on the same node", () => {
    const withRun = applyRunStateToNodes(nodes, {
      b: { status: "running" },
    });
    const result = markInsertNeighbors(withRun, edges, "e1");
    const b = result.find((n) => n.id === "b");
    expect(b?.data.runStatus).toBe("running");
    expect(b?.data.insertNeighbor).toBe(true);
  });
});

describe("markDropTargetEdge", () => {
  const base: WorkflowFlowEdge[] = [
    { id: "e1", source: "a", target: "b" },
    { id: "e2", source: "b", target: "c" },
  ];

  it("classes only the targeted edge and keeps others' identity", () => {
    const result = markDropTargetEdge(base, "e1");
    expect(result.find((e) => e.id === "e1")?.className).toBe(
      "wf-edge--drop-target",
    );
    expect(result.find((e) => e.id === "e2")).toBe(base[1]);
  });

  it("clears the highlight when target is null", () => {
    const marked = markDropTargetEdge(base, "e1");
    const cleared = markDropTargetEdge(marked, null);
    expect(cleared.find((e) => e.id === "e1")?.className).toBeUndefined();
  });

  it("coexists with the taken-edge class", () => {
    const taken = markTakenEdges(base, ["e1"]);
    const withDrop = markDropTargetEdge(taken, "e1");
    const e1 = withDrop.find((e) => e.id === "e1");
    expect(e1?.className).toContain("wf-edge--taken");
    expect(e1?.className).toContain("wf-edge--drop-target");
  });
});

describe("removeNodeReconnecting", () => {
  it("bridges predecessor to successor in a linear chain", () => {
    const nodes = [
      flowNode("a", "start", 0, 0),
      flowNode("x", "command", 180, 0),
      flowNode("b", "command", 360, 0),
    ];
    const edges: WorkflowFlowEdge[] = [
      { id: "e1", source: "a", target: "x", sourceHandle: "out" },
      { id: "e2", source: "x", target: "b", sourceHandle: "out" },
    ];
    const next = removeNodeReconnecting(nodes, edges, "x");
    expect(next.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    // Both edges touching x are gone; a single bridge a → b remains.
    expect(next.edges).toHaveLength(1);
    expect(next.edges[0]).toMatchObject({
      source: "a",
      target: "b",
      sourceHandle: "out",
    });
  });

  it("inherits the incoming edge's branch on the bridge", () => {
    const nodes = [
      flowNode("cond", "condition", 0, 0),
      flowNode("x", "command", 180, 0),
      flowNode("b", "end", 360, 0),
    ];
    const edges: WorkflowFlowEdge[] = [
      { id: "e1", source: "cond", target: "x", sourceHandle: "then" },
      { id: "e2", source: "x", target: "b", sourceHandle: "out" },
    ];
    const next = removeNodeReconnecting(nodes, edges, "x");
    expect(next.edges).toHaveLength(1);
    expect(next.edges[0]).toMatchObject({
      source: "cond",
      target: "b",
      sourceHandle: "then",
    });
  });

  it("does not create a duplicate bridge when one already exists", () => {
    const nodes = [
      flowNode("a", "start", 0, 0),
      flowNode("x", "command", 180, 0),
      flowNode("b", "command", 360, 0),
    ];
    const edges: WorkflowFlowEdge[] = [
      { id: "e1", source: "a", target: "x", sourceHandle: "out" },
      { id: "e2", source: "x", target: "b", sourceHandle: "out" },
      { id: "e3", source: "a", target: "b", sourceHandle: "out" },
    ];
    const next = removeNodeReconnecting(nodes, edges, "x");
    const aToB = next.edges.filter(
      (e) => e.source === "a" && e.target === "b",
    );
    expect(aToB).toHaveLength(1);
    expect(aToB[0]?.id).toBe("e3");
  });

  it("skips a self-loop bridge", () => {
    const nodes = [flowNode("a", "command", 0, 0), flowNode("x", "command", 180, 0)];
    const edges: WorkflowFlowEdge[] = [
      { id: "e1", source: "a", target: "x", sourceHandle: "out" },
      { id: "e2", source: "x", target: "a", sourceHandle: "out" },
    ];
    const next = removeNodeReconnecting(nodes, edges, "x");
    expect(next.edges).toHaveLength(0);
  });

  it("just drops edges when the node is a pure tail (no successors)", () => {
    const nodes = [flowNode("a", "start", 0, 0), flowNode("x", "command", 180, 0)];
    const edges: WorkflowFlowEdge[] = [
      { id: "e1", source: "a", target: "x", sourceHandle: "out" },
    ];
    const next = removeNodeReconnecting(nodes, edges, "x");
    expect(next.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(next.edges).toHaveLength(0);
  });
});
