import type { ReactElement } from "react";

/**
 * Magnifier with a plus — "zoom in" control. Drawn with `currentColor` so the
 * surrounding button controls the hue. Inline SVG matches the icon convention.
 */
export function ZoomInIcon(): ReactElement {
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
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10.5 10.5 14 14M7 5v4M5 7h4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
