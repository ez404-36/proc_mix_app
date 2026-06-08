import type { ReactElement } from "react";

/**
 * Circular-arrow (↻) icon for "Rerun" buttons — drawn with `currentColor`
 * so the surrounding button controls the hue. Inline SVG keeps it
 * dependency-free and matches the RunIcon/EditIcon convention.
 */
export function RerunIcon(): ReactElement {
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
        d="M13 8a5 5 0 11-1.46-3.54"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M13 3v2.5h-2.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
