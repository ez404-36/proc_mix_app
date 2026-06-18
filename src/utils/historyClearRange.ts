// Cutoff computation for the ranged "Clear history" action.
//
// History rows are stored with an ISO-8601 (UTC, `…Z`) `created_at`. The
// Rust layer deletes either everything ("all"), every row AT OR NEWER than a
// cutoff (`after`), or every row OLDER than a cutoff (`before`). The cutoff is
// computed here on the client clock so "today" reflects the user's local day
// boundary, then converted back to a UTC ISO string for the lexicographic
// comparison the storage layer uses.

/**
 * The selectable ranges for clearing history.
 *   - lastHour / today / lastWeek delete the most RECENT records (the chosen
 *     window) and keep older ones.
 *   - olderThanDays deletes records OLDER than N days (keeps the recent N).
 *   - all removes everything.
 */
export type HistoryClearRange =
  | { kind: "lastHour" }
  | { kind: "today" }
  | { kind: "lastWeek" }
  | { kind: "olderThanDays"; days: number }
  | { kind: "all" };

/**
 * Which side of the cutoff to delete. `after` removes `created_at >= cutoff`
 * (recent records); `before` removes `created_at < cutoff` (old records);
 * `all` removes everything (no cutoff).
 */
export interface HistoryClearBounds {
  after?: string;
  before?: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Resolve a range to the bound(s) sent to the backend.
 *
 *   - lastHour       → after = now − 1h   (delete the last hour)
 *   - today          → after = local midnight today (delete today's records)
 *   - lastWeek       → after = now − 7d   (delete the last 7 days)
 *   - olderThanDays(n) → before = now − n days (delete records older than n days)
 *   - all            → {} (delete everything)
 *
 * `now` is injectable for deterministic tests; it defaults to the current
 * instant.
 */
export function clearRangeBounds(
  range: HistoryClearRange,
  now: Date = new Date(),
): HistoryClearBounds {
  switch (range.kind) {
    case "all":
      return {};
    case "lastHour":
      return { after: new Date(now.getTime() - HOUR_MS).toISOString() };
    case "lastWeek":
      return { after: new Date(now.getTime() - 7 * DAY_MS).toISOString() };
    case "today": {
      const midnight = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
      );
      return { after: midnight.toISOString() };
    }
    case "olderThanDays": {
      // Guard against a non-positive count: treat it as "older than 0 days"
      // = everything before this instant. The UI clamps the stepper, but the
      // function stays well-defined for any input.
      const days = Number.isFinite(range.days) ? Math.max(0, range.days) : 0;
      return { before: new Date(now.getTime() - days * DAY_MS).toISOString() };
    }
  }
}
