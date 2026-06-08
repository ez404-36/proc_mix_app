// Smoke test for the Home view's command tiles. The Home page surfaces
// favorite and recently-run commands; its tiles must offer the same edit
// flow as the Library (right-click -> Edit, or double-click) so the two
// pages stay consistent.
//
// We mock the repository surfaces (IPC) so the test never crosses the
// Tauri boundary, but the stores and the Home component run unchanged.
// The ContextMenu provider is mounted so `useContextMenu` resolves.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

// The WorkflowView modal (opened by double-clicking a workflow card) renders
// the same reactflow canvas the editor uses. reactflow needs a layout engine
// jsdom lacks, so stub it to lightweight elements — the value here is the
// modal wiring, not reactflow's own rendering.
vi.mock("reactflow", () => ({
  __esModule: true,
  default: ({ children }: { children?: ReactNode }): ReactElement => (
    <div data-testid="reactflow">{children}</div>
  ),
  Background: (): ReactElement => <div data-testid="rf-background" />,
  Controls: (): ReactElement => <div data-testid="rf-controls" />,
  ReactFlowProvider: ({ children }: { children?: ReactNode }): ReactElement => (
    <>{children}</>
  ),
}));

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

const triggerWorkflowRun = vi.fn().mockResolvedValue("run-1");
vi.mock("../../services/workflowRunner", () => ({
  triggerWorkflowRun: (...args: unknown[]) => triggerWorkflowRun(...args),
}));

import "../../i18n";
import { ContextMenuProvider } from "../ContextMenu";
import { useCommandStore } from "../../stores/commandStore";
import { useUIStore } from "../../stores/uiStore";
import { useWorkflowStore } from "../../stores/workflowStore";
import type { Command, Workflow } from "../../types";
import { Home } from "./Home";

function makeCommand(overrides: Partial<Command> = {}): Command {
  return {
    id: "c-1",
    name: "Build app",
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
    name: "Deploy pipeline",
    description: "Build, test, ship",
    nodes: [],
    edges: [],
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
    commands: [],
    favorites: [],
    seedsInitialized: false,
    hydrated: true,
  });
  useWorkflowStore.setState({ workflows: [], hydrated: true });
  useUIStore.setState({
    currentView: "home",
    commandEditorTarget: null,
    commandEditorDirty: false,
    editorWorkflowId: null,
  });
}

function renderHome(): void {
  render(
    <ContextMenuProvider>
      <Home />
    </ContextMenuProvider>,
  );
}

function seedFavorite(): void {
  const cmd = makeCommand({ id: "c-1", name: "Build app", favorite: true });
  useCommandStore.setState({
    commands: [cmd],
    favorites: ["c-1"],
    seedsInitialized: true,
    hydrated: true,
  });
}

// A workflow with `lastRunAt` so it appears in the Home "Recently run"
// section as a WorkflowRow.
function seedRecentWorkflow(): void {
  const wf = makeWorkflow({ id: "wf-1", lastRunAt: "2026-02-01T00:00:00.000Z" });
  useWorkflowStore.setState({ workflows: [wf], hydrated: true });
}

beforeEach(() => {
  resetStores();
  triggerWorkflowRun.mockClear();
});
afterEach(() => {
  resetStores();
});

describe("Home command tiles — edit flow", () => {
  it("right-click shows an enabled Edit item that opens the command editor", () => {
    seedFavorite();
    renderHome();

    act(() => {
      fireEvent.contextMenu(screen.getByText("Build app"));
    });

    const editItem = screen.getByText("Edit");
    expect(editItem).toBeTruthy();
    // The item must be selectable (no longer the disabled stub).
    expect(editItem.closest("[aria-disabled='true']")).toBeNull();

    act(() => {
      fireEvent.click(editItem);
    });

    expect(useUIStore.getState().currentView).toBe("command-editor");
    expect(useUIStore.getState().commandEditorTarget).toEqual({
      mode: "edit",
      commandId: "c-1",
    });
  });

  it("double-clicking a command tile opens the read-only view modal, not the editor", () => {
    seedFavorite();
    renderHome();

    act(() => {
      fireEvent.doubleClick(screen.getByText("Build app"));
    });

    // The view modal opened — and navigation did NOT change to the editor.
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    // The four requested fields are present (script value + labels).
    expect(screen.getByText("echo build")).toBeTruthy();
    expect(useUIStore.getState().currentView).toBe("home");
    expect(useUIStore.getState().commandEditorTarget).toBeNull();
  });

  it("right-click View opens the read-only view modal", () => {
    seedFavorite();
    renderHome();

    act(() => {
      fireEvent.contextMenu(screen.getByText("Build app"));
    });
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: "View" }));
    });

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("echo build")).toBeTruthy();
    expect(useUIStore.getState().currentView).toBe("home");
  });

  it("the view modal's Edit button then navigates to the command editor", () => {
    seedFavorite();
    renderHome();

    act(() => {
      fireEvent.doubleClick(screen.getByText("Build app"));
    });
    const dialog = screen.getByRole("dialog");

    act(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Edit" }));
    });

    expect(useUIStore.getState().currentView).toBe("command-editor");
    expect(useUIStore.getState().commandEditorTarget).toEqual({
      mode: "edit",
      commandId: "c-1",
    });
  });
});

describe("Home workflow cards — edit & delete flow", () => {
  it("right-click shows an enabled Edit item that opens the workflow editor", () => {
    seedRecentWorkflow();
    renderHome();

    act(() => {
      fireEvent.contextMenu(screen.getByText("Deploy pipeline"));
    });

    const editItem = screen.getByText("Edit");
    expect(editItem.closest("[aria-disabled='true']")).toBeNull();

    act(() => {
      fireEvent.click(editItem);
    });

    expect(useUIStore.getState().currentView).toBe("editor");
    expect(useUIStore.getState().editorWorkflowId).toBe("wf-1");
  });

  it("double-clicking a workflow card opens the read-only view modal, not the editor", () => {
    seedRecentWorkflow();
    renderHome();

    act(() => {
      fireEvent.doubleClick(screen.getByText("Deploy pipeline"));
    });

    // The view modal opened — and navigation did NOT change to the editor.
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(useUIStore.getState().currentView).toBe("home");
    expect(useUIStore.getState().editorWorkflowId).toBeNull();
  });

  it("right-click View opens the read-only view modal", () => {
    seedRecentWorkflow();
    renderHome();

    act(() => {
      fireEvent.contextMenu(screen.getByText("Deploy pipeline"));
    });
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: "View" }));
    });

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(useUIStore.getState().currentView).toBe("home");
    expect(useUIStore.getState().editorWorkflowId).toBeNull();
  });

  it("the view modal's Edit button then navigates to the editor", () => {
    seedRecentWorkflow();
    renderHome();

    act(() => {
      fireEvent.doubleClick(screen.getByText("Deploy pipeline"));
    });
    const dialog = screen.getByRole("dialog");

    act(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Edit" }));
    });

    expect(useUIStore.getState().currentView).toBe("editor");
    expect(useUIStore.getState().editorWorkflowId).toBe("wf-1");
  });

  it("Delete confirms then removes the workflow from the store", () => {
    seedRecentWorkflow();
    renderHome();

    act(() => {
      fireEvent.contextMenu(screen.getByText("Deploy pipeline"));
    });
    // Click the "Delete" context-menu item (rendered as a menuitem, not a
    // button — distinct from the confirm dialog's Delete button).
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    });

    // The confirmation dialog is open; confirm the delete.
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });

    expect(useWorkflowStore.getState().workflows).toHaveLength(0);
  });
});
