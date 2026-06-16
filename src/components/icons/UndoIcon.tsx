import type { ReactElement } from "react";

/**
 * Counter-clockwise "undo" arrow — an arrow curving back to the left. Drawn
 * with `currentColor` so the surrounding button controls the hue. Used by the
 * workflow editor toolbar's Undo action. Matches the icon canon (16×16,
 * `currentColor`, `aria-hidden`).
 */
export function UndoIcon(): ReactElement {
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
        d="M5 6H10a3.5 3.5 0 0 1 0 7H6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.5 3.5L4.5 6l3 2.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
