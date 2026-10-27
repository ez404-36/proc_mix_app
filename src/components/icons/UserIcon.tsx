import type { ReactElement } from "react";

/**
 * Person glyph for per-object assistant permission controls — drawn with
 * `currentColor` so the surrounding button can indicate allowed/denied state.
 */
export function UserIcon(): ReactElement {
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
      <circle cx="8" cy="5.1" r="2.65" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M2.9 13.55c0-2.55 2.3-4.15 5.1-4.15s5.1 1.6 5.1 4.15"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
