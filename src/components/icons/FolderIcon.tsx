import type { ReactElement } from "react";

/**
 * Folder icon for directory rows in the SFTP file manager — drawn with
 * `currentColor` so the surrounding element controls the hue. Inline SVG keeps
 * it dependency-free and matches the shared icon convention.
 */
export function FolderIcon(): ReactElement {
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
        d="M1.5 4a1 1 0 0 1 1-1h3l1.5 1.5h6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
