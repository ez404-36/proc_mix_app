import type { ReactElement } from "react";

/**
 * Trash-can icon for "Delete" buttons — drawn with `currentColor` so the
 * surrounding button controls the hue. Inline SVG keeps it dependency-free and
 * matches the shared icon-action convention.
 */
export function TrashIcon(): ReactElement {
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
        d="M6 2.5h4M3 4.5h10M4.5 4.5l.6 8.2a1.5 1.5 0 0 0 1.5 1.4h2.8a1.5 1.5 0 0 0 1.5-1.4l.6-8.2M6.8 7v5M9.2 7v5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
