import type { ReactElement } from "react";

/**
 * Clockwise "redo" arrow — the mirror of {@link UndoIcon}, curving back to the
 * right. Drawn with `currentColor` so the surrounding button controls the hue.
 * Used by the workflow editor toolbar's Redo action. Matches the icon canon
 * (16×16, `currentColor`, `aria-hidden`).
 */
export function RedoIcon(): ReactElement {
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
        d="M11 6H6a3.5 3.5 0 0 0 0 7H10"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.5 3.5L11.5 6l-3 2.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
