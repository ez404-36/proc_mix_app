import type { ReactElement } from "react";

/**
 * Cut icon (scissors) for the file manager's Cut action — drawn with
 * `currentColor` so the surrounding button controls the hue.
 */
export function CutIcon(): ReactElement {
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
      <circle cx="4" cy="4" r="2" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4" cy="12" r="2" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M5.7 5.4 13.5 12.5M5.7 10.6 13.5 3.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
