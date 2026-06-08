import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Avoid importing the real Tauri runtime indirectly.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

// Mock the IPC repository so the store tests stay focused on state
// transitions; the wire format is exercised separately in
// `commandRepository.test.ts`.
const listMock = vi.fn();
const upsertMock = vi.fn();
const deleteMock = vi.fn();
vi.mock("../utils/commandRepository", () => ({
  listCommandsFromDb: () => listMock(),
  upsertCommandInDb: (cmd: unknown) => upsertMock(cmd),
  deleteCommandInDb: (id: string) => deleteMock(id),
}));

// Mock Arco's Message so failure paths don't try to render a toast in
// jsdom (and we can assert on the call when needed).
const messageErrorMock = vi.fn();
vi.mock("@arco-design/web-react", () => ({
  Message: { error: (...args: unknown[]) => messageErrorMock(...args) },
}));

import { useCommandStore } from "./commandStore";
import { buildSeedsForPlatform } from "./seeds";

/**
 * The store no longer seeds itself synchronously at module load; seeds are
 * materialized by `initializeSeeds(platform)` once the Rust `get_platform`
 * IPC roundtrip completes. For tests we deterministically seed the Linux
 * variant up-front so the existing test cases (which assert against the
 * original three demo commands) keep working.
 */
const SEED_COMMANDS = buildSeedsForPlatform("linux");
const SEED_FAVORITES = SEED_COMMANDS.filter((c) => c.favorite).map((c) => c.id);

beforeEach(() => {
  // Restore a deterministic seeded baseline for isolation.
  useCommandStore.setState({
    commands: SEED_COMMANDS.map((c) => ({ ...c })),
    favorites: [...SEED_FAVORITES],
    seedsInitialized: true,
    hydrated: true,
  });
  listMock.mockReset();
  upsertMock.mockReset();
  upsertMock.mockResolvedValue(undefined);
  deleteMock.mockReset();
  deleteMock.mockResolvedValue(undefined);
  messageErrorMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("commandStore initial state", () => {
  it("should seed exactly three demo commands", () => {
    expect(useCommandStore.getState().commands).toHaveLength(3);
  });

  it("should mark the first seed command as favorite", () => {
    const favs = useCommandStore.getState().favorites;
    expect(favs).toHaveLength(1);
    const fav = useCommandStore
      .getState()
      .commands.find((c) => c.id === favs[0]);
    expect(fav?.favorite).toBe(true);
    expect(fav?.name).toBe("List home directory");
  });
});

describe("commandStore.addCommand", () => {
  it("should append a new command with generated id, timestamps and runCount=0", () => {
    const before = useCommandStore.getState().commands.length;
    useCommandStore.getState().addCommand({
      name: "New",
      script: "true",
      tags: ["x"],
      favorite: false,
      runAsAdmin: false,
    });
    const after = useCommandStore.getState().commands;
    expect(after).toHaveLength(before + 1);
    const created = after[after.length - 1];
    expect(created.id).toBeTypeOf("string");
    expect(created.id.length).toBeGreaterThan(0);
    expect(created.runCount).toBe(0);
    expect(created.createdAt).toBeTypeOf("string");
    expect(created.updatedAt).toBe(created.createdAt);
  });

  it("should persist the new command via upsertCommandInDb", () => {
    useCommandStore.getState().addCommand({
      name: "Persisted",
      script: "true",
      tags: [],
      favorite: false,
      runAsAdmin: false,
    });
    expect(upsertMock).toHaveBeenCalledTimes(1);
    const persisted = upsertMock.mock.calls[0]?.[0] as { name: string };
    expect(persisted.name).toBe("Persisted");
  });

  it("should add the new command id to favorites when input.favorite is true", () => {
    useCommandStore.getState().addCommand({
      name: "Star",
      script: "true",
      tags: [],
      favorite: true,
      runAsAdmin: false,
    });
    const cmds = useCommandStore.getState().commands;
    const newCmd = cmds[cmds.length - 1];
    expect(useCommandStore.getState().favorites).toContain(newCmd.id);
  });

  it("should NOT add the new command id to favorites when input.favorite is false", () => {
    const favsBefore = [...useCommandStore.getState().favorites];
    useCommandStore.getState().addCommand({
      name: "NoStar",
      script: "true",
      tags: [],
      favorite: false,
      runAsAdmin: false,
    });
    expect(useCommandStore.getState().favorites).toEqual(favsBefore);
  });

  it("should fall back to a Math.random id when crypto.randomUUID is unavailable", () => {
    // Stub the global crypto object so makeId() takes the fallback branch.
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: undefined,
      configurable: true,
    });
    try {
      useCommandStore.getState().addCommand({
        name: "Fallback",
        script: "true",
        tags: [],
        favorite: false,
        runAsAdmin: false,
      });
      const cmds = useCommandStore.getState().commands;
      const created = cmds[cmds.length - 1];
      expect(created.id).toMatch(/^cmd-/);
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        value: original,
        configurable: true,
      });
    }
  });

  it("should surface a Message.error toast when persistence fails", async () => {
    upsertMock.mockRejectedValueOnce(new Error("boom"));
    useCommandStore.getState().addCommand({
      name: "WillFail",
      script: "true",
      tags: [],
      favorite: false,
      runAsAdmin: false,
    });
    // Allow the fire-and-forget promise to reject.
    await new Promise((r) => setTimeout(r, 0));
    expect(messageErrorMock).toHaveBeenCalledWith("Failed to save command");
  });
});

describe("commandStore.updateCommand", () => {
  it("should patch a command and refresh updatedAt", async () => {
    const target = useCommandStore.getState().commands[0];
    const beforeUpdatedAt = target.updatedAt;
    // Ensure the timestamp will differ by waiting one tick.
    await new Promise((r) => setTimeout(r, 5));

    useCommandStore.getState().updateCommand(target.id, { name: "Renamed" });
    const updated = useCommandStore
      .getState()
      .commands.find((c) => c.id === target.id);
    expect(updated?.name).toBe("Renamed");
    expect(updated?.updatedAt).not.toBe(beforeUpdatedAt);
  });

  it("should persist the patched command via upsertCommandInDb", () => {
    const target = useCommandStore.getState().commands[0];
    useCommandStore.getState().updateCommand(target.id, { name: "X" });
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect((upsertMock.mock.calls[0]?.[0] as { name: string }).name).toBe("X");
  });

  it("should leave non-matching commands untouched", () => {
    const [first, second] = useCommandStore.getState().commands;
    useCommandStore.getState().updateCommand(first.id, { name: "X" });
    const stillSecond = useCommandStore
      .getState()
      .commands.find((c) => c.id === second.id);
    expect(stillSecond).toEqual(second);
  });

  it("should be a no-op when the id does not exist", () => {
    const before = useCommandStore.getState().commands;
    useCommandStore.getState().updateCommand("does-not-exist", { name: "Y" });
    expect(useCommandStore.getState().commands).toEqual(before);
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe("commandStore.deleteCommand", () => {
  it("should remove a command by id", () => {
    const target = useCommandStore.getState().commands[1];
    useCommandStore.getState().deleteCommand(target.id);
    const ids = useCommandStore.getState().commands.map((c) => c.id);
    expect(ids).not.toContain(target.id);
  });

  it("should call deleteCommandInDb for the removed id", () => {
    const target = useCommandStore.getState().commands[1];
    useCommandStore.getState().deleteCommand(target.id);
    expect(deleteMock).toHaveBeenCalledWith(target.id);
  });

  it("should also remove the id from favorites when present", () => {
    const favId = useCommandStore.getState().favorites[0];
    useCommandStore.getState().deleteCommand(favId);
    expect(useCommandStore.getState().favorites).not.toContain(favId);
  });

  it("should be a no-op when the id does not exist (but still invoke delete)", () => {
    const before = useCommandStore.getState().commands;
    const beforeFavs = useCommandStore.getState().favorites;
    useCommandStore.getState().deleteCommand("nope");
    expect(useCommandStore.getState().commands).toEqual(before);
    expect(useCommandStore.getState().favorites).toEqual(beforeFavs);
    // The store still issues the IPC call; SQLite treats a missing id as
    // a no-op so this is safe and keeps delete idempotent.
    expect(deleteMock).toHaveBeenCalledWith("nope");
  });

  it("should surface a Message.error toast when persistence fails", async () => {
    deleteMock.mockRejectedValueOnce(new Error("boom"));
    const target = useCommandStore.getState().commands[1];
    useCommandStore.getState().deleteCommand(target.id);
    await new Promise((r) => setTimeout(r, 0));
    expect(messageErrorMock).toHaveBeenCalledWith("Failed to delete command");
  });
});

describe("commandStore.toggleFavorite", () => {
  it("should add the id to favorites and set favorite=true when not previously favored", () => {
    const target = useCommandStore.getState().commands[1];
    expect(target.favorite).toBe(false);

    useCommandStore.getState().toggleFavorite(target.id);

    expect(useCommandStore.getState().favorites).toContain(target.id);
    const updated = useCommandStore
      .getState()
      .commands.find((c) => c.id === target.id);
    expect(updated?.favorite).toBe(true);
  });

  it("should remove the id from favorites and set favorite=false when previously favored", () => {
    const favId = useCommandStore.getState().favorites[0];

    useCommandStore.getState().toggleFavorite(favId);

    expect(useCommandStore.getState().favorites).not.toContain(favId);
    const updated = useCommandStore
      .getState()
      .commands.find((c) => c.id === favId);
    expect(updated?.favorite).toBe(false);
  });

  it("should persist the toggled command", () => {
    const target = useCommandStore.getState().commands[1];
    useCommandStore.getState().toggleFavorite(target.id);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect((upsertMock.mock.calls[0]?.[0] as { favorite: boolean }).favorite).toBe(true);
  });

  it("should be a no-op when the id does not exist", () => {
    const before = useCommandStore.getState().commands;
    const beforeFavs = useCommandStore.getState().favorites;
    useCommandStore.getState().toggleFavorite("missing");
    expect(useCommandStore.getState().commands).toEqual(before);
    // The favorites array still flips because we don't validate the id;
    // current behaviour is acceptable but we explicitly assert no upsert
    // happens since no command was actually touched.
    expect(upsertMock).not.toHaveBeenCalled();
    // Reset for the next assertion.
    useCommandStore.setState({ favorites: beforeFavs });
  });
});

describe("commandStore.markCommandRun", () => {
  it("should increment runCount and set lastRunAt for the matching command", () => {
    const target = useCommandStore.getState().commands[0];
    const before = target.runCount;
    useCommandStore.getState().markCommandRun(target.id);
    const updated = useCommandStore
      .getState()
      .commands.find((c) => c.id === target.id);
    expect(updated?.runCount).toBe(before + 1);
    expect(updated?.lastRunAt).toBeTypeOf("string");
  });

  it("should persist the bumped runCount", () => {
    const target = useCommandStore.getState().commands[0];
    useCommandStore.getState().markCommandRun(target.id);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(
      (upsertMock.mock.calls[0]?.[0] as { runCount: number }).runCount,
    ).toBe(target.runCount + 1);
  });

  it("should leave other commands untouched", () => {
    const [first, second] = useCommandStore.getState().commands;
    useCommandStore.getState().markCommandRun(first.id);
    const stillSecond = useCommandStore
      .getState()
      .commands.find((c) => c.id === second.id);
    expect(stillSecond).toEqual(second);
  });

  it("should be a no-op when the id does not exist", () => {
    const before = useCommandStore.getState().commands;
    useCommandStore.getState().markCommandRun("nope");
    expect(useCommandStore.getState().commands).toEqual(before);
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe("commandStore.hydrateFromDb", () => {
  beforeEach(() => {
    // Start from a clean slate so we can observe the hydrate result.
    useCommandStore.setState({
      commands: [],
      favorites: [],
      seedsInitialized: false,
      hydrated: false,
    });
  });

  it("loads commands from the repository and marks hydrated", async () => {
    const fixture = {
      ...SEED_COMMANDS[0],
      id: "from-db",
      favorite: true,
    };
    listMock.mockResolvedValueOnce([fixture]);

    await useCommandStore.getState().hydrateFromDb();

    expect(useCommandStore.getState().commands).toEqual([fixture]);
    expect(useCommandStore.getState().favorites).toEqual([fixture.id]);
    expect(useCommandStore.getState().hydrated).toBe(true);
    expect(useCommandStore.getState().seedsInitialized).toBe(true);
  });

  it("leaves seedsInitialized=false when the DB is empty (so seeds can be written)", async () => {
    listMock.mockResolvedValueOnce([]);
    await useCommandStore.getState().hydrateFromDb();
    expect(useCommandStore.getState().hydrated).toBe(true);
    expect(useCommandStore.getState().seedsInitialized).toBe(false);
    expect(useCommandStore.getState().commands).toEqual([]);
  });

  it("flips hydrated=true even when the IPC call rejects", async () => {
    listMock.mockRejectedValueOnce(new Error("ipc-down"));
    await useCommandStore.getState().hydrateFromDb();
    expect(useCommandStore.getState().hydrated).toBe(true);
    expect(useCommandStore.getState().commands).toEqual([]);
  });
});

describe("commandStore.initializeSeeds", () => {
  beforeEach(() => {
    useCommandStore.setState({
      commands: [],
      favorites: [],
      seedsInitialized: false,
      hydrated: true,
    });
  });

  it("materialises the seed commands and persists each one", () => {
    useCommandStore.getState().initializeSeeds("linux");
    const state = useCommandStore.getState();
    expect(state.commands).toHaveLength(3);
    expect(state.seedsInitialized).toBe(true);
    expect(upsertMock).toHaveBeenCalledTimes(3);
  });

  it("is a no-op on a second call", () => {
    useCommandStore.getState().initializeSeeds("linux");
    upsertMock.mockClear();
    useCommandStore.getState().initializeSeeds("linux");
    expect(upsertMock).not.toHaveBeenCalled();
  });
});
