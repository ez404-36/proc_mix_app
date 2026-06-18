import { describe, expect, it } from "vitest";
import { clearRangeBounds } from "./historyClearRange";

// A fixed reference instant: 2026-06-17T15:30:00.000Z.
const NOW = new Date("2026-06-17T15:30:00.000Z");

describe("clearRangeBounds", () => {
  it("returns no bounds for 'all' (whole-table clear)", () => {
    expect(clearRangeBounds({ kind: "all" }, NOW)).toEqual({});
  });

  it("lastHour deletes records after now minus one hour", () => {
    expect(clearRangeBounds({ kind: "lastHour" }, NOW)).toEqual({
      after: "2026-06-17T14:30:00.000Z",
    });
  });

  it("lastWeek deletes records after now minus seven days", () => {
    expect(clearRangeBounds({ kind: "lastWeek" }, NOW)).toEqual({
      after: "2026-06-10T15:30:00.000Z",
    });
  });

  it("olderThanDays(N) deletes records before now minus N days", () => {
    expect(clearRangeBounds({ kind: "olderThanDays", days: 30 }, NOW)).toEqual({
      before: "2026-05-18T15:30:00.000Z",
    });
  });

  it("olderThanDays clamps a negative count to 0 (this instant)", () => {
    expect(clearRangeBounds({ kind: "olderThanDays", days: -5 }, NOW)).toEqual({
      before: NOW.toISOString(),
    });
  });

  it("today deletes records after the local midnight of the reference day", () => {
    const bounds = clearRangeBounds({ kind: "today" }, NOW);
    expect(bounds.before).toBeUndefined();
    expect(bounds.after).toBeDefined();
    // Local midnight depends on the runner's TZ, so assert the relation
    // rather than a fixed string: it is at or before `now` and within 24h.
    const cutoffMs = new Date(bounds.after as string).getTime();
    expect(cutoffMs).toBeLessThanOrEqual(NOW.getTime());
    expect(NOW.getTime() - cutoffMs).toBeLessThan(24 * 60 * 60 * 1000);
  });
});
