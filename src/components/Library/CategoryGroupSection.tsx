import type { ReactElement } from "react";
import { ChevronIcon } from "../icons";
import type { CategoryGroup } from "../../utils/groupByCategory";

export interface CategoryGroupSectionProps<T> {
  group: CategoryGroup<T>;
  isOpen: boolean;
  onToggleOpen: (key: string) => void;
  /** Render the item grid's wrapper className (e.g. "command-list"/"command-list--compact"). */
  listClassName: string;
  /** Render one item's card, given whether the list is in compact mode. */
  renderItem: (item: T) => ReactElement;
}

/**
 * A collapsible category section for a grouped Library list. Generalises
 * the Commands-only `CommandGroupSection` so Workflows and Mini-Apps can
 * render the same accordion-by-category layout via a render-prop for the
 * item card (each list's card component takes different props).
 */
export function CategoryGroupSection<T>({
  group,
  isOpen,
  onToggleOpen,
  listClassName,
  renderItem,
}: CategoryGroupSectionProps<T>): ReactElement {
  return (
    <section className="list-group">
      <button
        type="button"
        className={"list-group__header" + (isOpen ? " is-open" : "")}
        aria-expanded={isOpen}
        onClick={() => onToggleOpen(group.key)}
      >
        <span className="list-group__chevron">
          <ChevronIcon />
        </span>
        {group.label}
        <span className="list-group__count">{group.items.length}</span>
      </button>
      {isOpen ? (
        <div className="list-group__body">
          <div className={listClassName}>{group.items.map(renderItem)}</div>
        </div>
      ) : null}
    </section>
  );
}
