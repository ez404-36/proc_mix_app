import type { ReactElement } from "react";

/**
 * Spinner glyph (track ring + arc) for the "running" status — drawn with
 * `currentColor` so the surrounding status `<span>` controls the hue and the
 * CSS rotation animation. 14×14 to sit inline with the status badges.
 */
export function SpinnerIcon(): ReactElement {
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
      <circle
        cx="7"
        cy="7"
        r="5.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeOpacity="0.25"
      />
      <path
        d="M12.5 7a5.5 5.5 0 0 0-5.5-5.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
