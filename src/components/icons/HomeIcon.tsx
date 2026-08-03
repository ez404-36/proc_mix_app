import type { ReactElement } from "react";

/**
 * House-outline glyph for the Home nav item — drawn with `currentColor` so
 * the surrounding sidebar button controls the hue. Replaces the legacy `⌂`
 * Unicode glyph (see docs/ui-conventions.md Navigation section).
 */
export function HomeIcon(): ReactElement {
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
      <path
        d="M2 8.5 8 3l6 5.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3.5 7.5V13a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V7.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M6.5 14V10.5h3V14"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
