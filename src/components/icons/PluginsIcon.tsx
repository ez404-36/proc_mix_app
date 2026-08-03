import type { ReactElement } from "react";

/**
 * Rounded module/block glyph for the Plugins nav item — drawn with
 * `currentColor` so the surrounding sidebar button controls the hue. Kept
 * intentionally simple (no puzzle-piece notches) since the plugin system
 * itself is scaffolding-only (see `docs/ideas/plugin-system.md`). Replaces
 * the legacy `⧉` Unicode glyph (see docs/ui-conventions.md Navigation
 * section).
 */
export function PluginsIcon(): ReactElement {
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
      <rect x="3" y="3" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="8" r="1.8" fill="currentColor" />
    </svg>
  );
}
