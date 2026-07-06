import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import {
  deleteScheduleInDb,
  listSchedulesFromDb,
  previewNextRuns,
  recordToSchedule,
  runScheduleNowInDb,
  scheduleToRecord,
  setScheduleEnabledInDb,
  upsertScheduleInDb,
  type ScheduleRecord,
} from "./scheduleRepository";
import type { Schedule } from "../types";

function uiSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "sch-1",
    name: "Nightly",
    enabled: true,
    targetKind: "command",
    targetId: "cmd-1",
    cron: "0 2 * * *",
    variableValues: { dir: "/tmp" },
    skipIfRunning: false,
    captureOutput: true,
    catchUpPolicy: "none",
    maxRetries: 0,
    createdAt: "2026-06-03T00:00:00Z",
    updatedAt: "2026-06-03T00:00:00Z",
    runCount: 0,
    ...overrides,
  };
}

describe("scheduleToRecord", () => {
  it("collapses undefined optionals to null for the wire", () => {
    const rec = scheduleToRecord(uiSchedule());
    expect(rec.lastRunAt).toBeNull();
    expect(rec.lastRunStatus).toBeNull();
    expect(rec.nextRunAt).toBeNull();
  });

  it("preserves present optionals", () => {
    const rec = scheduleToRecord(
      uiSchedule({
        lastRunAt: "2026-06-03T02:00:00Z",
        lastRunStatus: "success",
        nextRunAt: "2026-06-04T02:00:00Z",
      }),
    );
    expect(rec.lastRunAt).toBe("2026-06-03T02:00:00Z");
    expect(rec.lastRunStatus).toBe("success");
    expect(rec.nextRunAt).toBe("2026-06-04T02:00:00Z");
  });
});

describe("recordToSchedule", () => {
  function wire(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
    return {
      id: "sch-1",
      name: "Nightly",
      enabled: true,
      targetKind: "command",
      targetId: "cmd-1",
      cron: "0 2 * * *",
      variableValues: { dir: "/tmp" },
      skipIfRunning: false,
      captureOutput: true,
      catchUpPolicy: "none",
      timeoutSeconds: null,
      maxRetries: 0,
      createdAt: "2026-06-03T00:00:00Z",
      updatedAt: "2026-06-03T00:00:00Z",
      lastRunAt: null,
      lastRunStatus: null,
      nextRunAt: null,
      runCount: 0,
      ...overrides,
    };
  }

  it("collapses null optionals to undefined", () => {
    const s = recordToSchedule(wire());
    expect(s.lastRunAt).toBeUndefined();
    expect(s.lastRunStatus).toBeUndefined();
    expect(s.nextRunAt).toBeUndefined();
  });

  it("falls back to command for an unknown target kind", () => {
    const s = recordToSchedule(wire({ targetKind: "garbage" }));
    expect(s.targetKind).toBe("command");
  });

  it("keeps a recognised workflow target kind", () => {
    const s = recordToSchedule(wire({ targetKind: "workflow" }));
    expect(s.targetKind).toBe("workflow");
  });

  it("drops an unrecognised run status to undefined", () => {
    const s = recordToSchedule(wire({ lastRunStatus: "weird" }));
    expect(s.lastRunStatus).toBeUndefined();
  });

  it("maps a recognised run status through", () => {
    const s = recordToSchedule(wire({ lastRunStatus: "missingVariable" }));
    expect(s.lastRunStatus).toBe("missingVariable");
  });

  it("carries captureOutput through unchanged", () => {
    expect(recordToSchedule(wire({ captureOutput: false })).captureOutput).toBe(
      false,
    );
    expect(recordToSchedule(wire({ captureOutput: true })).captureOutput).toBe(
      true,
    );
  });
});

describe("round-trip", () => {
  it("scheduleToRecord -> recordToSchedule preserves the schedule", () => {
    const original = uiSchedule({
      lastRunAt: "2026-06-03T02:00:00Z",
      lastRunStatus: "error",
      nextRunAt: "2026-06-04T02:00:00Z",
      runCount: 3,
    });
    const back = recordToSchedule(scheduleToRecord(original));
    expect(back).toEqual(original);
  });

  it("preserves a workflow target's nested variable values", () => {
    const original = uiSchedule({
      targetKind: "workflow",
      targetId: "wf-1",
      variableValues: { "node-a": { x: "1" } },
    });
    const back = recordToSchedule(scheduleToRecord(original));
    expect(back.variableValues).toEqual({ "node-a": { x: "1" } });
  });
});

describe("IPC wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("listSchedulesFromDb", () => {
    it("invokes list_schedules and decodes each record", async () => {
      const wireRec: ScheduleRecord = {
        id: "sch-1",
        name: "Nightly",
        enabled: true,
        targetKind: "command",
        targetId: "cmd-1",
        cron: "0 2 * * *",
        variableValues: {},
        skipIfRunning: false,
        captureOutput: true,
        catchUpPolicy: "none",
        timeoutSeconds: 30,
        maxRetries: 0,
        createdAt: "2026-06-03T00:00:00Z",
        updatedAt: "2026-06-03T00:00:00Z",
        lastRunAt: null,
        lastRunStatus: "success",
        nextRunAt: null,
        runCount: 0,
      };
      invokeMock.mockResolvedValue([wireRec]);
      const result = await listSchedulesFromDb();
      expect(invokeMock).toHaveBeenCalledWith("list_schedules", undefined);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: "sch-1",
        timeoutSeconds: 30,
        lastRunStatus: "success",
      });
    });

    it("propagates a rejection", async () => {
      invokeMock.mockRejectedValue(new Error("db down"));
      await expect(listSchedulesFromDb()).rejects.toThrow("db down");
    });
  });

  describe("upsertScheduleInDb", () => {
    it("invokes upsert_schedule with the wire record", async () => {
      invokeMock.mockResolvedValue(undefined);
      await upsertScheduleInDb(uiSchedule({ id: "s7" }));
      expect(invokeMock).toHaveBeenCalledWith("upsert_schedule", {
        schedule: expect.objectContaining({ id: "s7" }),
      });
    });
  });

  describe("deleteScheduleInDb", () => {
    it("invokes delete_schedule with the id", async () => {
      invokeMock.mockResolvedValue(undefined);
      await deleteScheduleInDb("s9");
      expect(invokeMock).toHaveBeenCalledWith("delete_schedule", { id: "s9" });
    });
  });

  describe("setScheduleEnabledInDb", () => {
    it("invokes set_schedule_enabled with id, enabled and an ISO updatedAt", async () => {
      invokeMock.mockResolvedValue(undefined);
      await setScheduleEnabledInDb("s3", false);
      expect(invokeMock).toHaveBeenCalledTimes(1);
      const [cmd, args] = invokeMock.mock.calls[0] as [
        string,
        { id: string; enabled: boolean; updatedAt: string },
      ];
      expect(cmd).toBe("set_schedule_enabled");
      expect(args.id).toBe("s3");
      expect(args.enabled).toBe(false);
      expect(Number.isNaN(Date.parse(args.updatedAt))).toBe(false);
    });
  });

  describe("runScheduleNowInDb", () => {
    it("invokes run_schedule_now with the id", async () => {
      invokeMock.mockResolvedValue(undefined);
      await runScheduleNowInDb("s5");
      expect(invokeMock).toHaveBeenCalledWith("run_schedule_now", { id: "s5" });
    });
  });

  describe("previewNextRuns", () => {
    it("invokes preview_next_runs and passes through the result", async () => {
      invokeMock.mockResolvedValue(["2026-01-02T00:00:00.000Z"]);
      const result = await previewNextRuns("0 0 * * *", 1);
      expect(invokeMock).toHaveBeenCalledWith("preview_next_runs", {
        cron: "0 0 * * *",
        count: 1,
      });
      expect(result).toEqual(["2026-01-02T00:00:00.000Z"]);
    });

    it("rejects with INVALID_CRON from the backend", async () => {
      invokeMock.mockRejectedValue("INVALID_CRON");
      await expect(previewNextRuns("bad", 3)).rejects.toBe("INVALID_CRON");
    });
  });
});
