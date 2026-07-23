// Renders a single log line, interpreting ANSI SGR escape codes (color,
// bold, italic, underline, …) as styled spans instead of showing the raw
// escape bytes. Shared by every plain-text output surface that streams
// piped (non-PTY) child-process output: `OutputPanel` (the "Runs" console),
// the inline command-form `LiveRunOutput`, and the scheduled-run history
// (`ScheduledRunOutput`). See `docs/ui-conventions.md` — its own small
// family (`ansi-text__*`), not a generic class.
//
// Lines with no escape codes render as a single plain span (no visual
// difference from before), so this is a drop-in replacement for `{line}`.

import type { CSSProperties, ReactElement } from "react";
import { parseAnsiLine } from "../../utils/ansiParser";
import type { AnsiColor, AnsiSegment } from "../../utils/ansiParser";

interface AnsiTextProps {
  text: string;
}

function colorValue(color: AnsiColor): string {
  return color.kind === "base"
    ? `var(--ansi-${color.index})`
    : `rgb(${color.r}, ${color.g}, ${color.b})`;
}

function segmentClassName(seg: AnsiSegment): string {
  const parts = ["ansi-text__segment"];
  if (seg.bold) parts.push("ansi-text__segment--bold");
  if (seg.dim) parts.push("ansi-text__segment--dim");
  if (seg.italic) parts.push("ansi-text__segment--italic");
  if (seg.underline) parts.push("ansi-text__segment--underline");
  if (seg.strikethrough) parts.push("ansi-text__segment--strikethrough");
  return parts.join(" ");
}

function segmentStyle(seg: AnsiSegment): CSSProperties | undefined {
  // `inverse` (SGR 7) swaps the effective foreground/background here,
  // rather than via a CSS filter, so it composes correctly with an
  // explicit fg/bg already set on the segment and falls back to the
  // console's own text/background tokens when none was set.
  const fg = seg.inverse ? seg.bg : seg.fg;
  const bg = seg.inverse ? seg.fg : seg.bg;
  const style: CSSProperties = {};
  if (fg) style.color = colorValue(fg);
  else if (seg.inverse) style.color = "var(--console-bg)";
  if (bg) style.backgroundColor = colorValue(bg);
  else if (seg.inverse) style.backgroundColor = "var(--console-text)";
  return Object.keys(style).length > 0 ? style : undefined;
}

export function AnsiText({ text }: AnsiTextProps): ReactElement {
  const segments = parseAnsiLine(text);
  return (
    <>
      {segments.map((seg, i) => (
        <span key={i} className={segmentClassName(seg)} style={segmentStyle(seg)}>
          {seg.text}
        </span>
      ))}
    </>
  );
}
