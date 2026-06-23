import type { ReactElement } from "react";

/**
 * Copy icon (two overlapping sheets) for the file manager's Copy action —
 * drawn with `currentColor` so the surrounding button controls the hue.
 */
export function CopyIcon(): ReactElement {
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
        x="5.5"
        y="5.5"
        width="8"
        height="8"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M3.5 10.5h-.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
