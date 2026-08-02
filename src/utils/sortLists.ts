import type {
  Command,
  CommandSortKey,
  MiniApp,
  MiniAppSortKey,
  Schedule,
  ScheduleSortKey,
  SortDir,
  Workflow,
  WorkflowSortKey,
} from "../types";

// Pure, locale-aware sorters for the Library and Scheduler lists.
//
// Every function returns a NEW array (never mutates its input) so it can be
// used directly inside a render memo. Comparisons are total and stable:
// the requested key is compared first, then `name`, then `id` as
// tie-breakers, so equal-key items keep a deterministic order regardless of
// the engine's sort stability or the input order.
//
// Name comparison is locale-aware and case-insensitive via `localeCompare`
// with `sensitivity: "base"`, which orders Cyrillic (А-Я) and Latin
// correctly for the active runtime locale. Date comparison parses the ISO
// `createdAt` to a timestamp; unparseable values sort as `-Infinity` (oldest).

const NAME_COLLATION: Intl.CollatorOptions = { sensitivity: "base" };

/** Sort options shared by every list sorter. */
export interface SortOptions<K extends string> {
  key: K;
  dir: SortDir;
}

/** Locale-aware, case-insensitive name comparison. */
function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, NAME_COLLATION);
}

/**
 * Parse an ISO date string to a millisecond timestamp. An absent or
 * unparseable value yields `-Infinity` so such items sort as the oldest
 * (and therefore last when `dir === "desc"`), rather than throwing or
 * producing `NaN` comparisons.
 */
function toTimestamp(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? -Infinity : ms;
}

/** Apply the direction sign to a comparator result. */
function applyDir(cmp: number, dir: SortDir): number {
  return dir === "asc" ? cmp : -cmp;
}

/**
 * Sort commands by the given key/direction. Because a command's displayed
 * name may come from an i18next key (`nameKey`), the caller supplies a
 * `nameOf` resolver (typically `(c) => getCommandName(c, t)`) so name
 * sorting matches what the user sees. The resolver is also used for the
 * tie-breaker on non-name keys.
 */
export function sortCommands(
  commands: ReadonlyArray<Command>,
  options: SortOptions<CommandSortKey>,
  nameOf: (command: Command) => string,
): Command[] {
  const { key, dir } = options;
  return [...commands].sort((a, b) => {
    const nameA = nameOf(a);
    const nameB = nameOf(b);
    let cmp: number;
    if (key === "name") {
      cmp = compareNames(nameA, nameB);
    } else {
      cmp = toTimestamp(a.createdAt) - toTimestamp(b.createdAt);
    }
    if (cmp !== 0) return applyDir(cmp, dir);
    // Tie-breakers are direction-independent for a deterministic order.
    const byName = compareNames(nameA, nameB);
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
  });
}

/** Sort workflows by the given key/direction. Uses the literal `name`. */
export function sortWorkflows(
  workflows: ReadonlyArray<Workflow>,
  options: SortOptions<WorkflowSortKey>,
): Workflow[] {
  const { key, dir } = options;
  return [...workflows].sort((a, b) => {
    let cmp: number;
    if (key === "name") {
      cmp = compareNames(a.name, b.name);
    } else {
      cmp = toTimestamp(a.createdAt) - toTimestamp(b.createdAt);
    }
    if (cmp !== 0) return applyDir(cmp, dir);
    const byName = compareNames(a.name, b.name);
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
  });
}

/** Sort mini-apps by the given key/direction. Uses the literal `name`. */
export function sortMiniApps(
  miniapps: ReadonlyArray<MiniApp>,
  options: SortOptions<MiniAppSortKey>,
): MiniApp[] {
  const { key, dir } = options;
  return [...miniapps].sort((a, b) => {
    let cmp: number;
    if (key === "name") {
      cmp = compareNames(a.name, b.name);
    } else {
      cmp = toTimestamp(a.createdAt) - toTimestamp(b.createdAt);
    }
    if (cmp !== 0) return applyDir(cmp, dir);
    const byName = compareNames(a.name, b.name);
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Sort schedules by the given key/direction. `runCount` sorts by total
 * fires; per-status counts are not yet available. Uses the literal `name`.
 */
export function sortSchedules(
  schedules: ReadonlyArray<Schedule>,
  options: SortOptions<ScheduleSortKey>,
): Schedule[] {
  const { key, dir } = options;
  return [...schedules].sort((a, b) => {
    let cmp: number;
    if (key === "name") {
      cmp = compareNames(a.name, b.name);
    } else if (key === "runCount") {
      cmp = a.runCount - b.runCount;
    } else {
      cmp = toTimestamp(a.createdAt) - toTimestamp(b.createdAt);
    }
    if (cmp !== 0) return applyDir(cmp, dir);
    const byName = compareNames(a.name, b.name);
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
  });
}
