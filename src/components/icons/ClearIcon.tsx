import type { ReactElement } from "react";

/**
 * Trash icon for "Clear" buttons — drawn with `currentColor` so the
 * surrounding button controls the hue. Inline SVG keeps it dependency-free
 * and matches the RunIcon/EditIcon convention.
 */
export function ClearIcon(): ReactElement {
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
        d="M3 4.5h10M6.5 4.5V3.5a1 1 0 011-1h1a1 1 0 011 1v1M4.5 4.5l.6 8a1 1 0 001 .9h3.8a1 1 0 001-.9l.6-8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
