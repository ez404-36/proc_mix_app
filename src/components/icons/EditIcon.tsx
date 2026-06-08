import type { ReactElement } from "react";

/**
 * Pencil icon for "Edit" buttons — drawn with `currentColor` so the
 * surrounding button controls the hue. Shared by the WorkflowView footer and
 * the outlined Edit button on workflow list cards. Inline SVG keeps it
 * dependency-free and matches the CommandForm action-icon convention.
 */
export function EditIcon(): ReactElement {
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
        d="M11.5 2.5l2 2-7.5 7.5-2.6.6.6-2.6 7.5-7.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M10.5 3.5l2 2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
