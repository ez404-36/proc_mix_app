import { useMemo } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Dropdown } from "../Dropdown/Dropdown";
import type { DropdownOption } from "../Dropdown/Dropdown";
import {
  CompactTilesIcon,
  GroupIcon,
  TableViewIcon,
  TilesViewIcon,
} from "../icons";
import type { ListSortKey, SortDir, ViewMode } from "../../types";

/**
 * One selectable sort option: a key + direction pair plus its human label
 * (e.g. "Name A-Z", "Date created (newest)"). Sort field and direction are
 * combined into a single dropdown choice so the user picks ordering in one
 * action rather than juggling a separate field selector and a flip button.
 */
export interface SortOption<K extends ListSortKey> {
  key: K;
  dir: SortDir;
  label: string;
}

export interface ListControlsProps<K extends ListSortKey> {
  /** Available key+direction sort choices, in display order. */
  sortOptions: ReadonlyArray<SortOption<K>>;
  sortKey: K;
  sortDir: SortDir;
  /** Apply a new key+direction pair (a single dropdown selection). */
  onSortChange: (key: K, dir: SortDir) => void;
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  /**
   * Grouping toggle (Commands only). Omit both to hide the control entirely;
   * other lists do not group.
   */
  grouped?: boolean;
  onGroupedChange?: (grouped: boolean) => void;
}

/** Stable id for a key+direction pair, used as the Dropdown option value. */
function sortOptionId(key: string, dir: SortDir): string {
  return `${key}:${dir}`;
}

/**
 * Shared sort + display-mode controls for the Library / Scheduler lists.
 *
 * Renders a single combined sort dropdown (field + direction in one choice),
 * a tiles/table mode toggle, and (optionally) a group-by-category toggle. The
 * sort selection drives both tiles and table renders, so behaviour is
 * identical across modes — column headers are intentionally NOT sortable.
 *
 * This component is presentational: it owns no state. The parent persists the
 * selection (via `uiStore`) and applies it to the data pipeline.
 */
export function ListControls<K extends ListSortKey>(
  props: ListControlsProps<K>,
): ReactElement {
  const {
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

  const dropdownOptions: ReadonlyArray<DropdownOption> = useMemo(
    () =>
      sortOptions.map((opt) => ({
        value: sortOptionId(opt.key, opt.dir),
        label: opt.label,
      })),
    [sortOptions],
  );

  // Map the Dropdown's string selection back to the typed key+dir pair by
  // lookup, avoiding a cast. A selection always matches an existing option.
  const handleSortChange = (value: string): void => {
    const match = sortOptions.find(
      (opt) => sortOptionId(opt.key, opt.dir) === value,
    );
    if (match) onSortChange(match.key, match.dir);
  };

  const showGroup = grouped !== undefined && onGroupedChange !== undefined;

  return (
    <div
      className="list-controls"
      role="group"
      aria-label={t("listView.controls")}
    >
      <Dropdown
        value={sortOptionId(sortKey, sortDir)}
        options={dropdownOptions}
        onChange={handleSortChange}
        ariaLabel={t("listView.sortBy")}
        className="list-controls__sort"
      />

      {showGroup ? (
        <button
          type="button"
          className={"btn btn--ghost btn--icon" + (grouped ? " is-active" : "")}
          onClick={() => onGroupedChange(!grouped)}
          aria-pressed={grouped}
          aria-label={t("listView.groupByCategory")}
          title={t("listView.groupByCategory")}
        >
          <GroupIcon />
        </button>
      ) : null}

      <div
        className="list-controls__modes"
        role="group"
        aria-label={t("listView.viewMode")}
      >
        <button
          type="button"
          className={
            "btn btn--ghost btn--icon" + (mode === "tiles" ? " is-active" : "")
          }
          onClick={() => onModeChange("tiles")}
          aria-pressed={mode === "tiles"}
          aria-label={t("listView.tilesView")}
          title={t("listView.tilesView")}
        >
          <TilesViewIcon />
        </button>
        <button
          type="button"
          className={
            "btn btn--ghost btn--icon" + (mode === "compact" ? " is-active" : "")
          }
          onClick={() => onModeChange("compact")}
          aria-pressed={mode === "compact"}
          aria-label={t("listView.compactView")}
          title={t("listView.compactView")}
        >
          <CompactTilesIcon />
        </button>
        <button
          type="button"
          className={
            "btn btn--ghost btn--icon" + (mode === "table" ? " is-active" : "")
          }
          onClick={() => onModeChange("table")}
          aria-pressed={mode === "table"}
          aria-label={t("listView.tableView")}
          title={t("listView.tableView")}
        >
          <TableViewIcon />
        </button>
      </div>
    </div>
  );
}
