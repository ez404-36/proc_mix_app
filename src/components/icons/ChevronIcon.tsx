import type { ReactElement } from "react";

/**
 * Disclosure chevron (▸) pointing right when collapsed. Drawn with
 * `currentColor`. The accordion rotates it to point down via the `is-open`
 * class on its container, so this icon itself is orientation-neutral —
 * callers must not flip it in JS.
 */
export function ChevronIcon(): ReactElement {
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
        d="M6 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
