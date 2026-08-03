import type { ReactElement } from "react";

/**
 * Panel-with-sidebar glyph (outer frame + a filled left column) for the
 * sidebar collapse/expand toggle — drawn with `currentColor` so the
 * surrounding button controls the hue. Unlike a directional arrow, this
 * icon does not flip: the same "layout" silhouette reads as "toggle the
 * side panel" regardless of whether the sidebar is currently expanded or
 * collapsed (state is conveyed via `aria-expanded` + the button's
 * title/aria-label, not the glyph itself).
 */
export function SidebarToggleIcon(): ReactElement {
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
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 3v10" stroke="currentColor" strokeWidth="1.3" />
      <rect x="3" y="4" width="2.3" height="8" rx="0.5" fill="currentColor" />
    </svg>
  );
}
