import type { ReactElement } from "react";

/**
 * Four corner brackets framing the center — "fit view" control. Drawn with
 * `currentColor` so the surrounding button controls the hue.
 */
export function FitViewIcon(): ReactElement {
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
        d="M2 5V2h3M14 5V2h-3M2 11v3h3M14 11v3h-3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
