// Smoke test for the full-screen CommandEditor view:
//
//   - renders the CommandForm for a create / edit target;
//   - reports dirtiness up to the uiStore as the user types;
//   - the unsaved-changes ConfirmDialog gates navigation when dirty;
//   - an invalid target bounces back to the library.
//
// We mock the same executor / IPC / Tauri surfaces CommandForm needs so the
// component renders without a backend, plus the history-aware command
// actions so no repository runs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../../utils/executor", () => ({
  runCommand: vi.fn(),
  cancelExecution: vi.fn(),
  subscribeExecutionEvents: vi.fn(() => () => {}),
  awaitBridgeReady: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@arco-design/web-react", () => ({
  Message: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("../../utils/adminPassword", () => ({
  hasAdminPassword: vi.fn().mockResolvedValue(false),
  isAdminPasswordRequiredError: vi.fn().mockReturnValue(false),
  setAdminPassword: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../utils/adminPasswordPrompt", () => ({
  promptForAdminPassword: vi.fn().mockResolvedValue(null),
}));

const triggerCommandRun = vi.fn().mockResolvedValue("exec-1");
vi.mock("../../services/commandRunner", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../services/commandRunner")>();
  return {
    ...actual,
    triggerCommandRun: (...args: unknown[]) => triggerCommandRun(...args),
  };
});
vi.mock("../../utils/platform", () => ({
  getCachedPlatform: vi.fn().mockReturnValue("linux"),
}));
vi.mock("../../utils/shells", () => ({
  getCachedAvailableShells: vi.fn().mockReturnValue(["bash"]),
}));

import "../../i18n";
import { ContextMenuProvider } from "../ContextMenu";
import { useUIStore } from "../../stores/uiStore";
import { useCommandStore } from "../../stores/commandStore";
import { useExecutionStore } from "../../stores/executionStore";
import { useWorkflowStore } from "../../stores/workflowStore";
import type { Command, Workflow } from "../../types";
import { CommandEditor } from "./CommandEditor";

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf-1",
    name: "Deploy pipeline",
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

function reset(): void {
  useCommandStore.setState({
    commands: [],
    favorites: [],
    seedsInitialized: true,
    hydrated: true,
  });
  useUIStore.setState({
    currentView: "command-editor",
    commandEditorTarget: { mode: "create", commandId: null },
    commandEditorDirty: false,
    pendingNavigation: null,
  });
  useExecutionStore.setState({
    executions: {},
    recentIds: [],
    activeExecutionId: null,
    panelOpen: false,
  });
  useWorkflowStore.setState({ workflows: [], hydrated: true });
}

function renderEditor(): void {
  render(
    <ContextMenuProvider>
      <CommandEditor />
    </ContextMenuProvider>,
  );
}

HTMLElement.prototype.scrollIntoView = (): void => {};

beforeEach(() => reset());
afterEach(() => reset());

describe("CommandEditor view", () => {
  it("renders the create form with the create title", () => {
    renderEditor();
    // The view header shows the create title; the name field is present.
    expect(screen.getAllByText("New command").length).toBeGreaterThan(0);
    expect(screen.getByPlaceholderText(/Restart dev server/i)).toBeTruthy();
  });

  it("reports dirtiness to the store as the user types", () => {
    renderEditor();
    expect(useUIStore.getState().commandEditorDirty).toBe(false);

    act(() => {
      fireEvent.change(screen.getByPlaceholderText(/Restart dev server/i), {
        target: { value: "My command" },
      });
    });

    expect(useUIStore.getState().commandEditorDirty).toBe(true);
  });

  it("shows the unsaved-changes confirm when navigation is pending", () => {
    useUIStore.setState({
      commandEditorDirty: true,
      pendingNavigation: "library",
    });
    renderEditor();

    expect(screen.getByText("Discard unsaved changes?")).toBeTruthy();
  });

  it("bounces back to the library when the edit target is missing", () => {
    // Edit target referencing a command that does not exist.
    useUIStore.setState({
      commandEditorTarget: { mode: "edit", commandId: "missing" },
    });
    renderEditor();

    expect(useUIStore.getState().currentView).toBe("library");
    expect(useUIStore.getState().commandEditorTarget).toBeNull();
  });

  it("resolves an existing edit target and pre-fills the form", () => {
    useCommandStore.setState({
      commands: [makeCommand({ id: "c-1", name: "Build app" })],
      favorites: [],
      seedsInitialized: true,
      hydrated: true,
    });
    useUIStore.setState({
      commandEditorTarget: { mode: "edit", commandId: "c-1" },
    });
    renderEditor();

    const nameInput = screen.getByPlaceholderText(
      /Restart dev server/i,
    ) as HTMLInputElement;
    expect(nameInput.value).toBe("Build app");
  });

  it("Run routes to the global console (triggerCommandRun), not an embedded panel", () => {
    triggerCommandRun.mockClear();
    useCommandStore.setState({
      commands: [makeCommand({ id: "c-1", name: "Build app", script: "echo hi" })],
      favorites: [],
      seedsInitialized: true,
      hydrated: true,
    });
    useUIStore.setState({
      commandEditorTarget: { mode: "edit", commandId: "c-1" },
    });
    renderEditor();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
    });

    expect(triggerCommandRun).toHaveBeenCalledTimes(1);
    const arg = triggerCommandRun.mock.calls[0]?.[0] as { script: string };
    expect(arg.script).toBe("echo hi");
    // The editor uses the global console — no embedded live-output panel.
    expect(document.querySelector(".command-form__output-section")).toBeNull();
  });

  it("auto-fills the Output-tab sample with the finished global run's stdout", async () => {
    triggerCommandRun.mockClear();
    triggerCommandRun.mockResolvedValue("exec-1");
    useCommandStore.setState({
      commands: [makeCommand({ id: "c-1", name: "Build app", script: "echo hi" })],
      favorites: [],
      seedsInitialized: true,
      hydrated: true,
    });
    useUIStore.setState({
      commandEditorTarget: { mode: "edit", commandId: "c-1" },
    });
    renderEditor();

    // Launch the run; the form starts tracking execution "exec-1".
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
    });

    // Simulate the run finishing with stdout in the execution store.
    act(() => {
      useExecutionStore.setState({
        executions: {
          "exec-1": {
            id: "exec-1",
            commandId: "c-1",
            commandName: "Build app",
            status: "success",
            startedAt: Date.now(),
            finishedAt: Date.now(),
            log: [{ stream: "stdout", line: "hello world", ts: Date.now() }],
          },
        },
        recentIds: ["exec-1"],
        activeExecutionId: "exec-1",
      });
    });

    // Open the Output tab and enable the schema so the sample field shows.
    fireEvent.click(screen.getByRole("tab", { name: /Output schema/ }));
    fireEvent.click(screen.getByRole("checkbox"));

    // The sample textarea is auto-filled from the run's stdout.
    await waitFor(() => {
      const sample = screen.getByPlaceholderText(
        /paste sample stdout/i,
      ) as HTMLTextAreaElement;
      expect(sample.value).toBe("hello world");
    });
  });

  it("renders the workflow-scoped title for a local create", () => {
    useWorkflowStore.setState({
      workflows: [makeWorkflow({ id: "wf-1", name: "Deploy pipeline" })],
      hydrated: true,
    });
    useUIStore.setState({
      commandEditorTarget: {
        mode: "create",
        commandId: null,
        initialScope: "local",
        initialWorkflowId: "wf-1",
      },
    });
    renderEditor();

    expect(
      screen.getAllByText('New command (workflow "Deploy pipeline")').length,
    ).toBeGreaterThan(0);
  });

  it("closing a local create returns to the workflow editor", () => {
    useWorkflowStore.setState({
      workflows: [makeWorkflow({ id: "wf-1", name: "Deploy pipeline" })],
      hydrated: true,
    });
    useUIStore.setState({
      commandEditorTarget: {
        mode: "create",
        commandId: null,
        initialScope: "local",
        initialWorkflowId: "wf-1",
      },
      commandEditorDirty: false,
    });
    renderEditor();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    expect(useUIStore.getState().currentView).toBe("editor");
  });

  it("closing a normal create returns to the library", () => {
    useUIStore.setState({
      commandEditorTarget: { mode: "create", commandId: null },
      commandEditorDirty: false,
    });
    renderEditor();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    expect(useUIStore.getState().currentView).toBe("library");
    expect(useUIStore.getState().libraryTab).toBe("commands");
  });
});
