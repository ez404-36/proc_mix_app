import type { ReactElement } from "react";

/**
 * Table/list view icon: stacked horizontal rows. Drawn with `currentColor`
 * so the surrounding button controls the hue. Paired with
 * {@link TilesViewIcon} on the list display-mode toggle.
 */
export function TableViewIcon(): ReactElement {
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
      <rect x="2" y="3" width="12" height="2.5" rx="0.75" fill="currentColor" />
      <rect
        x="2"
        y="6.75"
        width="12"
        height="2.5"
        rx="0.75"
        fill="currentColor"
      />
      <rect
        x="2"
        y="10.5"
        width="12"
        height="2.5"
        rx="0.75"
        fill="currentColor"
      />
    </svg>
  );
}
