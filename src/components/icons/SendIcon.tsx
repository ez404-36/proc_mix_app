import type { ReactElement } from "react";

/**
 * Paper-plane glyph for assistant submission — drawn with `currentColor` and
 * sized to match the shared 16×16 icon set.
 */
export function SendIcon(): ReactElement {
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
        d="M14 2 7.25 8.75M14 2 9.5 14 7.25 8.75 2 6.5 14 2Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
