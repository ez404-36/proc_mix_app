import type { ReactElement } from "react";

/**
 * Cross glyph for the "error / failed" status — drawn with `currentColor` so
 * the surrounding status `<span>` controls the hue. 14×14 to sit inline with
 * the status badges (heavier stroke than the 16×16 CancelIcon).
 */
export function StatusCrossIcon(): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M3 3l8 8M11 3l-8 8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
