import type { ReactElement } from "react";

/**
 * Boxed-cross glyph for the Env (environment variables) nav item — drawn
 * with `currentColor` so the surrounding sidebar button controls the hue.
 * Replaces the legacy `⊞` Unicode glyph (see docs/ui-conventions.md
 * Navigation section).
 */
export function EnvIcon(): ReactElement {
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
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 4.5v7M4.5 8h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
