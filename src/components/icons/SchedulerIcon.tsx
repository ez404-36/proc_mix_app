import type { ReactElement } from "react";

/**
 * Alarm-clock glyph (clock face + two top "bell legs") for the Scheduler nav
 * item — drawn with `currentColor` so the surrounding sidebar button
 * controls the hue. The bell legs distinguish it from {@link HistoryIcon}'s
 * plain clock-with-arrow silhouette. Replaces the legacy `⏲` Unicode glyph
 * (see docs/ui-conventions.md Navigation section).
 */
export function SchedulerIcon(): ReactElement {
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
      <circle cx="8" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 6v3l2 1.3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M3 2.5 5 4.5M13 2.5 11 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
