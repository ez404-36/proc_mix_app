import { describe, expect, it } from "vitest";

import {
  recordToSchedule,
  scheduleToRecord,
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
