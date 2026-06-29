import type { ReactElement } from "react";

/**
 * Logout / sign-out icon — a panel with an arrow exiting to the right. Drawn
 * with `currentColor` so the surrounding button controls the hue (used by the
 * web UI's danger-styled "Log out" button). Inline SVG, dependency-free, 16×16,
 * matching the icon-set convention.
 */
export function LogoutIcon(): ReactElement {
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
        d="M6 2H3.5A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14H6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 5l3 3-3 3M13 8H6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
