// List-view presentation types — sorting, display mode, and pagination
// preferences for the Library (commands / workflows) and Scheduler lists.
//
// These describe UI state only; they never cross the IPC boundary. The
// persisted slice lives in `uiStore` (one `ListViewState` per list), while
// the current page is held as transient component state (not persisted).

/** Sort direction shared by every sortable list. */
export type SortDir = "asc" | "desc";

/**
 * Sort keys for the Commands list.
 *   - "createdAt" → by creation date (pair with `dir` for newest/oldest first).
 *   - "name"      → by localized name, locale-aware (А-Я / Я-А).
 */
export type CommandSortKey = "createdAt" | "name";

/** Sort keys for the Workflows list. Same semantics as {@link CommandSortKey}. */
export type WorkflowSortKey = "createdAt" | "name";

/** Sort keys for the Mini-Apps list. Same semantics as {@link CommandSortKey}. */
export type MiniAppSortKey = "createdAt" | "name";

/**
 * Sort keys for the Schedules list. `runCount` sorts by total fires.
 * Per-status (success / error) sorting is intentionally absent until the
 * backend persists those counts.
 */
export type ScheduleSortKey = "createdAt" | "name" | "runCount";

/** Union of every list's sort key — useful for generic helpers. */
export type ListSortKey =
  | CommandSortKey
  | WorkflowSortKey
  | MiniAppSortKey
  | ScheduleSortKey;

/**
 * How a list renders its items:
 *   - "tiles"   → the expanded card grid (description + labelled buttons).
 *   - "compact" → a denser card grid: no description, icon-only Run/View
 *                 buttons placed before the favorite toggle.
 *   - "table"   → a paginated table.
 */
export type ViewMode = "tiles" | "compact" | "table";

/** Page size for the table view. Only these two sizes are offered. */
export type PageSize = 10 | 25;

/**
 * Generic, type-parameterised view preference for one list. `K` is the
 * list-specific sort-key union (e.g. {@link CommandSortKey}). `grouped` is
 * only meaningful for the Commands list (accordion-by-category); other
 * lists keep it `false`.
 */
export interface ListViewState<K extends ListSortKey> {
  sortKey: K;
  sortDir: SortDir;
  mode: ViewMode;
  pageSize: PageSize;
  grouped: boolean;
}

export type CommandViewState = ListViewState<CommandSortKey>;
export type WorkflowViewState = ListViewState<WorkflowSortKey>;
export type MiniAppViewState = ListViewState<MiniAppSortKey>;
export type ScheduleViewState = ListViewState<ScheduleSortKey>;
