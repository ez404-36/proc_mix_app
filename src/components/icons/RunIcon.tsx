import type { ReactElement } from "react";

/**
 * Play (▶) icon for "Run" buttons — a right-pointing triangle drawn with
 * `currentColor` so the surrounding button controls the hue. Shared by the
 * list cards on Home / Library (filled-green `btn--run`). Inline SVG keeps it
 * dependency-free and matches the CommandForm action-icon convention.
 */
export function RunIcon(): ReactElement {
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
      <path d="M5 3.5l7 4.5-7 4.5v-9z" fill="currentColor" />
    </svg>
  );
}
