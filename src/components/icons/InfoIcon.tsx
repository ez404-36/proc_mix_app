import type { ReactElement } from "react";

/**
 * Info / "?" glyph for the help affordance — drawn with `currentColor` so the
 * ghost-button style controls the hue (muted by default, primary on hover).
 * Inline SVG keeps it dependency-free and matches the shared icon convention.
 */
export function InfoIcon(): ReactElement {
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
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 7.2v3.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="8" cy="5.2" r="0.85" fill="currentColor" />
    </svg>
  );
}
