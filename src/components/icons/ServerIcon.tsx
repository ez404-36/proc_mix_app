import type { ReactElement } from "react";

/**
 * Stacked-server glyph for the HTTP server indicator. Drawn with
 * `currentColor` so the surrounding button/indicator style controls the hue.
 * Inline SVG keeps it dependency-free and matches the shared icon convention
 * (16×16, `currentColor`, `aria-hidden`).
 */
export function ServerIcon(): ReactElement {
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
      <rect
        x="2.5"
        y="2.5"
        width="11"
        height="4.5"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <rect
        x="2.5"
        y="9"
        width="11"
        height="4.5"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <circle cx="5" cy="4.75" r="0.85" fill="currentColor" />
      <circle cx="5" cy="11.25" r="0.85" fill="currentColor" />
    </svg>
  );
}
