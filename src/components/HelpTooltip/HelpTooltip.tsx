// Reusable "info icon + hover/focus popover" help affordance.
//
// Extracted from the CommandForm variables cheat-sheet so any form can pin a
// small "?" icon next to a label/control and surface a longer explanation on
// hover or keyboard focus. Behaviour:
//
//   - Open on `mouseenter` (icon) or `focus` (icon, keyboard users).
//   - Stay open while the cursor is over EITHER the icon OR the popover,
//     using a hover-intent close delay (`TOOLTIP_CLOSE_DELAY_MS`) so the user
//     can traverse the gap without the tooltip blinking shut.
//   - Close on `blur` (focus left both halves), on cursor leaving both halves
//     for the delay, or immediately on `Escape`.
//
// The popover is portalled to `document.body` (`position: fixed`) so it
// escapes any scrollable/clipping ancestor and stacking context. Body text is
// rendered with `white-space: pre-line` (see the CSS) so `\n` separators in
// the i18n string become real line breaks.
//
// Each instance needs a stable, unique `id` for the `aria-describedby` link
// between the trigger button and the popover.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactElement } from "react";
import { createPortal } from "react-dom";
import { InfoIcon } from "../icons";

interface HelpTooltipProps {
  /** Accessible label for the icon trigger button. */
  buttonLabel: string;
  /** Tooltip body text. `\n` produces line breaks (CSS `pre-line`). */
  body: string;
  /** Unique id linking trigger and popover via `aria-describedby`. */
  id: string;
}

/** Time (ms) the popover stays visible after the cursor leaves either half,
 *  giving the user time to move onto the other half. */
const TOOLTIP_CLOSE_DELAY_MS = 120;

export function HelpTooltip({
  buttonLabel,
  body,
  id,
}: HelpTooltipProps): ReactElement {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState<boolean>(false);
  // Anchor rect captured on open so we can position the popover. Recomputed
  // on each open rather than tracked live — the form doesn't move during the
  // tooltip's lifetime, and recomputing on scroll/resize would just close it.
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  // Resolved `top` (px, viewport coords) computed AFTER the popover renders so
  // the above/below flip uses the popover's real height — not a fixed
  // assumption. `null` until measured (first paint hides the popover).
  const [top, setTop] = useState<number | null>(null);

  const cancelClose = useCallback((): void => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback((): void => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, TOOLTIP_CLOSE_DELAY_MS);
  }, [cancelClose]);

  const openNow = useCallback((): void => {
    cancelClose();
    const rect = buttonRef.current?.getBoundingClientRect() ?? null;
    setAnchor(rect);
    // Hide until the layout effect measures the rendered popover and resolves
    // its real `top`, so it never flashes at a stale/assumed position.
    setTop(null);
    setOpen(true);
  }, [cancelClose]);

  // Close on Escape while open. Listener attached only while open so we don't
  // add a global keydown handler for every mount.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        // Stop a parent modal's own Escape handler from also closing the
        // whole form — the tooltip is "closer" so it wins.
        e.stopPropagation();
        cancelClose();
        setOpen(false);
        // Restore focus to the trigger so keyboard users keep their place.
        buttonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, cancelClose]);

  // Unmount cleanup: cancel any pending close timer so it can't fire after
  // the component is gone.
  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, []);

  // After the popover renders, measure its REAL height and resolve `top`:
  // place it just below the icon by default, flipping to just above only when
  // it would overflow the viewport bottom. Using the measured height (not a
  // fixed assumption) keeps a short tooltip anchored right next to the icon
  // rather than floating far above it.
  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const popover = popoverRef.current;
    if (!popover) return;
    const GAP = 6;
    const viewportH = typeof window !== "undefined" ? window.innerHeight : 0;
    const height = popover.getBoundingClientRect().height;
    const fitsBelow = anchor.bottom + GAP + height <= viewportH;
    const resolved = fitsBelow
      ? anchor.bottom + GAP
      : Math.max(8, anchor.top - GAP - height);
    setTop((prev) => (prev === resolved ? prev : resolved));
  }, [open, anchor, body]);

  const popoverStyle = ((): CSSProperties => {
    if (!anchor) return { visibility: "hidden" };
    // Align left edge with the icon, clamped so it never crosses the
    // viewport's left edge.
    const left = Math.max(8, anchor.left);
    return {
      position: "fixed",
      // Until measured, render off-screen-but-laid-out (visibility hidden) so
      // the layout effect can read its height without a visible flash.
      top: top ?? anchor.bottom + 6,
      left,
      maxHeight: 320,
      visibility: top === null ? "hidden" : "visible",
    };
  })();

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="btn btn--ghost btn--icon help-tooltip__trigger"
        aria-label={buttonLabel}
        aria-describedby={open ? id : undefined}
        onMouseEnter={openNow}
        onMouseLeave={scheduleClose}
        onFocus={openNow}
        onBlur={(e) => {
          const next = e.relatedTarget as Node | null;
          if (next && popoverRef.current?.contains(next)) return;
          scheduleClose();
        }}
      >
        <InfoIcon />
      </button>
      {open
        ? createPortal(
            <div
              ref={popoverRef}
              id={id}
              role="tooltip"
              className="help-tooltip__popover"
              style={popoverStyle}
              onMouseEnter={cancelClose}
              onMouseLeave={scheduleClose}
            >
              {body}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

