// Smoke test for the Library view's Commands / Workflows / Mini-Apps tabs:
//
//   - the tab strip switches between the Commands, Workflows, and Mini-Apps
//     lists;
//   - workflow cards render name/description and fire Run / Delete /
//     Favorite through the right service/store boundary;
//   - mini-app cards render name/description/widget count and fire
//     Run / Edit / Delete / Favorite through the right service/store
//     boundary (mirrors the former standalone `MiniApps.smoke.test.tsx`,
//     now that the Mini-Apps list lives inside the Library as a tab).
//
// We mock the repository surfaces (IPC) and the workflow/mini-app runners so
// the test never crosses the Tauri boundary, but the stores, services, and
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

vi.mock("../../utils/miniappRepository", () => ({
  listMiniAppsFromDb: vi.fn().mockResolvedValue([]),
  getMiniAppFromDb: vi.fn().mockResolvedValue(null),
  saveMiniAppInDb: vi.fn().mockResolvedValue(undefined),
  deleteMiniAppInDb: vi.fn().mockResolvedValue(undefined),
  runStatusProbe: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../utils/platform", () => ({
  getPlatform: vi.fn().mockResolvedValue("linux"),
  getCachedPlatform: vi.fn().mockReturnValue("linux"),
}));

const triggerWorkflowRun = vi.fn().mockResolvedValue("run-1");
vi.mock("../../services/workflowRunner", () => ({
  triggerWorkflowRun: (...args: unknown[]) => triggerWorkflowRun(...args),
}));

const openMiniAppWindow = vi.fn().mockResolvedValue(undefined);
const listOpenMiniAppWindows = vi.fn().mockResolvedValue([]);
vi.mock("../../services/miniappWindow", () => ({
  openMiniAppWindow: (...args: unknown[]) => openMiniAppWindow(...args),
  listOpenMiniAppWindows: (...args: unknown[]) =>
    listOpenMiniAppWindows(...args),
}));

vi.mock("@arco-design/web-react", () => ({
  Message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import "../../i18n";
import { ContextMenuProvider } from "../ContextMenu";
import { useCommandStore } from "../../stores/commandStore";
import { useMiniAppStore } from "../../stores/miniappStore";
import { useMiniAppWindowStore } from "../../stores/miniappWindowStore";
import { useUIStore } from "../../stores/uiStore";
import { useWorkflowStore } from "../../stores/workflowStore";
import type { Command, MiniApp, MiniAppWidget, Workflow } from "../../types";
import { listMiniAppsFromDb } from "../../utils/miniappRepository";
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

function buttonWidget(id: string): MiniAppWidget {
  return {
    id,
    kind: "button",
    layout: { x: 0, y: 0, w: 120, h: 44 },
    label: "Go",
    action: { kind: "inline", name: "Go", script: "echo go" },
  };
}

function makeMiniApp(overrides: Partial<MiniApp> = {}): MiniApp {
  return {
    id: "ma-1",
    name: "VPN Panel",
    description: "Controls the office VPN",
    widgets: [buttonWidget("w-1")],
    tags: ["network"],
    favorite: false,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    runCount: 0,
    panelSize: { w: 400, h: 320 },
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
  useMiniAppStore.setState({
    miniapps: [],
    favorites: [],
    hydrated: true,
  });
  useMiniAppWindowStore.setState({ runningIds: new Set() });
  useUIStore.setState({
    libraryTab: "commands",
    editorWorkflowId: null,
    currentView: "library",
    commandEditorTarget: null,
    miniappEditorId: null,
    miniappRunnerId: null,
  });
}

function renderLibrary(): void {
  render(
    <ContextMenuProvider>
      <Library />
    </ContextMenuProvider>,
  );
}

/**
 * Render the Library and flush the Mini-Apps tab's post-mount
 * `hydrateFromDb` effect, so the resolved IPC promise never lands after the
 * test body (which React reports as an un-acted update). The mocked
 * `listMiniAppsFromDb` echoes the state the test staged, so hydrating is a
 * no-op rather than a wipe.
 */
async function renderLibraryWithMiniApps(): Promise<void> {
  vi.mocked(listMiniAppsFromDb).mockResolvedValue(
    useMiniAppStore.getState().miniapps,
  );
  await act(async () => {
    render(
      <ContextMenuProvider>
        <Library />
      </ContextMenuProvider>,
    );
  });
}

/** Find the card whose title matches `name`. */
function cardFor(name: string): HTMLElement {
  const title = screen.getByText(name);
  const card = title.closest(".list-tile");
  if (card === null) throw new Error(`no card for "${name}"`);
  return card as HTMLElement;
}

// jsdom does not implement scrollIntoView; the custom Dropdown calls it
// when its popup opens (to keep the active option in view). Stub it so the
// category-filter dropdown can render under the test runner.
HTMLElement.prototype.scrollIntoView = (): void => {};

beforeEach(() => {
  resetStores();
  triggerWorkflowRun.mockClear();
  listOpenMiniAppWindows.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  resetStores();
  vi.clearAllMocks();
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

describe("Library Mini-Apps tab — window-state reconciliation", () => {
  it("calls listOpenMiniAppWindows on mount and reconciles the running-tile state", async () => {
    useUIStore.setState({ libraryTab: "miniapps" });
    useMiniAppStore.setState({
      miniapps: [makeMiniApp()],
      favorites: [],
      hydrated: true,
    });
    // The event stream never told us "ma-1" is running (e.g. the main
    // window's listener was still attaching when the tray opened it), but
    // the live window registry says it is — reconciliation must pick this
    // up on mount rather than requiring an event.
    listOpenMiniAppWindows.mockResolvedValue(["ma-1"]);
    await renderLibraryWithMiniApps();

    expect(listOpenMiniAppWindows).toHaveBeenCalledTimes(1);
    expect(useMiniAppWindowStore.getState().runningIds.has("ma-1")).toBe(
      true,
    );
    expect(
      within(cardFor("VPN Panel")).getByRole("button", { name: "Running" }),
    ).toBeTruthy();
  });

  it("clears a stale running id the event stream never cleaned up", async () => {
    useUIStore.setState({ libraryTab: "miniapps" });
    useMiniAppStore.setState({
      miniapps: [makeMiniApp()],
      favorites: [],
      hydrated: true,
    });
    // The store THINKS ma-1 is still running (e.g. a missed `Closed` event),
    // but the live registry says no such window exists any more.
    useMiniAppWindowStore.setState({ runningIds: new Set(["ma-1"]) });
    listOpenMiniAppWindows.mockResolvedValue([]);
    await renderLibraryWithMiniApps();

    expect(useMiniAppWindowStore.getState().runningIds.has("ma-1")).toBe(
      false,
    );
    expect(
      within(cardFor("VPN Panel")).getByRole("button", { name: "Run" }),
    ).toBeTruthy();
  });

  it("a failed reconciliation IPC call does not crash the tab or clear existing state", async () => {
    useUIStore.setState({ libraryTab: "miniapps" });
    useMiniAppStore.setState({
      miniapps: [makeMiniApp()],
      favorites: [],
      hydrated: true,
    });
    useMiniAppWindowStore.setState({ runningIds: new Set(["ma-1"]) });
    listOpenMiniAppWindows.mockRejectedValue(new Error("ipc down"));
    await renderLibraryWithMiniApps();

    // The event-stream-derived state is left exactly as it was — a failed
    // reconciliation must never regress to "nothing is running".
    expect(useMiniAppWindowStore.getState().runningIds.has("ma-1")).toBe(
      true,
    );
  });
});

describe("Library Mini-Apps tab", () => {
  it("switches to the Mini-Apps tab from the tab strip", async () => {
    useMiniAppStore.setState({
      miniapps: [makeMiniApp()],
      favorites: [],
      hydrated: true,
    });
    await renderLibraryWithMiniApps();

    expect(screen.queryByText("VPN Panel")).toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole("tab", { name: "Mini-Apps" }));
    });

    expect(useUIStore.getState().libraryTab).toBe("miniapps");
    expect(screen.getByText("VPN Panel")).toBeTruthy();
    expect(screen.getByText("Controls the office VPN")).toBeTruthy();
  });

  it("shows the teaching empty state when there are no mini-apps", async () => {
    useUIStore.setState({ libraryTab: "miniapps" });
    await renderLibraryWithMiniApps();

    expect(screen.getByText("No mini-applications yet.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "From template" }),
    ).toBeTruthy();
  });

  it("renders the name, description, widget count, and tags", async () => {
    useUIStore.setState({ libraryTab: "miniapps" });
    useMiniAppStore.setState({
      miniapps: [
        makeMiniApp({
          widgets: [buttonWidget("w-1"), buttonWidget("w-2")],
          tags: ["network", "vpn"],
        }),
      ],
      favorites: [],
      hydrated: true,
    });
    await renderLibraryWithMiniApps();

    const card = cardFor("VPN Panel");
    expect(within(card).getByText("Controls the office VPN")).toBeTruthy();
    expect(within(card).getByText("2 widgets")).toBeTruthy();
    expect(within(card).getByText("network")).toBeTruthy();
    expect(within(card).getByText("vpn")).toBeTruthy();
  });

  it("Run opens the mini-app's standalone window instead of navigating", async () => {
    useUIStore.setState({ libraryTab: "miniapps" });
    useMiniAppStore.setState({
      miniapps: [makeMiniApp()],
      favorites: [],
      hydrated: true,
    });
    const priorView = useUIStore.getState().currentView;
    await renderLibraryWithMiniApps();

    await act(async () => {
      fireEvent.click(
        within(cardFor("VPN Panel")).getByRole("button", { name: "Run" }),
      );
    });

    expect(openMiniAppWindow).toHaveBeenCalledWith("ma-1");
    // The Library itself never navigates — the mini-app runs in its own OS
    // window, opened via `services/miniappWindow.ts` (mocked above).
    expect(useUIStore.getState().currentView).toBe(priorView);
  });

  it("shows a disabled loader + 'Running' label instead of Run for an already-open mini-app", async () => {
    useUIStore.setState({ libraryTab: "miniapps" });
    useMiniAppStore.setState({
      miniapps: [makeMiniApp()],
      favorites: [],
      hydrated: true,
    });
    // The mount-time reconciliation (see the describe block above) would
    // otherwise overwrite this seeded state with its own empty default —
    // agree with it so this test exercises the running-tile rendering, not
    // reconciliation itself.
    listOpenMiniAppWindows.mockResolvedValue(["ma-1"]);
    useMiniAppWindowStore.setState({ runningIds: new Set(["ma-1"]) });
    await renderLibraryWithMiniApps();

    const card = cardFor("VPN Panel");
    expect(within(card).queryByRole("button", { name: "Run" })).toBeNull();
    const runningButton = within(card).getByRole("button", {
      name: "Running",
    });
    expect(runningButton).toBeTruthy();
    expect((runningButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("clicking the disabled Running button never calls openMiniAppWindow again", async () => {
    useUIStore.setState({ libraryTab: "miniapps" });
    useMiniAppStore.setState({
      miniapps: [makeMiniApp()],
      favorites: [],
      hydrated: true,
    });
    listOpenMiniAppWindows.mockResolvedValue(["ma-1"]);
    useMiniAppWindowStore.setState({ runningIds: new Set(["ma-1"]) });
    await renderLibraryWithMiniApps();

    act(() => {
      fireEvent.click(
        within(cardFor("VPN Panel")).getByRole("button", { name: "Running" }),
      );
    });

    expect(openMiniAppWindow).not.toHaveBeenCalled();
  });

  it("Edit opens the editor for that mini-app", async () => {
    useUIStore.setState({ libraryTab: "miniapps" });
    useMiniAppStore.setState({
      miniapps: [makeMiniApp()],
      favorites: [],
      hydrated: true,
    });
    await renderLibraryWithMiniApps();

    act(() => {
      fireEvent.click(
        within(cardFor("VPN Panel")).getByRole("button", { name: "Edit" }),
      );
    });

    expect(useUIStore.getState().currentView).toBe("miniapp-editor");
    expect(useUIStore.getState().miniappEditorId).toBe("ma-1");
  });

  it("New Mini-App navigates to the editor with no target id", async () => {
    useUIStore.setState({
      libraryTab: "miniapps",
      miniappEditorId: "ma-1",
    });
    useMiniAppStore.setState({
      miniapps: [makeMiniApp({ id: "ma-1" })],
      favorites: [],
      hydrated: true,
    });
    await renderLibraryWithMiniApps();

    act(() => {
      fireEvent.click(
        screen.getByRole("button", { name: "Create mini-app" }),
      );
    });

    expect(useUIStore.getState().currentView).toBe("miniapp-editor");
    expect(useUIStore.getState().miniappEditorId).toBeNull();
  });

  it("right-click Delete raises a confirm dialog, and confirming removes the mini-app", async () => {
    useUIStore.setState({ libraryTab: "miniapps" });
    useMiniAppStore.setState({
      miniapps: [makeMiniApp()],
      favorites: [],
      hydrated: true,
    });
    await renderLibraryWithMiniApps();

    act(() => {
      fireEvent.contextMenu(cardFor("VPN Panel"));
    });
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    });

    expect(screen.getByText("Delete mini-app?")).toBeTruthy();
    expect(useMiniAppStore.getState().miniapps).toHaveLength(1);

    const dialog = screen.getByRole("dialog");
    act(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    });

    expect(useMiniAppStore.getState().miniapps).toEqual([]);
  });

  it("Favorite toggles the mini-app's favorite flag in the store", async () => {
    useUIStore.setState({ libraryTab: "miniapps" });
    useMiniAppStore.setState({
      miniapps: [makeMiniApp({ favorite: false })],
      favorites: [],
      hydrated: true,
    });
    await renderLibraryWithMiniApps();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Favorite" }));
    });

    expect(useMiniAppStore.getState().miniapps[0]?.favorite).toBe(true);
  });

  it("filters by search query", async () => {
    useUIStore.setState({ libraryTab: "miniapps" });
    useMiniAppStore.setState({
      miniapps: [
        makeMiniApp({ id: "ma-1", name: "VPN Panel", tags: ["network"] }),
        makeMiniApp({
          id: "ma-2",
          name: "Docker Tools",
          description: "Container helpers",
          tags: ["docker"],
        }),
      ],
      favorites: [],
      hydrated: true,
    });
    await renderLibraryWithMiniApps();

    const field = screen.getByPlaceholderText(
      "Search mini-apps by name, description, or tag…",
    );
    act(() => {
      fireEvent.change(field, { target: { value: "docker" } });
    });

    expect(screen.getByText("Docker Tools")).toBeTruthy();
    expect(screen.queryByText("VPN Panel")).toBeNull();
  });
});

