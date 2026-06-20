// Generic hover/focus tooltip wrapper with a CONFIGURABLE show delay.
//
// Unlike a native `title` attribute — whose appear delay is fixed by the
// OS/browser and cannot be tuned — this wrapper opens its own portalled
// popover after `showDelayMs`. It is used by the workflow node palette so
// the node-description tooltips wait a beat before appearing (and don't
// flicker as the cursor sweeps across the button column).
//
// The popover reuses the `.help-tooltip__popover` styling and is portalled
// to `document.body` (`position: fixed`) so it escapes scroll/clip
// ancestors. It opens on `mouseenter`/`focus` of the wrapped trigger and
// closes on `mouseleave`/`blur`/`Escape`.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";

interface HoverTooltipProps {
  /** Tooltip body text. `\n` produces line breaks (CSS `pre-line`). */
  label: string;
  /** The trigger element(s) the tooltip is anchored to. */
  children: ReactNode;
  /**
   * Delay (ms) before the tooltip appears after the cursor enters the
   * trigger. Defaults to {@link DEFAULT_SHOW_DELAY_MS}. A keyboard focus
   * opens immediately (no delay) for accessibility.
   */
  showDelayMs?: number;
}

/** Default appear delay (ms). Deliberately longer than a native `title`'s
 *  perceived delay so palette tooltips don't pop the instant the cursor
 *  grazes a button. */
const DEFAULT_SHOW_DELAY_MS = 700;

/** Assumed max popover height (px) for the above/below flip decision. */
const MAX_POPOVER_H = 320;

export function HoverTooltip({
  label,
  children,
  showDelayMs = DEFAULT_SHOW_DELAY_MS,
}: HoverTooltipProps): ReactElement {
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState<boolean>(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [top, setTop] = useState<number | null>(null);

  const cancelShow = useCallback((): void => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
  }, []);

  const openNow = useCallback((): void => {
    cancelShow();
    // The wrapper is `display: contents`, so it has NO geometry of its own
    // (getBoundingClientRect would return an all-zero rect and pin the
    // tooltip to the top-left corner). Anchor to the first real child
    // element — the actual trigger (e.g. the palette button) — instead.
    const trigger = wrapperRef.current?.firstElementChild ?? null;
    setAnchor(trigger?.getBoundingClientRect() ?? null);
    setTop(null);
    setOpen(true);
  }, [cancelShow]);

  const openAfterDelay = useCallback((): void => {
    cancelShow();
    showTimerRef.current = window.setTimeout(() => {
      showTimerRef.current = null;
      openNow();
    }, showDelayMs);
  }, [cancelShow, openNow, showDelayMs]);

  const close = useCallback((): void => {
    cancelShow();
    setOpen(false);
  }, [cancelShow]);

  // Close on Escape while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  // Cancel any pending show timer on unmount.
  useEffect(() => cancelShow, [cancelShow]);

  // Resolve the popover's real `top` after render, flipping above the
  // trigger when it would overflow the viewport bottom.
  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const popover = popoverRef.current;
    if (!popover) return;
    const GAP = 6;
    const viewportH = typeof window !== "undefined" ? window.innerHeight : 0;
    const height = popover.getBoundingClientRect().height || MAX_POPOVER_H;
    const fitsBelow = anchor.bottom + GAP + height <= viewportH;
    const resolved = fitsBelow
      ? anchor.bottom + GAP
      : Math.max(8, anchor.top - GAP - height);
    setTop((prev) => (prev === resolved ? prev : resolved));
  }, [open, anchor, label]);

  const popoverStyle = ((): CSSProperties => {
    if (!anchor) return { visibility: "hidden" };
    return {
      position: "fixed",
      top: top ?? anchor.bottom + 6,
      left: Math.max(8, anchor.left),
      maxHeight: MAX_POPOVER_H,
      visibility: top === null ? "hidden" : "visible",
    };
  })();

  return (
    <span
      ref={wrapperRef}
      className="hover-tooltip__wrap"
      onMouseEnter={openAfterDelay}
      onMouseLeave={close}
      onFocusCapture={openNow}
      onBlurCapture={close}
    >
      {children}
      {open
        ? createPortal(
            <div
              ref={popoverRef}
              role="tooltip"
              className="help-tooltip__popover hover-tooltip__popover"
              style={popoverStyle}
            >
              {label}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
