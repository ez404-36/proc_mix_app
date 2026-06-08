import type { ReactElement } from "react";

/**
 * Cross (✕) icon for "Cancel" buttons — drawn with `currentColor` so the
 * surrounding button controls the hue. Used by the outlined-danger Cancel
 * button. Inline SVG keeps it dependency-free and matches the CommandForm
 * action-icon convention.
 */
export function CancelIcon(): ReactElement {
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
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
