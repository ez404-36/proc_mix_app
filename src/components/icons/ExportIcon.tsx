import type { ReactElement } from "react";

/**
 * Up-arrow (tray-out) icon for "Export" buttons — drawn with `currentColor`
 * so the surrounding button controls the hue. Inline SVG keeps it
 * dependency-free and matches the EditIcon/ClearIcon convention.
 */
export function ExportIcon(): ReactElement {
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
        d="M8 10V2.5M8 2.5L5 5.5M8 2.5l3 3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 9.5v3a1 1 0 001 1h8a1 1 0 001-1v-3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
