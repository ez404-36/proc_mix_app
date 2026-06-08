import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recordMock = vi.fn();

vi.mock("../utils/historyRepository", () => ({
  recordHistoryEventInDb: (...args: unknown[]) => recordMock(...args),
}));

vi.mock("@arco-design/web-react", () => ({
  Message: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// Use the real commandStore — we want to verify the wrapper composes
// correctly with the actual addCommand/updateCommand/deleteCommand
// implementations, not a stub.
import { useCommandStore } from "../stores/commandStore";
// commandStore depends on the repository (upsertCommandInDb / delete).
// Stub those so the test never tries to invoke Tauri.
vi.mock("../utils/commandRepository", () => ({
  upsertCommandInDb: vi.fn().mockResolvedValue(undefined),
  deleteCommandInDb: vi.fn().mockResolvedValue(undefined),
  listCommandsFromDb: vi.fn().mockResolvedValue([]),
}));

import type { Command, HistoryEvent } from "../types";
import {
  createCommand,
  deleteCommand,
  updateCommand,
} from "./commandActions";

beforeEach(() => {
  recordMock.mockReset();
  recordMock.mockResolvedValue("logged-id");
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

describe("createCommand", () => {
  it("adds a command to the store and records a commandCreated event", () => {
    const c = createCommand({
      name: "Greet",
      script: "echo hi",
      tags: [],
      favorite: false,
      runAsAdmin: false,
    });
    expect(c.id).toBeTruthy();
    expect(useCommandStore.getState().commands).toHaveLength(1);
    expect(recordMock).toHaveBeenCalledTimes(1);
    const evt = recordMock.mock.calls[0]?.[0] as HistoryEvent;
    expect(evt.kind).toBe("commandCreated");
    if (evt.kind !== "commandCreated") throw new Error("kind narrowing");
    expect(evt.commandId).toBe(c.id);
    expect(evt.snapshotAfter.name).toBe("Greet");
  });
});

describe("updateCommand", () => {
  it("patches and records commandEdited with both snapshots", () => {
    const c = createCommand({
      name: "Greet",
      script: "echo hi",
      tags: [],
      favorite: false,
      runAsAdmin: false,
    });
    recordMock.mockClear();
    const result = updateCommand(c.id, { name: "Greet 2" });
    expect(result?.before.name).toBe("Greet");
    expect(result?.after.name).toBe("Greet 2");
    expect(recordMock).toHaveBeenCalledTimes(1);
    const evt = recordMock.mock.calls[0]?.[0] as HistoryEvent;
    if (evt.kind !== "commandEdited") throw new Error("kind narrowing");
    expect(evt.snapshotBefore.name).toBe("Greet");
    expect(evt.snapshotAfter.name).toBe("Greet 2");
  });

  it("returns null and records nothing for unknown id", () => {
    const result = updateCommand("nope", { name: "x" });
    expect(result).toBeNull();
    expect(recordMock).not.toHaveBeenCalled();
  });
});

describe("deleteCommand", () => {
  it("removes from store and records commandDeleted with the snapshot", () => {
    const c = createCommand({
      name: "Greet",
      script: "echo hi",
      tags: [],
      favorite: false,
      runAsAdmin: false,
    });
    recordMock.mockClear();
    const removed = deleteCommand(c.id);
    expect(removed?.id).toBe(c.id);
    expect(useCommandStore.getState().commands).toHaveLength(0);
    expect(recordMock).toHaveBeenCalledTimes(1);
    const evt = recordMock.mock.calls[0]?.[0] as HistoryEvent;
    if (evt.kind !== "commandDeleted") throw new Error("kind narrowing");
    expect(evt.snapshotBefore.id).toBe(c.id);
  });

  it("returns null and records nothing when the id is unknown", () => {
    const removed = deleteCommand("does-not-exist");
    expect(removed).toBeNull();
    expect(recordMock).not.toHaveBeenCalled();
  });
});

describe("history-write failure does NOT roll back the action", () => {
  it("keeps the new command in the store even when recordHistoryEventInDb rejects", async () => {
    recordMock.mockReset();
    recordMock.mockRejectedValueOnce(new Error("disk full"));
    const c: Command = createCommand({
      name: "Greet",
      script: "echo hi",
      tags: [],
      favorite: false,
      runAsAdmin: false,
    });
    // Flush the rejected promise without crashing the test runner.
    await new Promise((r) => setTimeout(r, 0));
    expect(useCommandStore.getState().commands).toHaveLength(1);
    expect(useCommandStore.getState().commands[0]?.id).toBe(c.id);
  });
});
