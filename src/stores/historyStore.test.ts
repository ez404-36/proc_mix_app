import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocked module surface — we stub the repository so we never cross
// the Tauri boundary in unit tests, but we DO exercise the store's
// real reducer logic and conversion via `toWireFilter`.
const listHistoryFromDbMock = vi.fn();
const getHistoryEventFromDbMock = vi.fn();
const recordHistoryEventInDbMock = vi.fn();
const clearHistoryInDbMock = vi.fn();
const deleteHistoryEventInDbMock = vi.fn();
const upsertCommandInDbMock = vi.fn();

vi.mock("../utils/historyRepository", () => ({
  listHistoryFromDb: (...args: unknown[]) =>
    listHistoryFromDbMock(...args),
  getHistoryEventFromDb: (...args: unknown[]) =>
    getHistoryEventFromDbMock(...args),
  recordHistoryEventInDb: (...args: unknown[]) =>
    recordHistoryEventInDbMock(...args),
  clearHistoryInDb: (...args: unknown[]) => clearHistoryInDbMock(...args),
  deleteHistoryEventInDb: (...args: unknown[]) =>
    deleteHistoryEventInDbMock(...args),
}));

vi.mock("../utils/commandRepository", async () => {
  const real = await vi.importActual<
    typeof import("../utils/commandRepository")
  >("../utils/commandRepository");
  return {
    ...real,
    upsertCommandInDb: (...args: unknown[]) =>
      upsertCommandInDbMock(...args),
  };
});

// Silence Arco's Message side effects during tests.
vi.mock("@arco-design/web-react", () => ({
  Message: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import type { Command, HistoryEvent } from "../types";
import { useCommandStore } from "./commandStore";
import {
  HISTORY_PAGE_SIZE,
  __test__,
  useHistoryStore,
} from "./historyStore";

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

function resetCommandStore(): void {
  useCommandStore.setState({
    commands: [],
    favorites: [],
    seedsInitialized: false,
    hydrated: true,
  });
}

function resetHistoryStore(): void {
  useHistoryStore.setState({
    items: [],
    total: 0,
    page: 1,
    pageSize: HISTORY_PAGE_SIZE,
    filter: __test__.EMPTY_FILTER,
    loading: false,
    error: undefined,
  });
}

beforeEach(() => {
  listHistoryFromDbMock.mockReset();
  getHistoryEventFromDbMock.mockReset();
  recordHistoryEventInDbMock.mockReset();
  clearHistoryInDbMock.mockReset();
  deleteHistoryEventInDbMock.mockReset();
  upsertCommandInDbMock.mockReset();
  resetCommandStore();
  resetHistoryStore();
});

afterEach(() => {
  resetCommandStore();
  resetHistoryStore();
});

describe("toWireFilter", () => {
  it("drops empty kinds array and empty nameQuery", () => {
    const wire = __test__.toWireFilter({
      kinds: [],
      nameQuery: "",
      failedOnly: false,
    });
    expect(wire).toEqual({});
  });

  it("trims nameQuery before sending", () => {
    const wire = __test__.toWireFilter({
      kinds: [],
      nameQuery: "  deploy  ",
      failedOnly: false,
    });
    expect(wire.commandNameQuery).toBe("deploy");
  });

  it("treats whitespace-only nameQuery as empty", () => {
    const wire = __test__.toWireFilter({
      kinds: [],
      nameQuery: "   ",
      failedOnly: false,
    });
    expect(wire.commandNameQuery).toBeUndefined();
  });

  it("forwards kinds list and date range when present", () => {
    const wire = __test__.toWireFilter({
      kinds: ["commandRun"],
      nameQuery: "x",
      dateFrom: "2026-01-01T00:00:00Z",
      dateTo: "2026-12-31T23:59:59Z",
      failedOnly: false,
    });
    expect(wire).toEqual({
      kinds: ["commandRun"],
      commandNameQuery: "x",
      dateFrom: "2026-01-01T00:00:00Z",
      dateTo: "2026-12-31T23:59:59Z",
    });
  });
});

describe("load", () => {
  it("populates items/total/page from the repository", async () => {
    listHistoryFromDbMock.mockResolvedValueOnce({
      items: [
        {
          id: "e1",
          createdAt: "2026-05-28T00:00:00Z",
          kind: "commandCreated",
          commandId: "cmd-1",
          commandName: "Greet",
          snapshotAfter: sampleCommand,
        } satisfies HistoryEvent,
      ],
      total: 1,
      page: 1,
      pageSize: HISTORY_PAGE_SIZE,
    });
    await useHistoryStore.getState().load();
    expect(useHistoryStore.getState().items).toHaveLength(1);
    expect(useHistoryStore.getState().total).toBe(1);
    expect(useHistoryStore.getState().loading).toBe(false);
    expect(useHistoryStore.getState().error).toBeUndefined();
  });

  it("captures error message on failure and clears loading", async () => {
    listHistoryFromDbMock.mockRejectedValueOnce(new Error("boom"));
    await useHistoryStore.getState().load();
    expect(useHistoryStore.getState().loading).toBe(false);
    expect(useHistoryStore.getState().error).toBe("boom");
  });
});

describe("setFilter / resetFilter / setPage", () => {
  it("setFilter resets page to 1 and triggers a load", async () => {
    listHistoryFromDbMock.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: HISTORY_PAGE_SIZE,
    });
    useHistoryStore.setState({ page: 3 });
    useHistoryStore.getState().setFilter({ nameQuery: "deploy" });
    // The state is updated synchronously; the load is fire-and-forget.
    expect(useHistoryStore.getState().page).toBe(1);
    expect(useHistoryStore.getState().filter.nameQuery).toBe("deploy");
    // Await microtask for the void-promise inside setFilter.
    await Promise.resolve();
    await Promise.resolve();
    expect(listHistoryFromDbMock).toHaveBeenCalled();
  });

  it("resetFilter clears every field and goes back to page 1", () => {
    listHistoryFromDbMock.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: HISTORY_PAGE_SIZE,
    });
    useHistoryStore.setState({
      page: 5,
      filter: {
        kinds: ["commandRun"],
        nameQuery: "x",
        dateFrom: "2026-01-01T00:00:00Z",
        failedOnly: false,
      },
    });
    useHistoryStore.getState().resetFilter();
    expect(useHistoryStore.getState().filter).toEqual(__test__.EMPTY_FILTER);
    expect(useHistoryStore.getState().page).toBe(1);
  });

  it("setPage clamps to >= 1", () => {
    listHistoryFromDbMock.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: HISTORY_PAGE_SIZE,
    });
    useHistoryStore.getState().setPage(0);
    expect(useHistoryStore.getState().page).toBe(1);
    useHistoryStore.getState().setPage(-7);
    expect(useHistoryStore.getState().page).toBe(1);
  });
});

describe("undoEdit", () => {
  it("upserts snapshotBefore, records commandReverted, reloads", async () => {
    const before: Command = { ...sampleCommand, name: "Original" };
    const after: Command = { ...sampleCommand, name: "Edited" };
    const editEvent: HistoryEvent = {
      id: "e-edit",
      createdAt: "2026-05-28T00:00:00Z",
      kind: "commandEdited",
      commandId: "cmd-1",
      commandName: "Edited",
      snapshotBefore: before,
      snapshotAfter: after,
    };
    getHistoryEventFromDbMock.mockResolvedValueOnce(editEvent);
    recordHistoryEventInDbMock.mockResolvedValueOnce("e-revert");
    upsertCommandInDbMock.mockResolvedValueOnce(undefined);
    listHistoryFromDbMock.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: HISTORY_PAGE_SIZE,
    });
    // Seed the command store as if `after` is currently in there.
    useCommandStore.setState({ commands: [after], favorites: [] });

    await useHistoryStore.getState().undoEdit("e-edit");

    expect(upsertCommandInDbMock).toHaveBeenCalledWith(before);
    expect(useCommandStore.getState().commands[0]?.name).toBe("Original");
    const recorded = recordHistoryEventInDbMock.mock
      .calls[0]?.[0] as HistoryEvent;
    expect(recorded?.kind).toBe("commandReverted");
    if (recorded?.kind === "commandReverted") {
      expect(recorded.originalEventId).toBe("e-edit");
    }
  });

  it("shows error and reloads when the source event is missing", async () => {
    getHistoryEventFromDbMock.mockResolvedValueOnce(null);
    listHistoryFromDbMock.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: HISTORY_PAGE_SIZE,
    });
    await useHistoryStore.getState().undoEdit("missing");
    expect(upsertCommandInDbMock).not.toHaveBeenCalled();
    expect(recordHistoryEventInDbMock).not.toHaveBeenCalled();
  });

  it("ignores source events whose kind isn't commandEdited", async () => {
    getHistoryEventFromDbMock.mockResolvedValueOnce({
      id: "e1",
      createdAt: "2026-05-28T00:00:00Z",
      kind: "commandCreated",
      commandId: "cmd-1",
      commandName: "Greet",
      snapshotAfter: sampleCommand,
    } satisfies HistoryEvent);
    listHistoryFromDbMock.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: HISTORY_PAGE_SIZE,
    });
    await useHistoryStore.getState().undoEdit("e1");
    expect(upsertCommandInDbMock).not.toHaveBeenCalled();
  });
});

describe("restoreDeleted", () => {
  it("upserts snapshotBefore (same id), records commandRestored, reloads", async () => {
    const snap: Command = { ...sampleCommand, id: "cmd-77", name: "Killed" };
    const deletedEvent: HistoryEvent = {
      id: "e-del",
      createdAt: "2026-05-28T00:00:00Z",
      kind: "commandDeleted",
      commandId: "cmd-77",
      commandName: "Killed",
      snapshotBefore: snap,
    };
    getHistoryEventFromDbMock.mockResolvedValueOnce(deletedEvent);
    recordHistoryEventInDbMock.mockResolvedValueOnce("e-restore");
    upsertCommandInDbMock.mockResolvedValueOnce(undefined);
    listHistoryFromDbMock.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: HISTORY_PAGE_SIZE,
    });
    // Command store starts WITHOUT the command (it was deleted).
    useCommandStore.setState({ commands: [], favorites: [] });

    await useHistoryStore.getState().restoreDeleted("e-del");

    expect(upsertCommandInDbMock).toHaveBeenCalledWith(snap);
    expect(useCommandStore.getState().commands).toHaveLength(1);
    expect(useCommandStore.getState().commands[0]?.id).toBe("cmd-77");
    const recorded = recordHistoryEventInDbMock.mock
      .calls[0]?.[0] as HistoryEvent;
    expect(recorded?.kind).toBe("commandRestored");
  });

  it("restoring a favourite re-adds the id to favorites without duplicates", async () => {
    const fav: Command = {
      ...sampleCommand,
      id: "cmd-fav",
      favorite: true,
    };
    getHistoryEventFromDbMock.mockResolvedValueOnce({
      id: "e-del",
      createdAt: "2026-05-28T00:00:00Z",
      kind: "commandDeleted",
      commandId: "cmd-fav",
      commandName: "Greet",
      snapshotBefore: fav,
    } satisfies HistoryEvent);
    recordHistoryEventInDbMock.mockResolvedValueOnce("ok");
    upsertCommandInDbMock.mockResolvedValueOnce(undefined);
    listHistoryFromDbMock.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: HISTORY_PAGE_SIZE,
    });
    // Pre-existing favourites must not duplicate after restore.
    useCommandStore.setState({
      commands: [],
      favorites: ["cmd-fav"],
    });
    await useHistoryStore.getState().restoreDeleted("e-del");
    const favs = useCommandStore.getState().favorites;
    expect(favs.filter((f) => f === "cmd-fav")).toHaveLength(1);
  });
});

describe("applyRunCompletion", () => {
  const runningRow: HistoryEvent = {
    id: "evt-run-1",
    createdAt: "2026-06-04T00:00:00Z",
    kind: "commandRun",
    commandId: "cmd-1",
    commandName: "Greet",
    executionId: "exec-1",
    status: "running",
  };

  it("patches the matching commandRun row to its terminal outcome", () => {
    useHistoryStore.setState({ items: [runningRow], total: 1 });
    useHistoryStore.getState().applyRunCompletion("exec-1", {
      status: "succeeded",
      exitCode: 0,
      durationMs: 42,
    });
    const row = useHistoryStore.getState().items[0];
    expect(row.kind).toBe("commandRun");
    if (row.kind === "commandRun") {
      expect(row.status).toBe("succeeded");
      expect(row.exitCode).toBe(0);
      expect(row.durationMs).toBe(42);
    }
  });

  it("does not clobber existing fields when optional outcome fields are absent (cancel/error)", () => {
    useHistoryStore.setState({
      items: [{ ...runningRow, exitCode: 7, durationMs: 5 }],
      total: 1,
    });
    useHistoryStore.getState().applyRunCompletion("exec-1", {
      status: "cancelled",
    });
    const row = useHistoryStore.getState().items[0];
    if (row.kind === "commandRun") {
      expect(row.status).toBe("cancelled");
      // Pre-existing values are preserved because the patch omitted them.
      expect(row.exitCode).toBe(7);
      expect(row.durationMs).toBe(5);
    }
  });

  it("is a no-op (keeps array identity) when no row matches the execution id", () => {
    useHistoryStore.setState({ items: [runningRow], total: 1 });
    const before = useHistoryStore.getState().items;
    useHistoryStore.getState().applyRunCompletion("exec-other", {
      status: "succeeded",
    });
    // Same array reference → no re-render churn for an off-page execution.
    expect(useHistoryStore.getState().items).toBe(before);
  });

  it("only touches the row whose executionId matches", () => {
    const otherRow: HistoryEvent = {
      ...runningRow,
      id: "evt-run-2",
      executionId: "exec-2",
    };
    useHistoryStore.setState({ items: [runningRow, otherRow], total: 2 });
    useHistoryStore.getState().applyRunCompletion("exec-2", {
      status: "failed",
      exitCode: 1,
    });
    const [first, second] = useHistoryStore.getState().items;
    if (first.kind === "commandRun") expect(first.status).toBe("running");
    if (second.kind === "commandRun") expect(second.status).toBe("failed");
  });
});

describe("clearAll", () => {
  it("clears the table and the in-memory page state", async () => {
    clearHistoryInDbMock.mockResolvedValueOnce(undefined);
    useHistoryStore.setState({
      items: [
        {
          id: "e1",
          createdAt: "2026-05-28T00:00:00Z",
          kind: "commandCreated",
          commandId: "cmd-1",
          commandName: "Greet",
          snapshotAfter: sampleCommand,
        },
      ],
      total: 1,
      page: 4,
    });
    await useHistoryStore.getState().clearAll();
    expect(useHistoryStore.getState().items).toHaveLength(0);
    expect(useHistoryStore.getState().total).toBe(0);
    expect(useHistoryStore.getState().page).toBe(1);
  });
});
