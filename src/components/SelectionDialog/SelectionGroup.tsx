import { useEffect, useRef } from "react";
import type { ReactElement, ReactNode } from "react";

/**
 * Tri-state checkbox: native `indeterminate` is a DOM PROPERTY, not an
 * attribute, so it can only be set imperatively via a ref. This wrapper
 * keeps it in sync with the `indeterminate` prop on every render.
 */
function TriStateCheckbox({
  checked,
  indeterminate,
  disabled,
  ariaLabel,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled?: boolean;
  ariaLabel: string;
  onChange: () => void;
}): ReactElement {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={onChange}
    />
  );
}

interface SelectionGroupProps<T> {
  /** Group heading + select-all accessible label (e.g. "Commands"). */
  label: string;
  /** Message shown when the group has no items. */
  emptyLabel: string;
  items: ReadonlyArray<T>;
  /** Stable id of an item, used as the React key and toggle argument. */
  getId: (item: T) => string;
  /** Whether an item's checkbox is checked (explicit OR forced). */
  isChecked: (item: T) => boolean;
  /** Whether an item's checkbox is disabled (locked / forced). */
  isLocked?: (item: T) => boolean;
  /** Render the item's visible label. */
  renderLabel: (item: T) => ReactNode;
  /** Optional extra content rendered after the label (e.g. a duplicate hint). */
  renderExtra?: (item: T, checked: boolean) => ReactNode;
  /** Note rendered on a locked row (e.g. "(required by a workflow)"). */
  lockedHint?: string;
  onToggleItem: (id: string) => void;
  onToggleAll: () => void;
}

/**
 * One group (Commands or Workflows) of the selection tree: a select-all
 * tri-state parent checkbox plus a row per item. Pure presentation — all
 * state lives in the parent {@link SelectionTree}. Both groups render through
 * this component so the markup exists in exactly one place.
 */
export function SelectionGroup<T>({
  label,
  emptyLabel,
  items,
  getId,
  isChecked,
  isLocked,
  renderLabel,
  renderExtra,
  lockedHint,
  onToggleItem,
  onToggleAll,
}: SelectionGroupProps<T>): ReactElement {
  const allChecked = items.length > 0 && items.every(isChecked);
  const someChecked = items.some(isChecked);

  return (
    <div className="export-tree__group">
      <label className="export-tree__parent">
        <TriStateCheckbox
          checked={allChecked}
          indeterminate={someChecked}
          disabled={items.length === 0}
          ariaLabel={label}
          onChange={onToggleAll}
        />
        <span>{label}</span>
      </label>
      {items.length === 0 ? (
        <p className="export-tree__empty">{emptyLabel}</p>
      ) : (
        items.map((item) => {
          const id = getId(item);
          const locked = isLocked?.(item) ?? false;
          const checked = isChecked(item);
          return (
            <label key={id} className="export-tree__child">
              <input
                type="checkbox"
                checked={checked}
                disabled={locked}
                onChange={() => onToggleItem(id)}
              />
              <span>{renderLabel(item)}</span>
              {locked && lockedHint !== undefined ? (
                <span className="export-tree__hint">{lockedHint}</span>
              ) : null}
              {renderExtra?.(item, checked)}
            </label>
          );
        })
      )}
    </div>
  );
}
