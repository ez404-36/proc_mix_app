import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ChangeEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
} from "react";
import { createPortal } from "react-dom";

export interface DropdownOption {
  value: string;
  label: string;
  /**
   * Optional one-line description shown as a subtitle below the label in the
   * popup. Useful for flag options where a brief hint helps the user choose.
   */
  description?: string;
  /**
   * When true, the option is rendered but cannot be selected: keyboard
   * navigation skips over it and click is a no-op. Used to keep a
   * stored-but-unavailable value visible in edit mode so the user is
   * aware that the value exists without being able to re-commit it.
   */
  disabled?: boolean;
}

export interface DropdownProps {
  value: string;
  options: ReadonlyArray<DropdownOption>;
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  /** Optional className to apply to the trigger button. */
  className?: string;
  /**
   * Optional className for the portal-rendered popup. Because the popup is
   * portalled to `document.body`, a caller cannot reach it via a CSS
   * descendant of its own wrapper; this prop lets a caller size/skin the
   * popup (and its options) to match a compact trigger.
   */
  popupClassName?: string;
  /** Optional id for the trigger; useful for label `htmlFor`. */
  id?: string;
  /**
   * When true, a search input is rendered at the top of the popup.
   * Options are filtered in real time as the user types; the query matches
   * against both `label` and `description` (case-insensitive).
   * Disabled options are always hidden from search results.
   */
  searchable?: boolean;
  /** Placeholder text for the search input (only used when searchable=true). */
  searchPlaceholder?: string;
}

interface PopupPosition {
  left: number;
  top: number;
  width: number;
  /** Whether the popup is rendered above the trigger (flipped). */
  flipped: boolean;
}

const POPUP_MARGIN = 4;
const VIEWPORT_PADDING = 8;

/**
 * Generic single-select dropdown with a portal-rendered popup.
 *
 * Why a custom dropdown: native `<select>` elements delegate the option popup
 * to the OS, which cannot be styled with CSS. This implementation renders the
 * options ourselves so the look matches the rest of the app in both light and
 * dark themes.
 *
 * Keyboard model:
 *   - Closed trigger: Space / Enter / ArrowDown / ArrowUp open the popup.
 *   - Open popup: ArrowDown / ArrowUp move the active highlight, Enter /
 *     Space commit the highlighted option, Escape closes without changes,
 *     Tab closes (focus moves normally to the next focusable element).
 *   - When searchable: typing characters moves focus to the search input
 *     automatically; ArrowDown / ArrowUp move between filtered options.
 *
 * Accessibility:
 *   - Trigger button gets `aria-haspopup="listbox"` and `aria-expanded`.
 *   - Popup is `role="listbox"`; options use `role="option"` and
 *     `aria-selected`. The trigger uses `aria-activedescendant` to point at
 *     the highlighted option while the popup is open, so screen readers can
 *     follow keyboard navigation without losing focus from the trigger.
 *
 * StrictMode safety: every effect registers its listeners in a single
 * `useEffect` and removes them in the matching cleanup. There is no
 * module-level state, so double-mount under StrictMode is harmless.
 */
export function Dropdown(props: DropdownProps): ReactElement {
  const {
    value,
    options,
    onChange,
    ariaLabel,
    disabled = false,
    className,
    popupClassName,
    id,
    searchable = false,
    searchPlaceholder = "Search…",
  } = props;

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);

  const [open, setOpen] = useState<boolean>(false);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [position, setPosition] = useState<PopupPosition | null>(null);
  const [query, setQuery] = useState<string>("");

  // Stable id namespace so trigger/option ids reference each other.
  const baseId = useId();
  const optionId = (idx: number): string => `${baseId}-opt-${idx}`;

  const selectedIndex = useMemo(
    () => options.findIndex((opt) => opt.value === value),
    [options, value],
  );

  const selectedLabel = useMemo(() => {
    const found = options.find((opt) => opt.value === value);
    return found?.label ?? value;
  }, [options, value]);

  // Filtered options: when searchable and query is non-empty, filter by label
  // and description. Disabled options are always excluded from search results
  // so the user can't accidentally navigate to the sentinel placeholder.
  const filteredOptions = useMemo((): ReadonlyArray<DropdownOption> => {
    if (!searchable || query.trim() === "") return options;
    const lower = query.toLowerCase();
    return options.filter((opt) => {
      if (opt.disabled) return false;
      if (opt.label.toLowerCase().includes(lower)) return true;
      if (opt.description && opt.description.toLowerCase().includes(lower)) return true;
      return false;
    });
  }, [searchable, query, options]);

  // When filtered options change, reset active index to the first item.
  useEffect(() => {
    if (open) setActiveIndex(filteredOptions.length > 0 ? 0 : -1);
  }, [filteredOptions, open]);

  /**
   * First selectable (non-disabled) option index within filteredOptions,
   * or -1 if every option is disabled.
   */
  const firstEnabledIndex = useMemo(() => {
    for (let i = 0; i < filteredOptions.length; i++) {
      const opt = filteredOptions[i];
      if (opt && !opt.disabled) return i;
    }
    return -1;
  }, [filteredOptions]);

  /**
   * Walks filteredOptions to find the next enabled index starting
   * from `from + step`, wrapping around.
   */
  const nextEnabledIndex = useCallback(
    (from: number, step: 1 | -1): number => {
      const len = filteredOptions.length;
      if (len === 0) return -1;
      let cursor = from;
      for (let i = 0; i < len; i++) {
        cursor = (cursor + step + len) % len;
        const opt = filteredOptions[cursor];
        if (opt && !opt.disabled) return cursor;
      }
      return -1;
    },
    [filteredOptions],
  );

  const computePosition = useCallback((): PopupPosition | null => {
    const trigger = triggerRef.current;
    if (!trigger) return null;
    const rect = trigger.getBoundingClientRect();
    const vh = window.innerHeight;
    const spaceBelow = vh - rect.bottom - VIEWPORT_PADDING;
    const spaceAbove = rect.top - VIEWPORT_PADDING;
    const flipped = spaceBelow < 160 && spaceAbove > spaceBelow;
    const top = flipped
      ? Math.max(VIEWPORT_PADDING, rect.top - POPUP_MARGIN)
      : rect.bottom + POPUP_MARGIN;
    return {
      left: rect.left,
      top,
      width: rect.width,
      flipped,
    };
  }, []);

  const openPopup = useCallback((): void => {
    if (disabled) return;
    const pos = computePosition();
    if (pos) setPosition(pos);
    setQuery("");
    setOpen(true);
    const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null;
    if (selectedOption && !selectedOption.disabled) {
      setActiveIndex(selectedIndex);
    } else {
      setActiveIndex(firstEnabledIndex);
    }
  }, [computePosition, disabled, firstEnabledIndex, options, selectedIndex]);

  const closePopup = useCallback((restoreFocus: boolean): void => {
    setOpen(false);
    setActiveIndex(-1);
    setQuery("");
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Focus the search input when the popup opens (searchable mode only).
  useEffect(() => {
    if (open && searchable) {
      // Defer slightly so the portal renders before we try to focus.
      const id = window.setTimeout(() => {
        searchRef.current?.focus();
      }, 0);
      return () => window.clearTimeout(id);
    }
  }, [open, searchable]);

  const commit = useCallback(
    (idx: number): void => {
      const next = filteredOptions[idx];
      if (!next) {
        closePopup(true);
        return;
      }
      if (next.disabled) return;
      if (next.value !== value) onChange(next.value);
      closePopup(true);
    },
    [closePopup, onChange, filteredOptions, value],
  );

  // Recompute the popup position once it has rendered so the flip decision
  // accounts for the popup's actual height.
  useLayoutEffect(() => {
    if (!open) return;
    const popup = popupRef.current;
    const trigger = triggerRef.current;
    if (!popup || !trigger) return;
    const rect = trigger.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    const vh = window.innerHeight;
    const spaceBelow = vh - rect.bottom - VIEWPORT_PADDING;
    const flipped =
      popupRect.height > spaceBelow && rect.top > popupRect.height;
    const top = flipped
      ? Math.max(VIEWPORT_PADDING, rect.top - popupRect.height - POPUP_MARGIN)
      : rect.bottom + POPUP_MARGIN;
    setPosition((prev) =>
      prev && prev.top === top && prev.flipped === flipped
        ? prev
        : { left: rect.left, top, width: rect.width, flipped },
    );
  }, [open]);

  // Click outside / scroll / resize close the popup.
  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (!target) return;
      if (popupRef.current && popupRef.current.contains(target)) return;
      if (triggerRef.current && triggerRef.current.contains(target)) return;
      closePopup(false);
    };

    const handleResize = (): void => {
      const next = computePosition();
      if (next) setPosition(next);
    };

    const handleScroll = (event: Event): void => {
      const target = event.target as Node | null;
      if (popupRef.current && target && popupRef.current.contains(target)) {
        return;
      }
      closePopup(false);
    };

    window.addEventListener("mousedown", handlePointerDown, true);
    window.addEventListener("resize", handleResize);
    window.addEventListener("scroll", handleScroll, true);

    return () => {
      window.removeEventListener("mousedown", handlePointerDown, true);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [open, closePopup, computePosition]);

  // Scroll the active option into view when keyboard nav moves the highlight.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const node = optionRefs.current[activeIndex];
    if (node) node.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const handleTriggerKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ): void => {
    if (disabled) return;
    if (!open) {
      if (
        event.key === "Enter" ||
        event.key === " " ||
        event.key === "ArrowDown" ||
        event.key === "ArrowUp"
      ) {
        event.preventDefault();
        openPopup();
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((idx) => {
        if (filteredOptions.length === 0) return -1;
        const from = idx < 0 ? filteredOptions.length - 1 : idx;
        return nextEnabledIndex(from, 1);
      });
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((idx) => {
        if (filteredOptions.length === 0) return -1;
        const from = idx < 0 ? 0 : idx;
        return nextEnabledIndex(from, -1);
      });
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      if (filteredOptions.length > 0) setActiveIndex(firstEnabledIndex);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      if (filteredOptions.length > 0) {
        setActiveIndex(nextEnabledIndex(0, -1));
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (activeIndex >= 0) commit(activeIndex);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closePopup(true);
      return;
    }
    if (event.key === "Tab") {
      closePopup(false);
      return;
    }
  };

  // Keyboard handler for the search input.
  const handleSearchKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((idx) => {
        if (filteredOptions.length === 0) return -1;
        const from = idx < 0 ? filteredOptions.length - 1 : idx;
        return nextEnabledIndex(from, 1);
      });
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((idx) => {
        if (filteredOptions.length === 0) return -1;
        const from = idx < 0 ? 0 : idx;
        return nextEnabledIndex(from, -1);
      });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (activeIndex >= 0) commit(activeIndex);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closePopup(true);
      return;
    }
    if (event.key === "Tab") {
      closePopup(false);
      return;
    }
  };

  const handleTriggerClick = (): void => {
    if (disabled) return;
    if (open) {
      closePopup(true);
    } else {
      openPopup();
    }
  };

  const triggerClassName =
    "dropdown__trigger" + (className ? ` ${className}` : "");

  const trigger = (
    <button
      ref={triggerRef}
      id={id}
      type="button"
      className={triggerClassName}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={ariaLabel}
      aria-activedescendant={
        open && activeIndex >= 0 ? optionId(activeIndex) : undefined
      }
      disabled={disabled}
      onClick={handleTriggerClick}
      onKeyDown={handleTriggerKeyDown}
    >
      <span className="dropdown__value">{selectedLabel}</span>
      <span className="dropdown__chevron" aria-hidden="true">
        ▾
      </span>
    </button>
  );

  const popup =
    open && position ? (
      <div
        ref={popupRef}
        className={
          "dropdown__popup" +
          (position.flipped ? " dropdown__popup--flipped" : "") +
          (popupClassName ? ` ${popupClassName}` : "")
        }
        role="listbox"
        aria-label={ariaLabel}
        style={{
          left: position.left,
          top: position.top,
          minWidth: position.width,
        }}
        onMouseDown={(e) => {
          // Prevent the trigger from losing focus when clicking inside the
          // popup (keeps aria-activedescendant pointing at the right option).
          // Exception: the search input must be able to receive focus.
          const target = e.target as HTMLElement;
          if (target.tagName !== "INPUT") e.preventDefault();
        }}
      >
        {searchable ? (
          <div className="dropdown__search">
            <input
              ref={searchRef}
              type="text"
              className="input dropdown__search-input"
              value={query}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setQuery(e.target.value);
              }}
              onKeyDown={handleSearchKeyDown}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        ) : null}
        {filteredOptions.length === 0 && searchable ? (
          <div className="dropdown__search-empty">—</div>
        ) : null}
        {filteredOptions.map((opt, idx) => {
          const isSelected = opt.value === value;
          const isActive = idx === activeIndex;
          const isDisabled = opt.disabled === true;
          const cls =
            "dropdown__option" +
            (isActive ? " dropdown__option--active" : "") +
            (isSelected ? " dropdown__option--selected" : "") +
            (isDisabled ? " dropdown__option--disabled" : "");
          return (
            <div
              key={opt.value}
              ref={(el) => {
                optionRefs.current[idx] = el;
              }}
              id={optionId(idx)}
              className={cls}
              role="option"
              aria-selected={isSelected}
              aria-disabled={isDisabled ? true : undefined}
              onMouseEnter={() => {
                if (!isDisabled) setActiveIndex(idx);
              }}
              onClick={() => {
                if (!isDisabled) commit(idx);
              }}
            >
              <span className="dropdown__option-label">{opt.label}</span>
              {opt.description ? (
                <span className="dropdown__option-description">
                  {opt.description}
                </span>
              ) : null}
              {isSelected && !isDisabled ? (
                <span className="dropdown__option-check" aria-hidden="true">
                  ✓
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    ) : null;

  return (
    <span className="dropdown">
      {trigger}
      {popup ? createPortal(popup, document.body) : null}
    </span>
  );
}
