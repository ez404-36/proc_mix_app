import type { ReactElement } from "react";

/**
 * Magnifier with a minus — "zoom out" control. Same lens/handle geometry as
 * {@link ZoomInIcon} but with only the horizontal bar, so the `−` reads clearly
 * at 16px. Drawn with `currentColor` so the surrounding button controls the hue.
 */
export function ZoomOutIcon(): ReactElement {
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
      <circle cx="6.5" cy="6.5" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10.5 10.5 14.5 14.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M4 6.5h5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
