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
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
} from "react";
import { createPortal } from "react-dom";

export interface DropdownOption {
  value: string;
  label: string;
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
  } = props;

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);

  const [open, setOpen] = useState<boolean>(false);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [position, setPosition] = useState<PopupPosition | null>(null);

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

  /**
   * First selectable (non-disabled) option index, or -1 if every option
   * is disabled. Used as the fallback highlight on open when the
   * currently-selected value is itself disabled.
   */
  const firstEnabledIndex = useMemo(() => {
    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      if (opt && !opt.disabled) return i;
    }
    return -1;
  }, [options]);

  /**
   * Walks the options list to find the next enabled index starting
   * from `from + step`, wrapping around. Returns -1 only when every
   * option is disabled.
   */
  const nextEnabledIndex = useCallback(
    (from: number, step: 1 | -1): number => {
      const len = options.length;
      if (len === 0) return -1;
      let cursor = from;
      for (let i = 0; i < len; i++) {
        cursor = (cursor + step + len) % len;
        const opt = options[cursor];
        if (opt && !opt.disabled) return cursor;
      }
      return -1;
    },
    [options],
  );

  const computePosition = useCallback((): PopupPosition | null => {
    const trigger = triggerRef.current;
    if (!trigger) return null;
    const rect = trigger.getBoundingClientRect();
    const vh = window.innerHeight;
    // Popup is sized after first paint; we cap to the smaller of (remaining
    // space below) and (remaining space above) so it always fits the viewport.
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
    setOpen(true);
    // Start with the currently-selected option highlighted if it is
    // selectable; otherwise fall back to the first enabled option. If
    // every option is disabled (degenerate case — no shells available
    // but the form still rendered the dropdown), there is nothing to
    // highlight and we leave activeIndex at -1.
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
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const commit = useCallback(
    (idx: number): void => {
      const next = options[idx];
      if (!next) {
        closePopup(true);
        return;
      }
      // Disabled options are visible but not selectable; treat the
      // commit as a no-op so keyboard Enter on a disabled row (which
      // shouldn't reach here because nav skips disabled) and any
      // accidental click both fall through silently.
      if (next.disabled) {
        return;
      }
      if (next.value !== value) onChange(next.value);
      closePopup(true);
    },
    [closePopup, onChange, options, value],
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
      // Click outside both trigger and popup: close without restoring focus
      // (the click already moved focus to wherever the user clicked).
      closePopup(false);
    };

    const handleResize = (): void => {
      const next = computePosition();
      if (next) setPosition(next);
    };

    // Closing on scroll keeps the popup from drifting away from the trigger
    // (we don't reposition on scroll because most parent scrolls indicate
    // the user is moving on).
    const handleScroll = (event: Event): void => {
      // Ignore scrolls that happen inside the popup itself.
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
    // Open: route navigation/commit/close keys. Disabled options are
    // skipped — nextEnabledIndex wraps around and returns -1 only when
    // every option is disabled.
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((idx) => {
        if (options.length === 0) return -1;
        // Starting from -1 (no current highlight) we want the first
        // enabled, so seed at the last index so step=+1 wraps to 0.
        const from = idx < 0 ? options.length - 1 : idx;
        return nextEnabledIndex(from, 1);
      });
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((idx) => {
        if (options.length === 0) return -1;
        const from = idx < 0 ? 0 : idx;
        return nextEnabledIndex(from, -1);
      });
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      if (options.length > 0) setActiveIndex(firstEnabledIndex);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      if (options.length > 0) {
        // Walk backwards from index 0 (with wrap) to find the last
        // enabled option in the list.
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
      // Let the browser handle Tab — we just close the popup so the user
      // can move on to the next focusable element naturally.
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
          e.preventDefault();
        }}
      >
        {options.map((opt, idx) => {
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
                // Skip highlight on disabled options so the keyboard
                // and mouse cursors agree on what is selectable.
                if (!isDisabled) setActiveIndex(idx);
              }}
              onClick={() => {
                if (!isDisabled) commit(idx);
              }}
            >
              <span className="dropdown__option-label">{opt.label}</span>
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
