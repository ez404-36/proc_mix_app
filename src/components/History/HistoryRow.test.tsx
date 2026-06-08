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
