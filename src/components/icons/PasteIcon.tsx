import type { ReactElement } from "react";

/**
 * Paste icon (clipboard) for the file manager's Paste action — drawn with
 * `currentColor` so the surrounding button controls the hue.
 */
export function PasteIcon(): ReactElement {
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
        x="3"
        y="3"
        width="10"
        height="11"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M6 3V2.2a.7.7 0 0 1 .7-.7h2.6a.7.7 0 0 1 .7.7V3z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
