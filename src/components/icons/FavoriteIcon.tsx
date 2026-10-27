import type { ReactElement } from "react";

/**
 * Five-pointed star for favorite toggles. `filled` marks the active state;
 * the inactive state remains outline-only so it reads as an available action.
 * Drawn with `currentColor` so `.favorite-toggle` controls the hue.
 */
export function FavoriteIcon({
  filled = false,
}: {
  filled?: boolean;
}): ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      xmlns="http://www.w3.org/2000/svg"
      stroke="currentColor"
      strokeWidth={filled ? 0 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m12 2.5 2.94 5.95 6.56.95-4.75 4.63 1.12 6.54L12 17.48l-5.87 3.09 1.12-6.54L2.5 9.4l6.56-.95L12 2.5Z" />
    </svg>
  );
}
