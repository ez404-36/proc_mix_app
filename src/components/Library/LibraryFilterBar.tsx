import type { ChangeEvent, ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Dropdown } from "../Dropdown";
import type { DropdownOption } from "../Dropdown";
import { ListControls } from "../ListControls/ListControls";
import type { SortOption } from "../ListControls/ListControls";
import type { ListSortKey, SortDir, ViewMode } from "../../types";

/** Sentinel value for the "all categories" option in the category filter. */
export const ALL_CATEGORIES = "";

export interface LibraryFilterBarProps<K extends ListSortKey> {
  query: string;
  onQueryChange: (query: string) => void;
  searchPlaceholder: string;

  /**
   * Category options (excluding the "all" sentinel, added internally). The
   * Dropdown is always rendered, even when empty — it then just offers the
   * single "All categories" option, keeping the filter bar's layout stable
   * across tabs/lists that currently have zero categorised items.
   */
  categories: ReadonlyArray<string>;
  category: string;
  onCategoryChange: (category: string) => void;

  /** Tag chips (omit the row entirely when empty). */
  tags: ReadonlyArray<string>;
  activeTags: ReadonlyArray<string>;
  onToggleTag: (tag: string) => void;
  filtersActive: boolean;
  onClearFilters: () => void;

  sortOptions: ReadonlyArray<SortOption<K>>;
  sortKey: K;
  sortDir: SortDir;
  onSortChange: (key: K, dir: SortDir) => void;
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  /** Grouping toggle. Omit both to hide the control entirely. */
  grouped?: boolean;
  onGroupedChange?: (grouped: boolean) => void;
}

/**
 * Shared search + category filter + tag filter + sort/mode/group controls
 * for a Library list. Reused by the Commands, Workflows, and Mini-Apps tabs
 * so all three offer the same filtering/grouping capabilities (see
 * `docs/ui-conventions.md`'s `.library-toolbar` / `.library-filter-tags`
 * patterns, which this component composes).
 */
export function LibraryFilterBar<K extends ListSortKey>(
  props: LibraryFilterBarProps<K>,
): ReactElement {
  const {
    query,
    onQueryChange,
    searchPlaceholder,
    categories,
    category,
    onCategoryChange,
    tags,
    activeTags,
    onToggleTag,
    filtersActive,
    onClearFilters,
    sortOptions,
    sortKey,
    sortDir,
    onSortChange,
    mode,
    onModeChange,
    grouped,
    onGroupedChange,
  } = props;
  const { t } = useTranslation();

  const categoryOptions: ReadonlyArray<DropdownOption> = [
    { value: ALL_CATEGORIES, label: t("library.allCategories") },
    ...categories.map((cat) => ({ value: cat, label: cat })),
  ];

  const handleSearch = (e: ChangeEvent<HTMLInputElement>): void => {
    onQueryChange(e.target.value);
  };

  return (
    <>
      <div className="library-toolbar">
        <input
          className="input"
          type="search"
          placeholder={searchPlaceholder}
          value={query}
          onChange={handleSearch}
        />
        <Dropdown
          value={category}
          options={categoryOptions}
          onChange={onCategoryChange}
          ariaLabel={t("library.filterByCategory")}
        />
        <ListControls
          sortOptions={sortOptions}
          sortKey={sortKey}
          sortDir={sortDir}
          onSortChange={onSortChange}
          mode={mode}
          onModeChange={onModeChange}
          grouped={grouped}
          onGroupedChange={onGroupedChange}
        />
      </div>

      {tags.length > 0 ? (
        <div
          className="library-filter-tags"
          role="group"
          aria-label={t("library.filterByTag")}
        >
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              className={`tag-chip tag-chip--filter${
                activeTags.includes(tag) ? " is-active" : ""
              }`}
              aria-pressed={activeTags.includes(tag)}
              onClick={() => onToggleTag(tag)}
            >
              {tag}
            </button>
          ))}
          {filtersActive ? (
            <button
              type="button"
              className="btn btn--ghost library-filter-clear"
              onClick={onClearFilters}
            >
              {t("library.clearFilters")}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
