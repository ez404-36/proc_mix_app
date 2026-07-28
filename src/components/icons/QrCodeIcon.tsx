import type { ReactElement } from "react";

/**
 * QR-code glyph for the "Show QR" toggle in the HTTP API panel — three corner
 * finder squares plus a scattering of data-module dots, drawn with
 * `currentColor` so the surrounding button controls the hue. Inline SVG keeps
 * it dependency-free and matches the shared icon convention (16×16,
 * `currentColor`, `aria-hidden`).
 */
export function QrCodeIcon(): ReactElement {
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
      <rect x="1.5" y="1.5" width="4.5" height="4.5" rx="0.5" stroke="currentColor" strokeWidth="1.3" />
      <rect x="10" y="1.5" width="4.5" height="4.5" rx="0.5" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1.5" y="10" width="4.5" height="4.5" rx="0.5" stroke="currentColor" strokeWidth="1.3" />
      <rect x="3.25" y="3.25" width="1" height="1" fill="currentColor" />
      <rect x="11.75" y="3.25" width="1" height="1" fill="currentColor" />
      <rect x="3.25" y="11.75" width="1" height="1" fill="currentColor" />
      <rect x="10" y="10" width="1.6" height="1.6" fill="currentColor" />
      <rect x="12.9" y="10" width="1.6" height="1.6" fill="currentColor" />
      <rect x="10" y="12.9" width="1.6" height="1.6" fill="currentColor" />
      <rect x="12.9" y="12.9" width="1.6" height="1.6" fill="currentColor" />
    </svg>
  );
}
