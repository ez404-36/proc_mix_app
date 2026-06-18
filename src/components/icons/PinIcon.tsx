import type { ReactElement } from "react";

/**
 * Pin icon: a push-pin, used to mark a console run as pinned (kept through
 * "Clear" and across restarts). Drawn with `currentColor` so the surrounding
 * control sets the hue. 16×16, decorative (`aria-hidden`).
 */
export function PinIcon(): ReactElement {
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
        d="M9.5 1.5 14.5 6.5l-2.1.5-2.6 2.6.4 2.7L8 11 5 14l-.7-.7 3-3-1.6-2.2.5-.5L8.6 3.6 9.5 1.5Z"
        fill="currentColor"
      />
    </svg>
  );
}
