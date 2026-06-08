import type { ReactElement } from "react";

/**
 * Eye glyph for the password "reveal" toggle — drawn with `currentColor` so
 * the surrounding button controls the hue. 18px matches the input line-height.
 * Inline SVG keeps it dependency-free and matches the shared icon convention.
 */
export function EyeIcon(): ReactElement {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
