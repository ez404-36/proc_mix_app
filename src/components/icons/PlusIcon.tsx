import type { ReactElement } from "react";

/**
 * Plus (+) icon for "New / Add" buttons — drawn with `currentColor` so the
 * surrounding button controls the hue. Inline SVG keeps it dependency-free and
 * matches the shared icon-action convention.
 */
export function PlusIcon(): ReactElement {
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
        d="M8 3v10M3 8h10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
