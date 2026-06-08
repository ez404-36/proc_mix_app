import type { ReactElement } from "react";

/**
 * Counter-clockwise "undo / restore" arrow — a circular arrow returning to a
 * prior state. Drawn with `currentColor` so the surrounding element controls
 * the hue (orange when grouping with edits for an undone edit; blue when
 * restoring a deleted item). Used by the History action-icon column for the
 * `commandReverted` (undo of an edit) and `commandRestored` (restore of a
 * deletion) kinds. Inline SVG keeps it dependency-free and matches the icon
 * canon (16×16, `currentColor`, `aria-hidden`).
 */
export function RestoreIcon(): ReactElement {
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
        d="M3 8a5 5 0 1 1 1.5 3.6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M3 4.5V8h3.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
