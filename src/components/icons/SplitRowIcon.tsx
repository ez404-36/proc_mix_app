import type { ReactElement } from "react";

/**
 * "Split horizontally" icon — a frame divided by a HORIZONTAL line into two
 * stacked panes, matching the `column` split direction (children laid out
 * top-to-bottom, a horizontal resizable border between them). Drawn with
 * `currentColor` so the surrounding control sets the hue.
 */
export function SplitRowIcon(): ReactElement {
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
        x="1.5"
        y="2.5"
        width="13"
        height="11"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path d="M2.8 8h10.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
