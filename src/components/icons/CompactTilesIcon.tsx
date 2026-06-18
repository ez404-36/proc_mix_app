import type { ReactElement } from "react";

/**
 * Compact-tiles view icon: a denser 2-column grid of small rounded squares
 * (more rows than {@link TilesViewIcon}) signalling the smaller-card layout.
 * Drawn with `currentColor` so the surrounding button controls the hue.
 */
export function CompactTilesIcon(): ReactElement {
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
      <rect x="2" y="2" width="5" height="3" rx="0.8" fill="currentColor" />
      <rect x="9" y="2" width="5" height="3" rx="0.8" fill="currentColor" />
      <rect x="2" y="6.5" width="5" height="3" rx="0.8" fill="currentColor" />
      <rect x="9" y="6.5" width="5" height="3" rx="0.8" fill="currentColor" />
      <rect x="2" y="11" width="5" height="3" rx="0.8" fill="currentColor" />
      <rect x="9" y="11" width="5" height="3" rx="0.8" fill="currentColor" />
    </svg>
  );
}
