import { beforeEach, describe, expect, it } from "vitest";
import type { Workflow } from "../types";
import {
  buildDraftForTarget,
  useEditorDraftStore,
} from "./editorDraftStore";
import type { WorkflowFlowNode } from "../utils/workflowGraph";

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf-1",
    name: "Deploy",
    description: "ship it",
    nodes: [
      { id: "n-start", kind: "start", position: { x: 0, y: 0 } },
      {
        id: "n-cmd",
        kind: "command",
        commandId: "cmd-1",
        position: { x: 120, y: 0 },
      },
    ],
    edges: [{ id: "e1", source: "n-start", target: "n-cmd", branch: "out" }],
    tags: ["ci"],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
    ...overrides,
  };
}

function freshNode(id: string): WorkflowFlowNode {
  return {
    id,
    type: "command",
    position: { x: 0, y: 0 },
    data: { kind: "command" },
  };
}

const INITIAL_STATE = useEditorDraftStore.getState();

beforeEach(() => {
  // Reset the singleton store between tests so leakage from one case does not
  // affect the next (the store persists for the module lifetime).
  useEditorDraftStore.setState({
    targetId: null,
    hydrated: false,
    nodes: [],
    edges: [],
    meta: INITIAL_STATE.meta,
    currentId: null,
    selectedNodeId: null,
  });
});

describe("buildDraftForTarget", () => {
  it("loads the saved graph + metadata for a known existing target", () => {
    const wf = makeWorkflow();
    const draft = buildDraftForTarget("wf-1", [wf]);
    expect(draft.currentId).toBe("wf-1");
    expect(draft.meta.name).toBe("Deploy");
    expect(draft.meta.description).toBe("ship it");
    expect(draft.meta.tags).toEqual(["ci"]);
    expect(draft.nodes.map((n) => n.id)).toEqual(["n-start", "n-cmd"]);
    expect(draft.edges.map((e) => e.id)).toEqual(["e1"]);
  });

  it("builds a fresh single-start-node graph for a new (null) target", () => {
    const draft = buildDraftForTarget(null, [makeWorkflow()]);
    expect(draft.currentId).toBeNull();
    expect(draft.meta.name).toBe("");
    expect(draft.nodes).toHaveLength(1);
    expect(draft.nodes[0]?.type).toBe("start");
    expect(draft.edges).toHaveLength(0);
  });

  it("falls back to a fresh graph when the target id is unknown", () => {
    const draft = buildDraftForTarget("ghost", [makeWorkflow()]);
    expect(draft.currentId).toBeNull();
    expect(draft.nodes).toHaveLength(1);
    expect(draft.nodes[0]?.type).toBe("start");
  });
});

describe("useEditorDraftStore hydrate / preserve", () => {
  it("hydrate replaces the whole draft and marks the target", () => {
    const store = useEditorDraftStore.getState();
    store.hydrate("wf-1", buildDraftForTarget("wf-1", [makeWorkflow()]));
    const s = useEditorDraftStore.getState();
    expect(s.hydrated).toBe(true);
    expect(s.targetId).toBe("wf-1");
    expect(s.currentId).toBe("wf-1");
    expect(s.nodes.map((n) => n.id)).toEqual(["n-start", "n-cmd"]);
    expect(s.selectedNodeId).toBeNull();
  });

  it("preserves an in-progress draft across a same-target remount", () => {
    const store = useEditorDraftStore.getState();
    // Hydrate the existing workflow, then make an unsaved edit (add a node).
    store.hydrate("wf-1", buildDraftForTarget("wf-1", [makeWorkflow()]));
    store.setNodes((nds) => [...nds, freshNode("n-extra")]);
    expect(
      useEditorDraftStore.getState().nodes.map((n) => n.id),
    ).toContain("n-extra");

    // The remount-after-navigation check the canvas performs: same target →
    // do NOT re-hydrate. Simulate by NOT calling hydrate and asserting the
    // edit is still present.
    const { hydrated, targetId } = useEditorDraftStore.getState();
    expect(hydrated).toBe(true);
    expect(targetId).toBe("wf-1");
    expect(
      useEditorDraftStore.getState().nodes.map((n) => n.id),
    ).toContain("n-extra");
  });

  it("re-hydrates (discards the draft) on a genuine target switch", () => {
    const store = useEditorDraftStore.getState();
    store.hydrate("wf-1", buildDraftForTarget("wf-1", [makeWorkflow()]));
    store.setNodes((nds) => [...nds, freshNode("n-extra")]);

    // Switch to a new (null) target: the canvas effect would re-hydrate.
    store.hydrate(null, buildDraftForTarget(null, [makeWorkflow()]));
    const s = useEditorDraftStore.getState();
    expect(s.targetId).toBeNull();
    expect(s.currentId).toBeNull();
    expect(s.nodes.map((n) => n.id)).not.toContain("n-extra");
    expect(s.nodes).toHaveLength(1);
    expect(s.nodes[0]?.type).toBe("start");
  });
});

describe("useEditorDraftStore setters (array + updater forms)", () => {
  it("setNodes accepts a plain array", () => {
    useEditorDraftStore.getState().setNodes([freshNode("a")]);
    expect(useEditorDraftStore.getState().nodes.map((n) => n.id)).toEqual([
      "a",
    ]);
  });

  it("setNodes accepts an updater function (reactflow contract)", () => {
    useEditorDraftStore.getState().setNodes([freshNode("a")]);
    useEditorDraftStore
      .getState()
      .setNodes((nds) => [...nds, freshNode("b")]);
    expect(useEditorDraftStore.getState().nodes.map((n) => n.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("setEdges accepts both array and updater forms", () => {
    useEditorDraftStore
      .getState()
      .setEdges([{ id: "e1", source: "a", target: "b" }]);
    useEditorDraftStore
      .getState()
      .setEdges((eds) => [...eds, { id: "e2", source: "b", target: "c" }]);
    expect(useEditorDraftStore.getState().edges.map((e) => e.id)).toEqual([
      "e1",
      "e2",
    ]);
  });
});

describe("useEditorDraftStore reset", () => {
  it("reset of an existing target reloads the SAVED workflow", () => {
    const store = useEditorDraftStore.getState();
    store.hydrate("wf-1", buildDraftForTarget("wf-1", [makeWorkflow()]));
    // Unsaved edit, then clear.
    store.setNodes((nds) => [...nds, freshNode("n-extra")]);
    store.reset("wf-1", buildDraftForTarget("wf-1", [makeWorkflow()]));
    const s = useEditorDraftStore.getState();
    expect(s.nodes.map((n) => n.id)).toEqual(["n-start", "n-cmd"]);
    expect(s.currentId).toBe("wf-1");
    expect(s.selectedNodeId).toBeNull();
  });

  it("reset of a new target yields a fresh initial graph", () => {
    const store = useEditorDraftStore.getState();
    store.hydrate(null, buildDraftForTarget(null, [makeWorkflow()]));
    store.setNodes((nds) => [...nds, freshNode("n-extra")]);
    store.reset(null, buildDraftForTarget(null, [makeWorkflow()]));
    const s = useEditorDraftStore.getState();
    expect(s.currentId).toBeNull();
    expect(s.nodes).toHaveLength(1);
    expect(s.nodes[0]?.type).toBe("start");
  });
});
