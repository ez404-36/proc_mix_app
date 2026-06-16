import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// Stub the history-store actions so we can assert what the buttons
// dispatch without exercising the real undo/restore flows.
const undoEditMock = vi.fn();
const restoreDeletedMock = vi.fn();
vi.mock("../../stores/historyStore", async () => {
  const real = await vi.importActual<
    typeof import("../../stores/historyStore")
  >("../../stores/historyStore");
  return {
    ...real,
    useHistoryStore: Object.assign(
      (selector: (state: unknown) => unknown) =>
        selector({
          undoEdit: undoEditMock,
          restoreDeleted: restoreDeletedMock,
        }),
      // Required by Zustand: actions module-level access.
      { getState: () => ({}), setState: vi.fn(), subscribe: vi.fn() },
    ),
  };
});

// Stub commandRepository so the real `useCommandStore` boot doesn't
// hit Tauri during test setup.
vi.mock("../../utils/commandRepository", () => ({
  upsertCommandInDb: vi.fn().mockResolvedValue(undefined),
  deleteCommandInDb: vi.fn().mockResolvedValue(undefined),
  listCommandsFromDb: vi.fn().mockResolvedValue([]),
}));

import "../../i18n";
import { useCommandStore } from "../../stores/commandStore";
import type { Command, HistoryEvent } from "../../types";
import { HistoryRow } from "./HistoryRow";

const sampleCommand: Command = {
  id: "cmd-1",
  name: "Greet",
  script: "echo hi",
  tags: [],
  favorite: false,
  createdAt: "2026-05-28T00:00:00Z",
  updatedAt: "2026-05-28T00:00:00Z",
  runCount: 0,
  runAsAdmin: false,
};

function commandEditedEvent(id: string, commandId: string): HistoryEvent {
  return {
    id,
    createdAt: "2026-05-28T12:00:00Z",
    kind: "commandEdited",
    commandId,
    commandName: "Greet",
    snapshotBefore: { ...sampleCommand, id: commandId, name: "Old" },
    snapshotAfter: { ...sampleCommand, id: commandId, name: "New" },
  };
}

function commandDeletedEvent(id: string, commandId: string): HistoryEvent {
  return {
    id,
    createdAt: "2026-05-28T13:00:00Z",
    kind: "commandDeleted",
    commandId,
    commandName: "Greet",
    snapshotBefore: { ...sampleCommand, id: commandId },
  };
}

function commandCreatedEvent(id: string, commandId: string): HistoryEvent {
  return {
    id,
    createdAt: "2026-05-28T14:00:00Z",
    kind: "commandCreated",
    commandId,
    commandName: "Greet",
    snapshotAfter: { ...sampleCommand, id: commandId },
  };
}

function workflowRunEvent(
  id: string,
  opts: { withOutput: boolean },
): HistoryEvent {
  return {
    id,
    createdAt: "2026-05-28T15:00:00Z",
    kind: "workflowRun",
    workflowId: "wf-1",
    workflowName: "Deploy",
    executionId: "run-1",
    exitCode: 0,
    durationMs: 12,
    status: "succeeded",
    ...(opts.withOutput
      ? { output: [{ stream: "stdout" as const, line: "built ok" }] }
      : {}),
  };
}

function commandRunEvent(
  id: string,
  opts: { withOutput: boolean },
): HistoryEvent {
  return {
    id,
    createdAt: "2026-05-28T16:00:00Z",
    kind: "commandRun",
    commandId: "cmd-x",
    commandName: "Greet",
    executionId: "exec-1",
    exitCode: 0,
    durationMs: 7,
    status: "succeeded",
    ...(opts.withOutput
      ? { output: [{ stream: "stdout" as const, line: "hello world" }] }
      : {}),
  };
}

beforeEach(() => {
  undoEditMock.mockReset();
  restoreDeletedMock.mockReset();
  useCommandStore.setState({
    commands: [],
    favorites: [],
    seedsInitialized: false,
    hydrated: true,
  });
});

afterEach(() => {
  useCommandStore.setState({
    commands: [],
    favorites: [],
    seedsInitialized: false,
    hydrated: true,
  });
});

describe("HistoryRow — Undo button visibility (commandEdited)", () => {
  it("shows Undo when the command still exists", () => {
    useCommandStore.setState({
      commands: [{ ...sampleCommand, id: "cmd-x" }],
    });
    render(<HistoryRow event={commandEditedEvent("e1", "cmd-x")} />);
    expect(screen.getByRole("button", { name: /undo/i })).toBeTruthy();
  });

  it("hides Undo when the command was later deleted", () => {
    useCommandStore.setState({ commands: [] });
    render(<HistoryRow event={commandEditedEvent("e1", "cmd-x")} />);
    expect(screen.queryByRole("button", { name: /undo/i })).toBeNull();
  });
});

describe("HistoryRow — Restore button visibility (commandDeleted)", () => {
  it("shows Restore when the command is currently absent", () => {
    useCommandStore.setState({ commands: [] });
    render(<HistoryRow event={commandDeletedEvent("e1", "cmd-x")} />);
    expect(screen.getByRole("button", { name: /restore/i })).toBeTruthy();
  });

  it("hides Restore when the command was restored (now present)", () => {
    useCommandStore.setState({
      commands: [{ ...sampleCommand, id: "cmd-x" }],
    });
    render(<HistoryRow event={commandDeletedEvent("e1", "cmd-x")} />);
    expect(screen.queryByRole("button", { name: /restore/i })).toBeNull();
  });
});

describe("HistoryRow — non-undoable kinds have no action buttons", () => {
  it("commandCreated has no Undo / Restore", () => {
    useCommandStore.setState({
      commands: [{ ...sampleCommand, id: "cmd-x" }],
    });
    render(<HistoryRow event={commandCreatedEvent("e1", "cmd-x")} />);
    expect(screen.queryByRole("button", { name: /undo/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /restore/i })).toBeNull();
  });
});

describe("HistoryRow — button click dispatches to the store", () => {
  it("Undo click calls undoEdit with the event id", () => {
    useCommandStore.setState({
      commands: [{ ...sampleCommand, id: "cmd-x" }],
    });
    render(<HistoryRow event={commandEditedEvent("e-undo", "cmd-x")} />);
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));
    expect(undoEditMock).toHaveBeenCalledWith("e-undo");
  });

  it("Restore click calls restoreDeleted with the event id", () => {
    useCommandStore.setState({ commands: [] });
    render(<HistoryRow event={commandDeletedEvent("e-restore", "cmd-x")} />);
    fireEvent.click(screen.getByRole("button", { name: /restore/i }));
    expect(restoreDeletedMock).toHaveBeenCalledWith("e-restore");
  });
});

describe("HistoryRow — run output disclosure (commandRun / workflowRun)", () => {
  it("renders an expandable disclosure with the captured output for a workflowRun WITH output", () => {
    const { container } = render(
      <HistoryRow event={workflowRunEvent("e-wf", { withOutput: true })} />,
    );
    // The row becomes a <details> disclosure revealing the persisted output.
    const details = container.querySelector("details.history-row__disclosure");
    expect(details).not.toBeNull();
    expect(screen.getByText("built ok")).toBeTruthy();
  });

  it("renders a captured output disclosure for a commandRun WITH output", () => {
    const { container } = render(
      <HistoryRow event={commandRunEvent("e-cmd", { withOutput: true })} />,
    );
    expect(
      container.querySelector("details.history-row__disclosure"),
    ).not.toBeNull();
    expect(screen.getByText("hello world")).toBeTruthy();
  });

  it("does NOT render a disclosure for a workflowRun WITHOUT persisted output (older row)", () => {
    const { container } = render(
      <HistoryRow event={workflowRunEvent("e-wf2", { withOutput: false })} />,
    );
    // A run with no persisted output stays a plain, non-expandable row so we
    // never show an empty expander for pre-persistence history.
    expect(container.querySelector("details")).toBeNull();
  });

  it("does NOT render a disclosure for a commandRun WITHOUT persisted output", () => {
    const { container } = render(
      <HistoryRow event={commandRunEvent("e-cmd2", { withOutput: false })} />,
    );
    expect(container.querySelector("details")).toBeNull();
  });
});
