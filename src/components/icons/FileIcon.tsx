import type { ReactElement } from "react";

/**
 * File icon for file rows in the SFTP file manager — drawn with `currentColor`
 * so the surrounding element controls the hue. Inline SVG keeps it
 * dependency-free and matches the shared icon convention.
 */
export function FileIcon(): ReactElement {
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
        d="M4 1.5h5L12.5 5v9.5a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M9 1.5V5h3.5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}
