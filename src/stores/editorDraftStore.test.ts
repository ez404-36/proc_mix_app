import { beforeEach, describe, expect, it } from "vitest";
import type { Workflow } from "../types";
import {
  buildDraftForTarget,
  fingerprintDraft,
  isDraftDirty,
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
    baseline: fingerprintDraft({ nodes: [], edges: [], meta: INITIAL_STATE.meta }),
    past: [],
    future: [],
    lastSavedAt: null,
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

  it("seeds lastSavedAt from an existing workflow's updatedAt", () => {
    const wf = makeWorkflow({ updatedAt: "2026-03-04T05:06:07.000Z" });
    const draft = buildDraftForTarget("wf-1", [wf]);
    expect(draft.lastSavedAt).toBe("2026-03-04T05:06:07.000Z");
  });

  it("leaves lastSavedAt null for a brand-new (null) draft", () => {
    expect(buildDraftForTarget(null, [makeWorkflow()]).lastSavedAt).toBeNull();
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

  it("hydrate seeds lastSavedAt from the loaded workflow", () => {
    const wf = makeWorkflow({ updatedAt: "2026-05-06T07:08:09.000Z" });
    useEditorDraftStore
      .getState()
      .hydrate("wf-1", buildDraftForTarget("wf-1", [wf]));
    expect(useEditorDraftStore.getState().lastSavedAt).toBe(
      "2026-05-06T07:08:09.000Z",
    );
  });

  it("hydrate clears lastSavedAt for a brand-new draft", () => {
    useEditorDraftStore
      .getState()
      .hydrate(null, buildDraftForTarget(null, [makeWorkflow()]));
    expect(useEditorDraftStore.getState().lastSavedAt).toBeNull();
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

describe("useEditorDraftStore undo / redo", () => {
  it("pushHistory then undo restores the previous nodes", () => {
    const store = useEditorDraftStore.getState();
    store.hydrate("wf-1", buildDraftForTarget("wf-1", [makeWorkflow()]));
    const before = useEditorDraftStore
      .getState()
      .nodes.map((n) => n.id);

    // One discrete action: snapshot first, then add a node.
    store.pushHistory();
    store.setNodes((nds) => [...nds, freshNode("n-extra")]);
    expect(
      useEditorDraftStore.getState().nodes.map((n) => n.id),
    ).toContain("n-extra");
    expect(useEditorDraftStore.getState().past).toHaveLength(1);

    store.undo();
    expect(useEditorDraftStore.getState().nodes.map((n) => n.id)).toEqual(
      before,
    );
    expect(useEditorDraftStore.getState().past).toHaveLength(0);
    expect(useEditorDraftStore.getState().future).toHaveLength(1);
  });

  it("redo re-applies the most recently undone action", () => {
    const store = useEditorDraftStore.getState();
    store.hydrate("wf-1", buildDraftForTarget("wf-1", [makeWorkflow()]));
    store.pushHistory();
    store.setNodes((nds) => [...nds, freshNode("n-extra")]);
    store.undo();
    expect(
      useEditorDraftStore.getState().nodes.map((n) => n.id),
    ).not.toContain("n-extra");

    store.redo();
    expect(
      useEditorDraftStore.getState().nodes.map((n) => n.id),
    ).toContain("n-extra");
    expect(useEditorDraftStore.getState().future).toHaveLength(0);
  });

  it("a fresh action clears the redo stack", () => {
    const store = useEditorDraftStore.getState();
    store.hydrate("wf-1", buildDraftForTarget("wf-1", [makeWorkflow()]));
    store.pushHistory();
    store.setNodes((nds) => [...nds, freshNode("n-a")]);
    store.undo();
    expect(useEditorDraftStore.getState().future).toHaveLength(1);

    // A new action invalidates the redo future.
    store.pushHistory();
    store.setNodes((nds) => [...nds, freshNode("n-b")]);
    expect(useEditorDraftStore.getState().future).toHaveLength(0);
  });

  it("commitHistory records a pre-captured snapshot as one undo step", () => {
    const store = useEditorDraftStore.getState();
    store.hydrate("wf-1", buildDraftForTarget("wf-1", [makeWorkflow()]));
    const snapshot = store.captureSnapshot();
    const before = snapshot.nodes.map((n) => n.id);

    // Multiple incremental edits (a modal session)…
    store.setNodes((nds) => [...nds, freshNode("n-1")]);
    store.setNodes((nds) => [...nds, freshNode("n-2")]);
    // …collapse into ONE history entry on commit.
    store.commitHistory(snapshot);
    expect(useEditorDraftStore.getState().past).toHaveLength(1);

    store.undo();
    expect(useEditorDraftStore.getState().nodes.map((n) => n.id)).toEqual(
      before,
    );
  });

  it("hydrate and reset clear the undo/redo history", () => {
    const store = useEditorDraftStore.getState();
    store.hydrate("wf-1", buildDraftForTarget("wf-1", [makeWorkflow()]));
    store.pushHistory();
    store.setNodes((nds) => [...nds, freshNode("n-extra")]);
    expect(useEditorDraftStore.getState().past).toHaveLength(1);

    store.reset("wf-1", buildDraftForTarget("wf-1", [makeWorkflow()]));
    expect(useEditorDraftStore.getState().past).toHaveLength(0);
    expect(useEditorDraftStore.getState().future).toHaveLength(0);
  });

  it("caps the undo history depth", () => {
    const store = useEditorDraftStore.getState();
    store.hydrate("wf-1", buildDraftForTarget("wf-1", [makeWorkflow()]));
    // Push well beyond the cap (50).
    for (let i = 0; i < 60; i++) {
      store.pushHistory();
      store.setNodes((nds) => [...nds, freshNode(`n-${i}`)]);
    }
    expect(useEditorDraftStore.getState().past.length).toBeLessThanOrEqual(50);
  });

  it("undo / redo are no-ops on empty stacks", () => {
    const store = useEditorDraftStore.getState();
    store.hydrate("wf-1", buildDraftForTarget("wf-1", [makeWorkflow()]));
    const before = useEditorDraftStore.getState().nodes.map((n) => n.id);
    store.undo();
    store.redo();
    expect(useEditorDraftStore.getState().nodes.map((n) => n.id)).toEqual(
      before,
    );
  });
});

describe("useEditorDraftStore misc setters", () => {
  it("setMeta replaces the workflow metadata", () => {
    const store = useEditorDraftStore.getState();
    store.hydrate("wf-1", buildDraftForTarget("wf-1", [makeWorkflow()]));
    store.setMeta({ name: "Renamed", tags: ["x"] });
    const s = useEditorDraftStore.getState();
    expect(s.meta.name).toBe("Renamed");
    expect(s.meta.tags).toEqual(["x"]);
  });

  it("setCurrentId stores the persisted id", () => {
    useEditorDraftStore.getState().setCurrentId("wf-new");
    expect(useEditorDraftStore.getState().currentId).toBe("wf-new");
  });

  it("setSelectedNodeId stores the selected node", () => {
    useEditorDraftStore.getState().setSelectedNodeId("n-cmd");
    expect(useEditorDraftStore.getState().selectedNodeId).toBe("n-cmd");
    useEditorDraftStore.getState().setSelectedNodeId(null);
    expect(useEditorDraftStore.getState().selectedNodeId).toBeNull();
  });
});

describe("useEditorDraftStore commitHistory cap", () => {
  it("caps the undo history depth when committing pre-captured snapshots", () => {
    const store = useEditorDraftStore.getState();
    store.hydrate("wf-1", buildDraftForTarget("wf-1", [makeWorkflow()]));
    for (let i = 0; i < 60; i++) {
      const snapshot = store.captureSnapshot();
      store.setNodes((nds) => [...nds, freshNode(`c-${i}`)]);
      store.commitHistory(snapshot);
    }
    expect(useEditorDraftStore.getState().past.length).toBeLessThanOrEqual(50);
  });
});

describe("useEditorDraftStore dirty tracking", () => {
  it("a freshly hydrated draft is not dirty", () => {
    const store = useEditorDraftStore.getState();
    store.hydrate("wf-1", buildDraftForTarget("wf-1", [makeWorkflow()]));
    const s = useEditorDraftStore.getState();
    expect(
      isDraftDirty({
        nodes: s.nodes,
        edges: s.edges,
        meta: s.meta,
        baseline: s.baseline,
      }),
    ).toBe(false);
  });

  it("an edit makes the draft dirty", () => {
    const store = useEditorDraftStore.getState();
    store.hydrate("wf-1", buildDraftForTarget("wf-1", [makeWorkflow()]));
    store.setNodes((nds) => [...nds, freshNode("n-extra")]);
    const s = useEditorDraftStore.getState();
    expect(
      isDraftDirty({
        nodes: s.nodes,
        edges: s.edges,
        meta: s.meta,
        baseline: s.baseline,
      }),
    ).toBe(true);
  });

  it("markSaved clears the dirty flag", () => {
    const store = useEditorDraftStore.getState();
    store.hydrate("wf-1", buildDraftForTarget("wf-1", [makeWorkflow()]));
    store.setNodes((nds) => [...nds, freshNode("n-extra")]);
    store.markSaved();
    const s = useEditorDraftStore.getState();
    expect(
      isDraftDirty({
        nodes: s.nodes,
        edges: s.edges,
        meta: s.meta,
        baseline: s.baseline,
      }),
    ).toBe(false);
  });

  it("ignores transient reactflow node fields and sub-pixel position drift", () => {
    const store = useEditorDraftStore.getState();
    store.hydrate("wf-1", buildDraftForTarget("wf-1", [makeWorkflow()]));
    // A selection highlight + measured size + sub-pixel jitter must NOT count
    // as a real edit.
    store.setNodes((nds) =>
      nds.map((n, i) =>
        i === 0
          ? {
              ...n,
              selected: true,
              width: 120,
              height: 40,
              position: { x: n.position.x + 0.3, y: n.position.y - 0.2 },
            }
          : n,
      ),
    );
    const s = useEditorDraftStore.getState();
    expect(
      isDraftDirty({
        nodes: s.nodes,
        edges: s.edges,
        meta: s.meta,
        baseline: s.baseline,
      }),
    ).toBe(false);
  });
});

describe("useEditorDraftStore lastSavedAt", () => {
  it("seeds lastSavedAt from updatedAt after hydrating an existing workflow", () => {
    const store = useEditorDraftStore.getState();
    const wf = makeWorkflow({ updatedAt: "2026-02-03T04:05:06.000Z" });
    store.hydrate("wf-1", buildDraftForTarget("wf-1", [wf]));
    expect(useEditorDraftStore.getState().lastSavedAt).toBe(
      "2026-02-03T04:05:06.000Z",
    );
  });

  it("is null after hydrating a brand-new (null) draft", () => {
    const store = useEditorDraftStore.getState();
    store.hydrate(null, buildDraftForTarget(null, [makeWorkflow()]));
    expect(useEditorDraftStore.getState().lastSavedAt).toBeNull();
  });

  it("markSaved stamps lastSavedAt with a valid ISO timestamp", () => {
    const store = useEditorDraftStore.getState();
    store.hydrate(null, buildDraftForTarget(null, [makeWorkflow()]));
    store.markSaved();
    const { lastSavedAt } = useEditorDraftStore.getState();
    expect(lastSavedAt).not.toBeNull();
    expect(Number.isNaN(new Date(lastSavedAt ?? "").getTime())).toBe(false);
  });

  it("hydrate re-seeds lastSavedAt from the newly loaded workflow", () => {
    const store = useEditorDraftStore.getState();
    store.hydrate(null, buildDraftForTarget(null, [makeWorkflow()]));
    store.markSaved();
    expect(useEditorDraftStore.getState().lastSavedAt).not.toBeNull();

    const wf = makeWorkflow({ updatedAt: "2026-07-08T09:10:11.000Z" });
    store.hydrate("wf-1", buildDraftForTarget("wf-1", [wf]));
    expect(useEditorDraftStore.getState().lastSavedAt).toBe(
      "2026-07-08T09:10:11.000Z",
    );
  });

  it("reset preserves the workflow's saved time (clearing the draft is not a save)", () => {
    const store = useEditorDraftStore.getState();
    const wf = makeWorkflow({ updatedAt: "2026-08-09T10:11:12.000Z" });
    store.hydrate("wf-1", buildDraftForTarget("wf-1", [wf]));

    store.reset("wf-1", buildDraftForTarget("wf-1", [wf]));
    expect(useEditorDraftStore.getState().lastSavedAt).toBe(
      "2026-08-09T10:11:12.000Z",
    );
  });
});
