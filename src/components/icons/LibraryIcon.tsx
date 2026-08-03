import type { ReactElement } from "react";

/**
 * Three book spines for the Library nav item — drawn with `currentColor` so
 * the surrounding sidebar button controls the hue. Replaces the legacy `▤`
 * Unicode glyph (see docs/ui-conventions.md Navigation section).
 */
export function LibraryIcon(): ReactElement {
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
      <rect x="2" y="2.5" width="2.6" height="11" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
      <rect x="6.7" y="2.5" width="2.6" height="11" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
      <rect x="11.4" y="2.5" width="2.6" height="11" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
