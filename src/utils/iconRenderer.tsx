import type { ReactElement } from "react";

/**
 * Render a mini-app icon value identically in every place it appears (list
 * card, runner header, IconPicker preview):
 *
 * - `undefined` / empty → `null` (no icon).
 * - a base64 data URI (`data:...`, from an uploaded SVG/PNG) → an `<img>`.
 * - any other string → the literal character (an emoji / glyph) in a `<span>`.
 *
 * The wire format is plain `MiniApp.icon: Option<String>` (no schema change):
 * emoji characters and `data:` URIs share the field, and this helper is the
 * single switch on `startsWith("data:")` that separates them.
 *
 * `size` (px) drives both the `<img>` width/height and the emoji font-size, so
 * the same icon renders at the same nominal footprint everywhere it is asked
 * for. `className` is forwarded so each call site can hook its own spacing.
 */
export function renderIcon(
  icon: string | undefined,
  size = 20,
  className?: string,
): ReactElement | null {
  if (icon === undefined || icon === "") return null;
  if (icon.startsWith("data:")) {
    return (
      <img
        src={icon}
        alt=""
        width={size}
        height={size}
        className={className}
        style={{ objectFit: "contain" }}
      />
    );
  }
  return (
    <span className={className} style={{ fontSize: `${size}px`, lineHeight: 1 }}>
      {icon}
    </span>
  );
}
