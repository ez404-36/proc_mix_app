import type { ReactElement } from "react";

/**
 * Terminal (prompt) icon for the "New terminal" console action — a window
 * frame with a `>` prompt glyph and a cursor bar, drawn with `currentColor`
 * so the surrounding button controls the hue.
 */
export function TerminalIcon(): ReactElement {
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
      <rect
        x="1.5"
        y="2.5"
        width="13"
        height="11"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M4.5 6.2 7 8l-2.5 1.8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8.3 10.4h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
