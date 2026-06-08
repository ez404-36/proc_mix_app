import type { ReactElement } from "react";

/**
 * Check (✓) icon for "Save / Confirm" buttons — drawn with `currentColor` so
 * the surrounding button controls the hue. Inline SVG keeps it dependency-free
 * and matches the shared icon-action convention.
 */
export function CheckIcon(): ReactElement {
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
        d="M3.5 8.5l3 3 6-7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
