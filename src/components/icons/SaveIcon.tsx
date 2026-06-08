import type { ReactElement } from "react";

/**
 * Floppy-disk icon for "Save" buttons — the disk outline with the
 * write-protect notch and the label area, drawn with `currentColor` so the
 * surrounding button controls the hue. Inline SVG keeps it dependency-free and
 * matches the shared icon-action convention.
 */
export function SaveIcon(): ReactElement {
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
        d="M2.75 3.25A1.5 1.5 0 0 1 4.25 1.75h6.13a1.5 1.5 0 0 1 1.06.44l1.62 1.62a1.5 1.5 0 0 1 .44 1.06v7.38a1.5 1.5 0 0 1-1.5 1.5H4.25a1.5 1.5 0 0 1-1.5-1.5v-9z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M5 1.75v3.5h5v-3.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <rect
        x="4.75"
        y="8.25"
        width="6.5"
        height="4.5"
        rx="0.5"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  );
}
