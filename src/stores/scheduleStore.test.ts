import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Avoid importing the real Tauri runtime indirectly.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

// Mock the IPC repository so the store tests stay focused on state
// transitions; the wire format is exercised in scheduleRepository.test.ts.
const listMock = vi.fn();
const upsertMock = vi.fn();
const deleteMock = vi.fn();
const setEnabledMock = vi.fn();
vi.mock("../utils/scheduleRepository", () => ({
  listSchedulesFromDb: () => listMock(),
  upsertScheduleInDb: (s: unknown) => upsertMock(s),
  deleteScheduleInDb: (id: string) => deleteMock(id),
  setScheduleEnabledInDb: (id: string, enabled: boolean) =>
    setEnabledMock(id, enabled),
}));

import type { NewScheduleInput, Schedule } from "../types";
import { useScheduleStore } from "./scheduleStore";

function baseInput(overrides: Partial<NewScheduleInput> = {}): NewScheduleInput {
  return {
    name: "Nightly",
    targetKind: "command",
    targetId: "cmd-1",
    cron: "0 2 * * *",
    variableValues: {},
    skipIfRunning: false,
    captureOutput: true,
    catchUpPolicy: "none",
    maxRetries: 0,
    enabled: true,
    ...overrides,
  };
}

function fixture(id: string): Schedule {
  return {
    id,
    name: `name-${id}`,
    enabled: true,
    targetKind: "command",
    targetId: "cmd-1",
    cron: "0 2 * * *",
    variableValues: {},
    skipIfRunning: false,
    captureOutput: true,
    catchUpPolicy: "none",
    maxRetries: 0,
    createdAt: "2026-06-03T00:00:00Z",
    updatedAt: "2026-06-03T00:00:00Z",
    runCount: 0,
  };
}

beforeEach(() => {
  useScheduleStore.setState({ schedules: [], hydrated: true });
  listMock.mockReset();
  listMock.mockResolvedValue([]);
  upsertMock.mockReset();
  upsertMock.mockResolvedValue(undefined);
  deleteMock.mockReset();
  deleteMock.mockResolvedValue(undefined);
  setEnabledMock.mockReset();
  setEnabledMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scheduleStore.addSchedule", () => {
  it("persists a new schedule with generated id/timestamps and re-hydrates", async () => {
    const created = fixture("from-db");
    listMock.mockResolvedValueOnce([created]);
    const result = await useScheduleStore.getState().addSchedule(baseInput());
    expect(result.id).toBeTypeOf("string");
    expect(result.id.length).toBeGreaterThan(0);
    expect(result.runCount).toBe(0);
    expect(result.createdAt).toBe(result.updatedAt);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    // The list now reflects the DB read, not the optimistic value.
    expect(useScheduleStore.getState().schedules).toEqual([created]);
  });

  it("rejects (and adds nothing) when the backend refuses the write", async () => {
    upsertMock.mockRejectedValueOnce("INVALID_CRON");
    await expect(
      useScheduleStore.getState().addSchedule(baseInput()),
    ).rejects.toBe("INVALID_CRON");
    expect(useScheduleStore.getState().schedules).toEqual([]);
    // No re-hydrate on failure.
    expect(listMock).not.toHaveBeenCalled();
  });

  it("falls back to a Math.random id when crypto.randomUUID is unavailable", async () => {
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: undefined,
      configurable: true,
    });
    try {
      const result = await useScheduleStore
        .getState()
        .addSchedule(baseInput());
      expect(result.id).toMatch(/^sch-/);
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        value: original,
        configurable: true,
      });
    }
  });
});

describe("scheduleStore.updateSchedule", () => {
  it("patches an existing schedule, refreshes updatedAt and re-hydrates", async () => {
    useScheduleStore.setState({ schedules: [fixture("a")], hydrated: true });
    const patched = { ...fixture("a"), name: "Renamed" };
    listMock.mockResolvedValueOnce([patched]);
    const next = await useScheduleStore
      .getState()
      .updateSchedule("a", { name: "Renamed" });
    expect(next.name).toBe("Renamed");
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(useScheduleStore.getState().schedules).toEqual([patched]);
  });

  it("rejects when the id is unknown", async () => {
    await expect(
      useScheduleStore.getState().updateSchedule("nope", { name: "x" }),
    ).rejects.toThrow();
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe("scheduleStore.setEnabled", () => {
  it("calls the repository and re-hydrates", async () => {
    useScheduleStore.setState({ schedules: [fixture("a")], hydrated: true });
    const disabled = { ...fixture("a"), enabled: false };
    listMock.mockResolvedValueOnce([disabled]);
    await useScheduleStore.getState().setEnabled("a", false);
    expect(setEnabledMock).toHaveBeenCalledWith("a", false);
    expect(useScheduleStore.getState().schedules[0]?.enabled).toBe(false);
  });
});

describe("scheduleStore.removeSchedule", () => {
  it("deletes and re-hydrates the now-empty list", async () => {
    useScheduleStore.setState({ schedules: [fixture("a")], hydrated: true });
    listMock.mockResolvedValueOnce([]);
    await useScheduleStore.getState().removeSchedule("a");
    expect(deleteMock).toHaveBeenCalledWith("a");
    expect(useScheduleStore.getState().schedules).toEqual([]);
  });
});

describe("scheduleStore.hydrateFromDb", () => {
  beforeEach(() => {
    useScheduleStore.setState({ schedules: [], hydrated: false });
  });

  it("loads schedules from the repository and marks hydrated", async () => {
    const f = fixture("from-db");
    listMock.mockResolvedValueOnce([f]);
    await useScheduleStore.getState().hydrateFromDb();
    expect(useScheduleStore.getState().schedules).toEqual([f]);
    expect(useScheduleStore.getState().hydrated).toBe(true);
  });

  it("flips hydrated=true even when the IPC call rejects", async () => {
    listMock.mockRejectedValueOnce(new Error("ipc-down"));
    await useScheduleStore.getState().hydrateFromDb();
    expect(useScheduleStore.getState().hydrated).toBe(true);
    expect(useScheduleStore.getState().schedules).toEqual([]);
  });
});
