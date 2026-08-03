import type { ReactElement } from "react";

/**
 * Clock face with a counter-clockwise "rewind" arrow for the History nav
 * item — drawn with `currentColor` so the surrounding sidebar button
 * controls the hue. The open arrow tail (vs. {@link SchedulerIcon}'s bell
 * legs) reads as "past runs" rather than "upcoming schedule". Replaces the
 * legacy `⏱` Unicode glyph (see docs/ui-conventions.md Navigation section).
 */
export function HistoryIcon(): ReactElement {
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
        d="M3.5 5A5.5 5.5 0 1 1 2.6 9.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M2 3v3h3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 5.5V9l2.3 1.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
