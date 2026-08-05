import type { ReactElement } from "react";

/**
 * Classic gear/cog glyph for the Settings nav item — drawn with
 * `currentColor` so the surrounding sidebar button controls the hue. A
 * single filled outline path: eight rounded trapezoidal teeth around a
 * body ring, with a circular hole cut out of the center via
 * `fill-rule: evenodd`. This is the universally recognized gear silhouette
 * (cf. Material Design `settings`, iOS HIG `gearshape`) rather than an
 * assembly of geometric primitives — those read as a star/sun burst or a
 * sparkle at 16px instead of a gear. The path itself is authored on a 20×20
 * coordinate grid (its bounding box is ~[1,19]×[1,19]), so `viewBox` is
 * `0 0 20 20` even though the rendered box stays 16×16 via `width`/`height`
 * — using a 16×16 viewBox here clipped/oversized the gear instead of
 * scaling it down. Replaces the legacy `⚙` Unicode glyph (see
 * docs/ui-conventions.md Navigation section).
 */
export function SettingsIcon(): ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8.34 1.804A1 1 0 0 1 9.32 1h1.36a1 1 0 0 1 .98.804l.295 1.473c.497.144.971.342 1.416.588l1.25-.833a1 1 0 0 1 1.262.125l.962.962a1 1 0 0 1 .125 1.262l-.833 1.25c.246.445.444.919.588 1.416l1.473.294a1 1 0 0 1 .804.98v1.361a1 1 0 0 1-.804.98l-1.473.295a6.95 6.95 0 0 1-.588 1.416l.833 1.25a1 1 0 0 1-.125 1.262l-.962.962a1 1 0 0 1-1.262.125l-1.25-.833a6.953 6.953 0 0 1-1.416.588l-.294 1.473a1 1 0 0 1-.98.804H9.32a1 1 0 0 1-.98-.804l-.295-1.473a6.957 6.957 0 0 1-1.416-.588l-1.25.833a1 1 0 0 1-1.262-.125l-.962-.962a1 1 0 0 1-.125-1.262l.833-1.25a6.957 6.957 0 0 1-.588-1.416l-1.473-.294A1 1 0 0 1 1 10.68V9.32a1 1 0 0 1 .804-.98l1.473-.295c.144-.497.342-.971.588-1.416l-.833-1.25a1 1 0 0 1 .125-1.262l.962-.962A1 1 0 0 1 5.38 3.03l1.25.833a6.957 6.957 0 0 1 1.416-.588l.294-1.473ZM13 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
        fill="currentColor"
      />
    </svg>
  );
}
