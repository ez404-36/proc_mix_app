import type { ReactElement } from "react";

/**
 * Three-modules-plus-one glyph for the Plugins nav item — drawn with
 * `currentColor` so the surrounding sidebar button controls the hue. Three
 * equal-size squares fill the top-left, bottom-left, and bottom-right
 * corners (the "core" module group, an L-shape); a fourth square — the SAME
 * size as the other three — sits detached in the top-right corner with a
 * visible gap, reading as a plug-in/extension module being
 * attached/detached from the group. Matches the pre-migration Unicode
 * glyph's composition even though the plugin system itself is
 * scaffolding-only (see `docs/ideas/plugin-system.md`). Replaces the legacy
 * `⧉` Unicode glyph (see docs/ui-conventions.md Navigation section).
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
      <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="10" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
