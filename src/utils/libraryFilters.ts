/**
 * Generic query + tags + category filter composition, shared by every
 * Library list (Commands, Workflows, Mini-Apps). Extracted from the
 * Commands-only `filterCommands` (see `commandFilters.ts`, which now
 * delegates here) so Workflows/Mini-Apps can reuse the exact same AND/ANY
 * semantics without duplicating the composition logic.
 */

/**
 * Active filter selection for a Library list. All three dimensions compose
 * with AND between dimensions:
 *   - `query`    : free-text search, matched by the caller-supplied
 *                  `matchesQuery` predicate (so localization/label
 *                  resolution stays list-specific).
 *   - `tags`     : an item must carry at least ONE of the selected tags
 *                  (ANY semantics). Empty array means "no tag filter".
 *   - `category` : exact match on the item's `categoryId`. `undefined`
 *                  means "all categories" (no category filter).
 */
export interface LibraryFilter {
  query: string;
  tags: string[];
  category?: string;
}

/** The minimal shape a filterable Library entity must carry. */
export interface FilterableEntity {
  tags: ReadonlyArray<string>;
  categoryId?: string;
}

/**
 * Filter `items` by query + tags + category, composed with AND across the
 * three dimensions.
 *
 * Tag semantics are ANY (union): with one or more tags selected, an item is
 * kept when it carries AT LEAST ONE of them. Tag comparison is
 * case-insensitive. Category is an exact (case-sensitive) match on
 * `categoryId`; `undefined`/empty category means no category constraint.
 * The query itself is delegated to `matchesQuery`, which lets each list
 * define its own free-text matching (localized labels, description, etc.).
 */
export function filterEntities<T extends FilterableEntity>(
  items: ReadonlyArray<T>,
  filter: LibraryFilter,
  matchesQuery: (item: T, query: string) => boolean,
): T[] {
  const selectedTags = filter.tags
    .map((tag) => tag.toLowerCase())
    .filter((tag) => tag !== "");
  const category =
    filter.category !== undefined && filter.category.trim() !== ""
      ? filter.category
      : undefined;

  return items.filter((item) => {
    if (!matchesQuery(item, filter.query)) return false;
    if (selectedTags.length > 0) {
      const itemTags = item.tags.map((tag) => tag.toLowerCase());
      const hasAny = selectedTags.some((tag) => itemTags.includes(tag));
      if (!hasAny) return false;
    }
    if (category !== undefined && item.categoryId !== category) return false;
    return true;
  });
}
