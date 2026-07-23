/**
 * Parses ANSI SGR (Select Graphic Rendition) escape codes out of a single
 * log line into styled segments, so the Output Panel / inline run output /
 * scheduled-run history can render color/bold/italic/etc. instead of
 * showing the raw escape bytes.
 *
 * Only SGR (`ESC[...m`) is interpreted — the log surfaces render one line
 * at a time as flat text, not a terminal grid, so any other CSI sequence
 * (cursor movement, screen clear, bracketed-paste markers, OSC, …) has no
 * meaningful effect here and is stripped silently rather than shown as
 * garbage characters. Full terminal emulation (cursor addressing, screen
 * buffer, etc.) belongs to the separate Interactive Terminal feature,
 * which uses a real PTY + xterm.js — see docs/interactive-terminal.md.
 */

/** A resolved SGR color: either one of the 16 base ANSI slots (rendered via
 *  themed `--ansi-N` CSS custom properties) or a literal RGB value carried
 *  by a 256-color / truecolor SGR code. The RGB case is genuine dynamic
 *  data from the process output, not an app UI color, so it is applied as
 *  a computed `rgb(...)` value rather than a token. */
export type AnsiColor =
  | { kind: "base"; index: number }
  | { kind: "rgb"; r: number; g: number; b: number };

export interface AnsiStyle {
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
  fg?: AnsiColor;
  bg?: AnsiColor;
}

export interface AnsiSegment extends AnsiStyle {
  text: string;
}

// Matches any CSI sequence: ESC [ <params> <final-byte>. `params` may
// contain digits, `;` and `:` (the latter appears in some extended SGR
// encodings, e.g. `38:2::255:0:0`, which we treat the same as `;`).
// Matching the literal ESC (0x1b) control character IS the point of a
// CSI-sequence pattern.
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /\x1b\[([0-9;:]*)([A-Za-z])/g;

const BASE_COLOR_COUNT = 16;

function styleEquals(a: AnsiStyle, b: AnsiStyle): boolean {
  return (
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strikethrough === !!b.strikethrough &&
    !!a.inverse === !!b.inverse &&
    colorEquals(a.fg, b.fg) &&
    colorEquals(a.bg, b.bg)
  );
}

function colorEquals(a: AnsiColor | undefined, b: AnsiColor | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "base" && b.kind === "base") return a.index === b.index;
  if (a.kind === "rgb" && b.kind === "rgb") {
    return a.r === b.r && a.g === b.g && a.b === b.b;
  }
  return false;
}

/** Converts an xterm 256-color palette index (0-255) to RGB.
 *  0-15   → the 16 base colors (returned as a `base` color, not RGB).
 *  16-231 → a 6x6x6 color cube.
 *  232-255 → a 24-step grayscale ramp. */
function color256ToRgb(index: number): { r: number; g: number; b: number } {
  if (index < 16) {
    // Callers only reach this branch defensively; the cube/grayscale
    // formulas below are only valid for 16-255.
    return { r: 0, g: 0, b: 0 };
  }
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return { r: level, g: level, b: level };
  }
  const cubeIndex = index - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  const r = steps[Math.floor(cubeIndex / 36) % 6] ?? 0;
  const g = steps[Math.floor(cubeIndex / 6) % 6] ?? 0;
  const b = steps[cubeIndex % 6] ?? 0;
  return { r, g, b };
}

function resolvePaletteColor(index: number): AnsiColor {
  if (index >= 0 && index < BASE_COLOR_COUNT) {
    return { kind: "base", index };
  }
  return { kind: "rgb", ...color256ToRgb(index) };
}

/**
 * Applies one SGR parameter list (already split on `;`/`:`) to a running
 * style, consuming multi-part codes (`38;5;n`, `38;2;r;g;b`, …) as they're
 * encountered. Mutates and returns `style`.
 */
function applySgrParams(params: number[], style: AnsiStyle): AnsiStyle {
  let i = 0;
  while (i < params.length) {
    const code = params[i];
    switch (code) {
      case 0:
        style = {};
        break;
      case 1:
        style.bold = true;
        break;
      case 2:
        style.dim = true;
        break;
      case 3:
        style.italic = true;
        break;
      case 4:
        style.underline = true;
        break;
      case 7:
        style.inverse = true;
        break;
      case 9:
        style.strikethrough = true;
        break;
      case 22:
        style.bold = false;
        style.dim = false;
        break;
      case 23:
        style.italic = false;
        break;
      case 24:
        style.underline = false;
        break;
      case 27:
        style.inverse = false;
        break;
      case 29:
        style.strikethrough = false;
        break;
      case 39:
        style.fg = undefined;
        break;
      case 49:
        style.bg = undefined;
        break;
      default:
        if (code === undefined) break;
        if (code >= 30 && code <= 37) {
          style.fg = { kind: "base", index: code - 30 };
        } else if (code >= 90 && code <= 97) {
          style.fg = { kind: "base", index: code - 90 + 8 };
        } else if (code >= 40 && code <= 47) {
          style.bg = { kind: "base", index: code - 40 };
        } else if (code >= 100 && code <= 107) {
          style.bg = { kind: "base", index: code - 100 + 8 };
        } else if (code === 38 || code === 48) {
          // Extended color: `38;5;<n>` (256-color) or `38;2;<r>;<g>;<b>`
          // (truecolor). Consume the extra params that belong to this code.
          const mode = params[i + 1];
          if (mode === 5) {
            const paletteIndex = params[i + 2];
            if (paletteIndex !== undefined) {
              const color = resolvePaletteColor(paletteIndex);
              if (code === 38) style.fg = color;
              else style.bg = color;
            }
            i += 2;
          } else if (mode === 2) {
            const r = params[i + 2] ?? 0;
            const g = params[i + 3] ?? 0;
            const b = params[i + 4] ?? 0;
            const color: AnsiColor = { kind: "rgb", r, g, b };
            if (code === 38) style.fg = color;
            else style.bg = color;
            i += 4;
          }
        }
        break;
    }
    i += 1;
  }
  return style;
}

/**
 * Tokenizes a single log line into styled segments, applying SGR codes
 * left-to-right the way a real terminal would. Lines with no escape codes
 * return a single unstyled segment holding the whole string, so callers can
 * treat every line uniformly.
 */
export function parseAnsiLine(line: string): AnsiSegment[] {
  if (!line.includes("\x1b")) {
    return [{ text: line }];
  }

  const segments: AnsiSegment[] = [];
  let style: AnsiStyle = {};
  let lastIndex = 0;

  const pushText = (text: string): void => {
    if (text.length === 0) return;
    const last = segments[segments.length - 1];
    if (last && styleEquals(last, style)) {
      last.text += text;
      return;
    }
    segments.push({ text, ...style });
  };

  for (const match of line.matchAll(CSI_PATTERN)) {
    const [full, rawParams, finalByte] = match;
    const start = match.index ?? 0;
    pushText(line.slice(lastIndex, start));
    lastIndex = start + full.length;

    if (finalByte === "m") {
      const params = rawParams
        .split(/[;:]/)
        .map((p) => (p === "" ? 0 : Number.parseInt(p, 10)))
        .filter((n) => !Number.isNaN(n));
      style = applySgrParams(params.length > 0 ? params : [0], { ...style });
    }
    // Any other final byte (cursor movement, erase, etc.) is dropped —
    // it carries no text and has no meaning in a flat line-log render.
  }
  pushText(line.slice(lastIndex));

  return segments.length > 0 ? segments : [{ text: "" }];
}
