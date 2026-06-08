import type { ReactElement } from "react";

/**
 * Checkmark glyph for the "success / finished" status — drawn with
 * `currentColor` so the surrounding status `<span>` controls the hue. 14×14 to
 * sit inline with the status badges (heavier stroke than the 16×16 CheckIcon).
 */
export function StatusCheckIcon(): ReactElement {
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
        d="M2.5 7.5l3 3 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
