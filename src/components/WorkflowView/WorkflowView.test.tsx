// Tests for the read-only WorkflowView modal. Its body is the same reactflow
// canvas the editor renders, so reactflow is mocked to lightweight stubs (the
// real canvas needs a layout engine / ResizeObserver jsdom lacks). The value
// here is the modal wiring — header, metadata, and the Edit / Run / Close
// callbacks — not reactflow's own rendering.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

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

import "../../i18n";
import { useCommandStore } from "../../stores/commandStore";
import type { Command, Workflow } from "../../types";
import { WorkflowView } from "./WorkflowView";

function makeCommand(overrides: Partial<Command> = {}): Command {
  return {
    id: "cmd-1",
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
    tags: ["ci", "deploy"],
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
}

beforeEach(resetStores);
afterEach(resetStores);

describe("WorkflowView", () => {
  it("renders nothing when workflow is null", () => {
    const { container } = render(
      <WorkflowView
        workflow={null}
        onClose={vi.fn()}
        onEdit={vi.fn()}
        onRun={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the workflow's name, description, tags, and the canvas", () => {
    render(
      <WorkflowView
        workflow={makeWorkflow()}
        onClose={vi.fn()}
        onEdit={vi.fn()}
        onRun={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("Deploy pipeline")).toBeTruthy();
    expect(screen.getByText("Build, test, ship")).toBeTruthy();
    expect(screen.getByText("ci")).toBeTruthy();
    expect(screen.getByText("deploy")).toBeTruthy();
    // The read-only canvas (mocked) is mounted as the modal body.
    expect(screen.getByTestId("reactflow")).toBeTruthy();
  });

  it("fires onEdit / onRun / onClose from the footer buttons", () => {
    const onEdit = vi.fn();
    const onRun = vi.fn();
    const onClose = vi.fn();
    const wf = makeWorkflow();
    render(
      <WorkflowView
        workflow={wf}
        onClose={onClose}
        onEdit={onEdit}
        onRun={onRun}
        onDelete={vi.fn()}
      />,
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    });
    expect(onEdit).toHaveBeenCalledWith(wf);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
    });
    expect(onRun).toHaveBeenCalledWith(wf);

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Esc and on backdrop click", () => {
    const onClose = vi.fn();
    render(
      <WorkflowView
        workflow={makeWorkflow()}
        onClose={onClose}
        onEdit={vi.fn()}
        onRun={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog");
    act(() => {
      fireEvent.keyDown(dialog, { key: "Escape" });
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    // The backdrop is the dialog's parent; clicking it (target === backdrop)
    // closes. parentElement is the `.command-form__backdrop`.
    const backdrop = dialog.parentElement as HTMLElement;
    act(() => {
      fireEvent.click(backdrop);
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
