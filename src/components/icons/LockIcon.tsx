import type { ReactElement } from "react";

/**
 * Padlock — the canvas "lock interactions" control. When `locked` is true the
 * shackle is closed (down); when false it is open (raised on the right), the
 * "click to lock" affordance. Same 16×16 / `currentColor` convention as the
 * other control icons; the shackle is `fill="none"` so v12's forced
 * `fill: currentColor` on control-button svgs doesn't flood it.
 */
export function LockIcon({
  locked = true,
}: {
  locked?: boolean;
}): ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      {/* Body of the lock. */}
      <rect
        x="3.5"
        y="7.5"
        width="9"
        height="6"
        rx="1.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      {/* Shackle. LOCKED: symmetric, both legs enter the body top (closed).
          OPEN: the whole shackle is raised and its right leg is detached and
          swung up-left, so the open state reads as an obviously different
          silhouette — not just a slightly taller arc. */}
      <path
        d={
          locked
            ? "M5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2"
            : "M5.5 7.5V5.5a2.5 2.5 0 0 1 4.3 -1.3"
        }
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {/* Keyhole. */}
      <circle cx="8" cy="10.5" r="0.9" fill="currentColor" />
    </svg>
  );
}
