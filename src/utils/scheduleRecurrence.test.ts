import { describe, expect, it } from "vitest";
import {
  buildCron,
  defaultRecurrence,
  parseCron,
  type Recurrence,
} from "./scheduleRecurrence";

describe("buildCron", () => {
  it("everyNMinutes -> */N * * * *", () => {
    expect(buildCron({ type: "everyNMinutes", interval: 5 })).toBe(
      "*/5 * * * *",
    );
  });

  it("everyNHours -> minute */N * * *", () => {
    expect(
      buildCron({ type: "everyNHours", interval: 3, minute: 15 }),
    ).toBe("15 */3 * * *");
  });

  it("daily -> M H * * *", () => {
    expect(buildCron({ type: "daily", hour: 9, minute: 30 })).toBe(
      "30 9 * * *",
    );
  });

  it("weekly emits cron weekday numbers in Mon..Sun order", () => {
    expect(
      buildCron({ type: "weekly", days: [5, 1, 3], hour: 8, minute: 0 }),
    ).toBe("0 8 * * 1,3,5");
  });

  it("monthly -> M H D * *", () => {
    expect(
      buildCron({ type: "monthly", day: 15, hour: 0, minute: 0 }),
    ).toBe("0 0 15 * *");
  });

  it("custom returns the trimmed raw expression", () => {
    expect(buildCron({ type: "custom", cron: "  13 4 * * 2 " })).toBe(
      "13 4 * * 2",
    );
  });

  it("clamps out-of-range numeric fields", () => {
    expect(buildCron({ type: "everyNMinutes", interval: 0 })).toBe(
      "*/1 * * * *",
    );
    expect(buildCron({ type: "everyNMinutes", interval: 99 })).toBe(
      "*/59 * * * *",
    );
    expect(buildCron({ type: "everyNHours", interval: 50, minute: 80 })).toBe(
      "59 */23 * * *",
    );
    expect(buildCron({ type: "monthly", day: 40, hour: 30, minute: 0 })).toBe(
      "0 23 31 * *",
    );
  });
});

describe("parseCron", () => {
  it("round-trips every structured type via buildCron", () => {
    const cases: Recurrence[] = [
      { type: "everyNMinutes", interval: 10 },
      { type: "everyNHours", interval: 4, minute: 20 },
      { type: "daily", hour: 7, minute: 45 },
      { type: "weekly", days: [1, 3, 5], hour: 18, minute: 0 },
      { type: "monthly", day: 1, hour: 0, minute: 0 },
    ];
    for (const r of cases) {
      expect(parseCron(buildCron(r))).toEqual(r);
    }
  });

  it("recognises everyNMinutes", () => {
    expect(parseCron("*/15 * * * *")).toEqual({
      type: "everyNMinutes",
      interval: 15,
    });
  });

  it("recognises everyNHours with a fixed minute", () => {
    expect(parseCron("0 */6 * * *")).toEqual({
      type: "everyNHours",
      interval: 6,
      minute: 0,
    });
  });

  it("recognises weekly with multiple days", () => {
    expect(parseCron("0 9 * * 1,2,3,4,5")).toEqual({
      type: "weekly",
      days: [1, 2, 3, 4, 5],
      hour: 9,
      minute: 0,
    });
  });

  it("normalises extra whitespace before parsing", () => {
    expect(parseCron("  0   0 1  * *  ")).toEqual({
      type: "monthly",
      day: 1,
      hour: 0,
      minute: 0,
    });
  });

  it("falls back to custom for unrecognised expressions", () => {
    // A range hour field is not one of the structured shapes.
    expect(parseCron("0 9-17 * * *")).toEqual({
      type: "custom",
      cron: "0 9-17 * * *",
    });
    // Wrong field count.
    expect(parseCron("0 0 * *")).toEqual({ type: "custom", cron: "0 0 * *" });
    // Out-of-range weekday.
    expect(parseCron("0 9 * * 9")).toEqual({
      type: "custom",
      cron: "0 9 * * 9",
    });
  });
});

describe("defaultRecurrence", () => {
  it("produces a buildable value for every type", () => {
    for (const type of [
      "everyNMinutes",
      "everyNHours",
      "daily",
      "weekly",
      "monthly",
    ] as const) {
      const r = defaultRecurrence(type);
      expect(r.type).toBe(type);
      // Structured defaults must produce a recognisable cron.
      expect(parseCron(buildCron(r)).type).toBe(type);
    }
    expect(defaultRecurrence("custom")).toEqual({ type: "custom", cron: "" });
  });
});
