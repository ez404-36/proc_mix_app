// Client-side pagination for the table view of the Library / Scheduler
// lists. The whole (filtered + sorted) array lives in memory, so this is a
// pure slice helper — no server round-trip (unlike the History view).

/** Result of paginating an in-memory array. */
export interface PaginationResult<T> {
  /** The items on the resolved page. */
  pageItems: T[];
  /** Total number of pages (>= 1, even for an empty list). */
  totalPages: number;
  /**
   * The page actually used, after clamping the requested page into
   * `[1, totalPages]`. Callers should write this back to their page state so
   * a stale page (e.g. after a filter shrank the list) self-corrects.
   */
  page: number;
}

/**
 * Slice `items` into the requested 1-based `page` of `pageSize` items.
 *
 * The requested page is clamped into `[1, totalPages]`, so an out-of-range
 * page (from a filter that shrank the list, a page-size change, or a
 * deleted item) yields the nearest valid page rather than an empty slice.
 * An empty list resolves to page 1 with `totalPages === 1`.
 *
 * `pageSize` is assumed positive (the UI only offers 10 / 25). A
 * non-positive size is treated as 1 to avoid a division-by-zero / infinite
 * page count.
 */
export function paginate<T>(
  items: ReadonlyArray<T>,
  page: number,
  pageSize: number,
): PaginationResult<T> {
  const size = pageSize > 0 ? Math.floor(pageSize) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  const clampedPage = Math.min(Math.max(Math.floor(page), 1), totalPages);
  const start = (clampedPage - 1) * size;
  return {
    pageItems: items.slice(start, start + size),
    totalPages,
    page: clampedPage,
  };
}
