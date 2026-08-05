/**
 * Generic category-grouping helper shared by every Library list that
 * supports "Group by category" (Commands, Workflows, Mini-Apps). Extracted
 * from the Commands-only `groupCommandsByCategory` so the other lists can
 * reuse the exact same bucketing/ordering rules.
 */

export interface CategoryGroup<T> {
  /** Category id, or the empty string for the synthetic "uncategorized" group. */
  key: string;
  label: string;
  items: T[];
}

/**
 * Partition `items` into category groups. Real categories come first
 * (sorted by name); the synthetic "uncategorized" bucket is always last.
 * Items with a blank/undefined `categoryId` fall into the uncategorized
 * bucket. Each group's items are sorted via the caller-supplied `sortFn`
 * (already bound to whatever sort key/direction/name-resolver the list
 * uses — e.g. `(items) => sortCommands(items, {...}, nameOf)`), so this
 * helper stays agnostic of each entity's specific sort-key union.
 */
export function groupEntitiesByCategory<T extends { categoryId?: string }>(
  items: ReadonlyArray<T>,
  sortFn: (items: T[]) => T[],
  uncategorizedLabel: string,
): CategoryGroup<T>[] {
  const byCategory = new Map<string, T[]>();
  for (const item of items) {
    const cat =
      item.categoryId !== undefined && item.categoryId.trim() !== ""
        ? item.categoryId
        : "";
    const bucket = byCategory.get(cat);
    if (bucket) bucket.push(item);
    else byCategory.set(cat, [item]);
  }

  const namedKeys = [...byCategory.keys()]
    .filter((key) => key !== "")
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const orderedKeys = byCategory.has("") ? [...namedKeys, ""] : namedKeys;

  return orderedKeys.map((key) => ({
    key,
    label: key === "" ? uncategorizedLabel : key,
    items: sortFn(byCategory.get(key) ?? []),
  }));
}
