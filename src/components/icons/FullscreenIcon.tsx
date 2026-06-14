import type { ReactElement } from "react";

/**
 * Outward arrows / corner brackets — "fullscreen" (expand the editor to fill
 * the app) control. When `active` is true it shows inward brackets (the
 * "collapse / exit fullscreen" affordance). Drawn with `currentColor`.
 */
export function FullscreenIcon({
  active = false,
}: {
  active?: boolean;
}): ReactElement {
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
        d={
          active
            ? "M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4"
            : "M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"
        }
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
