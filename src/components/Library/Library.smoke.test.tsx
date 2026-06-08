// Smoke test for the Library view's Commands / Workflows tabs:
//
//   - the tab strip switches between the Commands list and the Workflows
//     list;
//   - workflow cards render name/description and fire Run / Delete /
//     Favorite through the right service/store boundary.
//
// We mock the repository surfaces (IPC) and the workflow runner so the
// test never crosses the Tauri boundary, but the stores, services, and
// Library component all run unchanged. The ContextMenu provider is mounted
// so `useContextMenu` resolves.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

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

vi.mock("@arco-design/web-react", () => ({
  Message: { error: vi.fn(), success: vi.fn() },
}));

import "../../i18n";
import { ContextMenuProvider } from "../ContextMenu";
import { useCommandStore } from "../../stores/commandStore";
import { useUIStore } from "../../stores/uiStore";
import { useWorkflowStore } from "../../stores/workflowStore";
import type { Command, Workflow } from "../../types";
import { Library } from "./Library";

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
    libraryTab: "commands",
    editorWorkflowId: null,
    currentView: "library",
    commandEditorTarget: null,
  });
}

function renderLibrary(): void {
  render(
    <ContextMenuProvider>
      <Library />
    </ContextMenuProvider>,
  );
}

// jsdom does not implement scrollIntoView; the custom Dropdown calls it
// when its popup opens (to keep the active option in view). Stub it so the
// category-filter dropdown can render under the test runner.
HTMLElement.prototype.scrollIntoView = (): void => {};

beforeEach(() => {
  resetStores();
  triggerWorkflowRun.mockClear();
});
afterEach(() => {
  resetStores();
});

describe("Library tabs", () => {
  it("defaults to the Commands tab and switches to Workflows", () => {
    useWorkflowStore.setState({ workflows: [makeWorkflow()], hydrated: true });
    renderLibrary();

    // Commands tab is active first: the command empty-state shows, the
    // workflow card does not.
    expect(screen.getByText("No commands yet. Create your first one.")).toBeTruthy();
    expect(screen.queryByText("Deploy pipeline")).toBeNull();

    // Switch to the Workflows tab.
    act(() => {
      fireEvent.click(screen.getByRole("tab", { name: "Workflows" }));
    });

    expect(useUIStore.getState().libraryTab).toBe("workflows");
    expect(screen.getByText("Deploy pipeline")).toBeTruthy();
    expect(screen.getByText("Build, test, ship")).toBeTruthy();
  });

  it("shows the workflows empty-state when there are none", () => {
    useUIStore.setState({ libraryTab: "workflows" });
    renderLibrary();
    expect(
      screen.getByText("No workflows yet. Create your first one."),
    ).toBeTruthy();
  });

  it("Run on a workflow card calls triggerWorkflowRun", () => {
    const wf = makeWorkflow();
    useWorkflowStore.setState({ workflows: [wf], hydrated: true });
    useUIStore.setState({ libraryTab: "workflows" });
    renderLibrary();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
    });

    expect(triggerWorkflowRun).toHaveBeenCalledTimes(1);
    expect(triggerWorkflowRun.mock.calls[0]?.[0]).toMatchObject({ id: "wf-1" });
  });

  it("View on a workflow card opens the read-only view modal", () => {
    const wf = makeWorkflow();
    useWorkflowStore.setState({ workflows: [wf], hydrated: true });
    useUIStore.setState({ libraryTab: "workflows" });
    renderLibrary();

    // The card's secondary button is now "View" (Edit was removed) — it
    // opens the read-only modal rather than navigating to the editor.
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "View" }));
    });

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(useUIStore.getState().currentView).toBe("library");
    expect(useUIStore.getState().editorWorkflowId).toBeNull();
  });

  it("double-clicking a workflow opens the read-only view, not the editor", () => {
    const wf = makeWorkflow();
    useWorkflowStore.setState({ workflows: [wf], hydrated: true });
    useUIStore.setState({
      libraryTab: "workflows",
      currentView: "library",
      editorWorkflowId: null,
    });
    renderLibrary();

    // Double-click the card (the title is inside it).
    act(() => {
      fireEvent.doubleClick(screen.getByText("Deploy pipeline"));
    });

    // The view modal opened — and navigation did NOT change to the editor.
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(useUIStore.getState().currentView).toBe("library");
    expect(useUIStore.getState().editorWorkflowId).toBeNull();
    // The modal shows the workflow name and a Close button.
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("right-click View on a workflow opens the read-only view modal", () => {
    const wf = makeWorkflow();
    useWorkflowStore.setState({ workflows: [wf], hydrated: true });
    useUIStore.setState({
      libraryTab: "workflows",
      currentView: "library",
      editorWorkflowId: null,
    });
    renderLibrary();

    act(() => {
      fireEvent.contextMenu(screen.getByText("Deploy pipeline"));
    });
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: "View" }));
    });

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(useUIStore.getState().currentView).toBe("library");
    expect(useUIStore.getState().editorWorkflowId).toBeNull();
  });

  it("the view modal's Edit button then navigates to the editor", () => {
    const wf = makeWorkflow();
    useWorkflowStore.setState({ workflows: [wf], hydrated: true });
    useUIStore.setState({ libraryTab: "workflows" });
    renderLibrary();

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

  it("Favorite toggles the workflow's favorite flag in the store", () => {
    const wf = makeWorkflow({ favorite: false });
    useWorkflowStore.setState({ workflows: [wf], hydrated: true });
    useUIStore.setState({ libraryTab: "workflows" });
    renderLibrary();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Favorite" }));
    });

    expect(useWorkflowStore.getState().workflows[0]?.favorite).toBe(true);
  });

  it("New workflow navigates to the editor with a null target", () => {
    useUIStore.setState({ libraryTab: "workflows" });
    renderLibrary();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    });

    expect(useUIStore.getState().currentView).toBe("editor");
    expect(useUIStore.getState().editorWorkflowId).toBeNull();
  });
});

describe("Library Commands tab — tag & category filters", () => {
  function seedCommands(): void {
    useCommandStore.setState({
      commands: [
        makeCommand({
          id: "a",
          name: "Deploy app",
          tags: ["ci"],
          categoryId: "Build",
        }),
        makeCommand({
          id: "b",
          name: "Open shell",
          tags: ["util"],
          categoryId: "Network",
        }),
      ],
      favorites: [],
      seedsInitialized: true,
      hydrated: true,
    });
    useUIStore.setState({ libraryTab: "commands" });
  }

  it("selecting a tag chip narrows the command list (ANY semantics)", () => {
    seedCommands();
    renderLibrary();

    // Both commands visible initially.
    expect(screen.getByText("Deploy app")).toBeTruthy();
    expect(screen.getByText("Open shell")).toBeTruthy();

    // Click the 'ci' filter chip → only the 'ci'-tagged command remains.
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "ci", pressed: false }));
    });

    expect(screen.getByText("Deploy app")).toBeTruthy();
    expect(screen.queryByText("Open shell")).toBeNull();
  });

  it("selecting a category narrows the command list", () => {
    seedCommands();
    renderLibrary();

    // Open the category dropdown and pick "Network".
    act(() => {
      fireEvent.click(
        screen.getByRole("button", { name: "Filter by category" }),
      );
    });
    act(() => {
      fireEvent.click(screen.getByRole("option", { name: "Network" }));
    });

    expect(screen.getByText("Open shell")).toBeTruthy();
    expect(screen.queryByText("Deploy app")).toBeNull();
  });

  it("Clear filters restores the full list", () => {
    seedCommands();
    renderLibrary();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "ci", pressed: false }));
    });
    expect(screen.queryByText("Open shell")).toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    });

    expect(screen.getByText("Deploy app")).toBeTruthy();
    expect(screen.getByText("Open shell")).toBeTruthy();
  });
});

describe("Library Commands tab — editor navigation", () => {
  it("New command navigates to the command editor with a create target", () => {
    renderLibrary();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "New command" }));
    });

    expect(useUIStore.getState().currentView).toBe("command-editor");
    expect(useUIStore.getState().commandEditorTarget).toEqual({
      mode: "create",
      commandId: null,
    });
  });

  it("double-clicking a command tile opens the read-only view modal, not the editor", () => {
    useCommandStore.setState({
      commands: [makeCommand({ id: "c-1", name: "Build app" })],
      favorites: [],
      seedsInitialized: true,
      hydrated: true,
    });
    renderLibrary();

    // Double-click opens the read-only view modal first (editing is explicit
    // via the modal's Edit button or the context menu).
    act(() => {
      fireEvent.doubleClick(screen.getByText("Build app"));
    });

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(useUIStore.getState().currentView).toBe("library");
    expect(useUIStore.getState().commandEditorTarget).toBeNull();
  });

  it("right-click View opens the read-only command view modal", () => {
    useCommandStore.setState({
      commands: [makeCommand({ id: "c-1", name: "Build app" })],
      favorites: [],
      seedsInitialized: true,
      hydrated: true,
    });
    renderLibrary();

    act(() => {
      fireEvent.contextMenu(screen.getByText("Build app"));
    });
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: "View" }));
    });

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(useUIStore.getState().currentView).toBe("library");
    expect(useUIStore.getState().commandEditorTarget).toBeNull();
  });

  it("the command view modal's Edit button navigates with an edit target carrying the id", () => {
    useCommandStore.setState({
      commands: [makeCommand({ id: "c-1", name: "Build app" })],
      favorites: [],
      seedsInitialized: true,
      hydrated: true,
    });
    renderLibrary();

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

