// Smoke test for the visual editor shell. reactflow is mocked narrowly to a
// lightweight stand-in so the canvas does not need a real layout engine /
// ResizeObserver in jsdom — the value here is verifying the editor wiring
// (palette, toolbar, meta-modal gating, target hydration), not reactflow's
// own rendering. The pure graph/validation logic is covered separately in
// workflowGraph.test.ts and workflowValidation.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

vi.mock("reactflow", async () => {
  const { useState, useCallback } = await import("react");
  const Passthrough = ({ children }: { children?: ReactNode }): ReactElement => (
    <div data-testid="reactflow">{children}</div>
  );
  // Faithful-enough stand-ins for reactflow's state hooks: they must keep
  // STABLE setter identities across renders, otherwise the canvas's
  // hydration effect (which lists setNodes/setEdges in its deps) would
  // re-fire every render and spin forever. Real reactflow guarantees stable
  // setters, so the mock must too.
  const useNodesState = (initial: unknown[]) => {
    const [nodes, setNodes] = useState(initial);
    const onChange = useCallback(() => {}, []);
    return [nodes, setNodes, onChange];
  };
  const useEdgesState = (initial: unknown[]) => {
    const [edges, setEdges] = useState(initial);
    const onChange = useCallback(() => {}, []);
    return [edges, setEdges, onChange];
  };
  return {
    __esModule: true,
    default: Passthrough,
    Background: () => <div data-testid="rf-background" />,
    Controls: () => <div data-testid="rf-controls" />,
    ReactFlowProvider: ({ children }: { children?: ReactNode }) => (
      <>{children}</>
    ),
    Handle: () => <div />,
    Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
    addEdge: (edge: unknown, edges: unknown[]) => [...edges, edge],
    useNodesState,
    useEdgesState,
  };
});

vi.mock("reactflow/dist/style.css", () => ({}));

vi.mock("../../utils/commandRepository", () => ({
  upsertCommandInDb: vi.fn().mockResolvedValue(undefined),
  deleteCommandInDb: vi.fn().mockResolvedValue(undefined),
  listCommandsFromDb: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../utils/workflowRepository", () => ({
  upsertWorkflowInDb: vi.fn().mockResolvedValue(undefined),
  deleteWorkflowInDb: vi.fn().mockResolvedValue(undefined),
  listWorkflowsFromDb: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../utils/historyRepository", () => ({
  recordHistoryEventInDb: vi.fn().mockResolvedValue("evt-1"),
  updateRunHistoryEventInDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@arco-design/web-react", () => ({
  Message: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

import "../../i18n";
import { useCommandStore } from "../../stores/commandStore";
import { useUIStore } from "../../stores/uiStore";
import { useWorkflowStore } from "../../stores/workflowStore";
import { useEditorDraftStore } from "../../stores/editorDraftStore";
import { INSERT_SHIFT_X, insertNodeOnEdge } from "../../utils/workflowGraph";
import type { Command, Workflow } from "../../types";
import { Editor } from "./Editor";

function makeCommand(overrides: Partial<Command> = {}): Command {
  return {
    id: "cmd-1",
    name: "Build",
    script: "echo build",
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
    runAsAdmin: false,
    ...overrides,
  };
}

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf-1",
    name: "Deploy",
    nodes: [
      { id: "n-start", kind: "start", position: { x: 0, y: 0 } },
      {
        id: "n-cmd",
        kind: "command",
        commandId: "cmd-1",
        position: { x: 100, y: 0 },
      },
    ],
    edges: [{ id: "e1", source: "n-start", target: "n-cmd", branch: "out" }],
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
    ...overrides,
  };
}

function resetStores(): void {
  useCommandStore.setState({
    commands: [makeCommand()],
    favorites: [],
    seedsInitialized: false,
    hydrated: true,
  });
  useWorkflowStore.setState({ workflows: [], hydrated: true });
  useUIStore.setState({ currentView: "editor", editorWorkflowId: null });
  // The editor-draft store is a module singleton; reset it so a preserved
  // draft from a prior test does not leak into the next (the hydration rule
  // would otherwise treat a stale same-target draft as "preserve").
  useEditorDraftStore.setState({
    targetId: null,
    hydrated: false,
    nodes: [],
    edges: [],
    meta: { name: "", tags: [] },
    currentId: null,
    selectedNodeId: null,
  });
}

beforeEach(() => {
  resetStores();
});
afterEach(() => {
  resetStores();
});

describe("Editor shell", () => {
  it("renders the palette with available commands and the canvas", () => {
    act(() => {
      render(<Editor />);
    });
    expect(screen.getByTestId("reactflow")).toBeTruthy();
    // The palette lists the one command in the store, draggable onto the canvas.
    expect(screen.getByText("Build")).toBeTruthy();
    // Add-node buttons for condition + end are present.
    expect(screen.getByText("+ Condition")).toBeTruthy();
    expect(screen.getByText("+ End")).toBeTruthy();
  });

  it("labels the destructive toolbar action 'Clear' for a new workflow", () => {
    act(() => {
      render(<Editor />);
    });
    // New (unsaved) draft → the action clears the canvas.
    expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("labels the destructive toolbar action 'Cancel' for an existing workflow", () => {
    useWorkflowStore.setState({
      workflows: [makeWorkflow()],
      hydrated: true,
    });
    useUIStore.setState({ editorWorkflowId: "wf-1" });
    act(() => {
      render(<Editor />);
    });
    // Editing an existing workflow → the action discards edits ("Cancel").
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("opens the details modal when saving a brand-new (unnamed) workflow", () => {
    act(() => {
      render(<Editor />);
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    // No name yet → the meta modal opens to collect one rather than persisting.
    expect(screen.getByText("Workflow details")).toBeTruthy();
  });

  it("hydrates the toolbar name from an existing workflow target", () => {
    useWorkflowStore.setState({
      workflows: [makeWorkflow()],
      hydrated: true,
    });
    useUIStore.setState({ editorWorkflowId: "wf-1" });
    act(() => {
      render(<Editor />);
    });
    expect(screen.getByText("Deploy")).toBeTruthy();
  });

  it("preserves the draft when the editor unmounts (navigation) and remounts", () => {
    useWorkflowStore.setState({
      workflows: [makeWorkflow()],
      hydrated: true,
    });
    useUIStore.setState({ editorWorkflowId: "wf-1" });

    const first = render(<Editor />);
    // The canvas hydrated the saved 2-node graph from the workflow store.
    expect(useEditorDraftStore.getState().nodes).toHaveLength(2);

    // Simulate an unsaved edit on the canvas (add a node to the draft).
    act(() => {
      useEditorDraftStore.getState().setNodes((nds) => [
        ...nds,
        {
          id: "n-extra",
          type: "command",
          position: { x: 0, y: 0 },
          data: { kind: "command" },
        },
      ]);
    });
    expect(useEditorDraftStore.getState().nodes).toHaveLength(3);

    // Navigate away: the Editor unmounts entirely (renderView switches views).
    act(() => {
      first.unmount();
    });

    // Navigate back to the SAME target: remount. The draft must be preserved
    // verbatim — NOT re-hydrated from the (unchanged) 2-node saved workflow.
    act(() => {
      render(<Editor />);
    });
    const nodeIds = useEditorDraftStore.getState().nodes.map((n) => n.id);
    expect(nodeIds).toHaveLength(3);
    expect(nodeIds).toContain("n-extra");
  });

  it("clears the canvas after the styled confirmation is accepted", () => {
    useWorkflowStore.setState({
      workflows: [makeWorkflow()],
      hydrated: true,
    });
    useUIStore.setState({ editorWorkflowId: "wf-1" });

    act(() => {
      render(<Editor />);
    });
    // Add an unsaved node so we can observe the reset.
    act(() => {
      useEditorDraftStore.getState().setNodes((nds) => [
        ...nds,
        {
          id: "n-extra",
          type: "command",
          position: { x: 0, y: 0 },
          data: { kind: "command" },
        },
      ]);
    });
    expect(useEditorDraftStore.getState().nodes).toHaveLength(3);

    // Click the toolbar action → the app-styled ConfirmDialog opens (no
    // browser-native window.confirm). For an EXISTING workflow the action is
    // labelled "Cancel" (discard edits) and confirms with "Discard".
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(screen.getByText("Discard changes?")).toBeTruthy();

    // Accept via the dialog's confirm button (scoped to the dialog).
    const dialog = screen.getByRole("dialog");
    act(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    });

    // Confirmed → reset to the SAVED 2-node workflow, discarding the edit.
    const nodeIds = useEditorDraftStore.getState().nodes.map((n) => n.id);
    expect(nodeIds).toHaveLength(2);
    expect(nodeIds).not.toContain("n-extra");
  });

  it("re-disables Run after clearing an unsaved workflow", () => {
    // New (unsaved) workflow → hydrates to a single start node, Run disabled.
    act(() => {
      render(<Editor />);
    });
    expect(
      screen.getByRole("button", { name: "Run" }),
    ).toHaveProperty("disabled", true);

    // Add a step → Run enabled.
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Build" }));
    });
    expect(
      screen.getByRole("button", { name: "Run" }),
    ).toHaveProperty("disabled", false);

    // Clear (confirm) → unsaved target resets to a fresh single-start graph.
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    });
    const dialog = screen.getByRole("dialog");
    act(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Clear" }));
    });

    // Only the start node remains → Run must be disabled again.
    const kinds = useEditorDraftStore
      .getState()
      .nodes.map((n) => n.data.kind);
    expect(kinds).toEqual(["start"]);
    expect(
      screen.getByRole("button", { name: "Run" }),
    ).toHaveProperty("disabled", true);
  });

  it("appends a connected command node when a palette item is clicked", () => {
    // New workflow → the draft hydrates to a single start node.
    act(() => {
      render(<Editor />);
    });
    expect(useEditorDraftStore.getState().nodes).toHaveLength(1);
    expect(useEditorDraftStore.getState().edges).toHaveLength(0);

    // Click the palette command (a button labelled with the command name).
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Build" }));
    });

    // A command node was appended and wired from the start node's out port.
    const { nodes, edges } = useEditorDraftStore.getState();
    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(1);
    const start = nodes.find((n) => n.data.kind === "start");
    const cmd = nodes.find((n) => n.data.kind === "command");
    expect(edges[0]?.source).toBe(start?.id);
    expect(edges[0]?.target).toBe(cmd?.id);
    expect(edges[0]?.sourceHandle).toBe("out");
  });

  it("disables Run until there is a step beyond start, enables it after", () => {
    act(() => {
      render(<Editor />);
    });
    const runBtn = screen.getByRole("button", { name: "Run" });
    // Only the start node exists → Run is disabled.
    expect(runBtn).toHaveProperty("disabled", true);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Build" }));
    });
    // A command step was added → Run becomes enabled.
    expect(
      screen.getByRole("button", { name: "Run" }),
    ).toHaveProperty("disabled", false);
  });

  it("appends a connected end node when the + End button is clicked", () => {
    act(() => {
      render(<Editor />);
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "+ End" }));
    });
    const { nodes, edges } = useEditorDraftStore.getState();
    const start = nodes.find((n) => n.data.kind === "start");
    const end = nodes.find((n) => n.data.kind === "end");
    expect(end).toBeTruthy();
    // The end node is wired from the start node's out port (the tail).
    expect(edges).toHaveLength(1);
    expect(edges[0]?.source).toBe(start?.id);
    expect(edges[0]?.target).toBe(end?.id);
  });

  it("inserting a node onto an edge shifts the downstream node right", () => {
    // A → B chain hydrated from a saved workflow.
    useWorkflowStore.setState({
      workflows: [makeWorkflow()],
      hydrated: true,
    });
    useUIStore.setState({ editorWorkflowId: "wf-1" });
    act(() => {
      render(<Editor />);
    });

    const before = useEditorDraftStore.getState();
    expect(before.nodes).toHaveLength(2);
    const bBefore = before.nodes.find((n) => n.id === "n-cmd");
    const bx = bBefore?.position.x ?? 0;
    const edgeId = before.edges[0]?.id ?? "";

    // Simulate the drop-on-edge path: splice a new node into the A→B edge.
    act(() => {
      const { nodes, edges, setNodes, setEdges } =
        useEditorDraftStore.getState();
      const node = {
        id: "n-mid",
        type: "command" as const,
        position: { x: 999, y: 999 },
        data: { kind: "command" as const, commandId: "cmd-1" },
      };
      const next = insertNodeOnEdge(nodes, edges, node, edgeId);
      setNodes(next.nodes);
      setEdges(next.edges);
    });

    const after = useEditorDraftStore.getState();
    expect(after.nodes).toHaveLength(3);
    // B (n-cmd, downstream of the source) shifted right by INSERT_SHIFT_X.
    const bAfter = after.nodes.find((n) => n.id === "n-cmd");
    expect(bAfter?.position.x).toBe(bx + INSERT_SHIFT_X);
    // The inserted node took B's old slot.
    const mid = after.nodes.find((n) => n.id === "n-mid");
    expect(mid?.position.x).toBe(bx);
  });

  it("does NOT clear the canvas when the styled confirmation is cancelled", () => {
    useWorkflowStore.setState({
      workflows: [makeWorkflow()],
      hydrated: true,
    });
    useUIStore.setState({ editorWorkflowId: "wf-1" });

    act(() => {
      render(<Editor />);
    });
    act(() => {
      useEditorDraftStore.getState().setNodes((nds) => [
        ...nds,
        {
          id: "n-extra",
          type: "command",
          position: { x: 0, y: 0 },
          data: { kind: "command" },
        },
      ]);
    });
    expect(useEditorDraftStore.getState().nodes).toHaveLength(3);

    // Existing workflow → the toolbar action is "Cancel"; opening it shows the
    // "Discard changes?" confirm. Dismiss it via the dialog's own Cancel
    // button (scoped to the dialog, distinct from the "Discard" confirm).
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    const dialog = screen.getByRole("dialog");
    act(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    });

    // Cancelled → the draft (including the unsaved edit) is untouched, and the
    // dialog is dismissed.
    expect(screen.queryByText("Discard changes?")).toBeNull();
    const nodeIds = useEditorDraftStore.getState().nodes.map((n) => n.id);
    expect(nodeIds).toHaveLength(3);
    expect(nodeIds).toContain("n-extra");
  });
});
