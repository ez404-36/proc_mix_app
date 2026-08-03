import type { ReactElement } from "react";

/**
 * Filled-dot-in-ring "record" glyph for the Recorder (Process Capture) nav
 * item — drawn with `currentColor` so the surrounding sidebar button
 * controls the hue. Replaces the legacy `⏺` Unicode glyph (see
 * docs/ui-conventions.md Navigation section).
 */
export function RecordIcon(): ReactElement {
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
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="8" r="3" fill="currentColor" />
    </svg>
  );
}
