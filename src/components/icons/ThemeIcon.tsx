import type { ReactElement } from "react";

/**
 * Half-filled circle (light/dark split) for the theme-cycle button — drawn
 * with `currentColor` so the surrounding button controls the hue. Replaces
 * the legacy `◐` Unicode glyph (see docs/ui-conventions.md Navigation
 * section).
 */
export function ThemeIcon(): ReactElement {
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
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 2a6 6 0 0 0 0 12z" fill="currentColor" />
    </svg>
  );
}
