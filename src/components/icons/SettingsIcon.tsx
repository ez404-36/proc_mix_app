import type { ReactElement } from "react";

/**
 * Simplified gear glyph (dashed ring simulating teeth + hub circle) for the
 * Settings nav item — drawn with `currentColor` so the surrounding sidebar
 * button controls the hue. Replaces the legacy `⚙` Unicode glyph (see
 * docs/ui-conventions.md Navigation section).
 */
export function SettingsIcon(): ReactElement {
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
      <circle cx="8" cy="8" r="5.4" stroke="currentColor" strokeWidth="1.6" strokeDasharray="1.4 1.7" />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
