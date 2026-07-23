import { describe, expect, it } from "vitest";
import { parseAnsiLine } from "./ansiParser";

const ESC = "\x1b";

describe("parseAnsiLine", () => {
  it("returns a single plain segment for a line with no escape codes", () => {
    expect(parseAnsiLine("hello world")).toEqual([{ text: "hello world" }]);
  });

  it("returns an empty-text segment for an empty line", () => {
    expect(parseAnsiLine("")).toEqual([{ text: "" }]);
  });

  it("parses the hadolint DL3008-style warning line into a bold bright-yellow segment", () => {
    const line = `${ESC}[1m${ESC}[93mwarning${ESC}[0m: message`;
    const segments = parseAnsiLine(line);
    expect(segments).toEqual([
      { text: "warning", bold: true, fg: { kind: "base", index: 11 } },
      { text: ": message" },
    ]);
  });

  it("applies bold (1) and a base foreground color (30-37)", () => {
    const line = `${ESC}[1;31mred bold${ESC}[0m`;
    expect(parseAnsiLine(line)).toEqual([
      { text: "red bold", bold: true, fg: { kind: "base", index: 1 } },
    ]);
  });

  it("applies bright foreground colors (90-97) at bright indices (8-15)", () => {
    const line = `${ESC}[96mbright cyan${ESC}[0m`;
    expect(parseAnsiLine(line)).toEqual([
      { text: "bright cyan", fg: { kind: "base", index: 14 } },
    ]);
  });

  it("applies background colors (40-47)", () => {
    const line = `${ESC}[42mgreen bg${ESC}[0m`;
    expect(parseAnsiLine(line)).toEqual([
      { text: "green bg", bg: { kind: "base", index: 2 } },
    ]);
  });

  it("resets all attributes on code 0", () => {
    const line = `${ESC}[1;4;31mstyled${ESC}[0mplain`;
    expect(parseAnsiLine(line)).toEqual([
      { text: "styled", bold: true, underline: true, fg: { kind: "base", index: 1 } },
      { text: "plain" },
    ]);
  });

  it("39/49 reset only the foreground/background, keeping other attributes", () => {
    const line = `${ESC}[1;31mred${ESC}[39mno-color-still-bold`;
    expect(parseAnsiLine(line)).toEqual([
      { text: "red", bold: true, fg: { kind: "base", index: 1 } },
      { text: "no-color-still-bold", bold: true },
    ]);
  });

  it("resolves an 8-bit palette index >= 16 to RGB (256-color, 38;5;n)", () => {
    // Index 196 is pure red in the 6x6x6 cube (cubeIndex 180 → r=5,g=0,b=0 step).
    const line = `${ESC}[38;5;196mpalette red${ESC}[0m`;
    expect(parseAnsiLine(line)).toEqual([
      { text: "palette red", fg: { kind: "rgb", r: 255, g: 0, b: 0 } },
    ]);
  });

  it("resolves an 8-bit palette index < 16 to the base color (not RGB)", () => {
    const line = `${ESC}[38;5;9mbright red via palette${ESC}[0m`;
    expect(parseAnsiLine(line)).toEqual([
      { text: "bright red via palette", fg: { kind: "base", index: 9 } },
    ]);
  });

  it("resolves a grayscale palette index (232-255)", () => {
    const line = `${ESC}[38;5;232mnear black${ESC}[0m`;
    expect(parseAnsiLine(line)).toEqual([
      { text: "near black", fg: { kind: "rgb", r: 8, g: 8, b: 8 } },
    ]);
  });

  it("applies truecolor foreground (38;2;r;g;b)", () => {
    const line = `${ESC}[38;2;255;128;0mtruecolor orange${ESC}[0m`;
    expect(parseAnsiLine(line)).toEqual([
      { text: "truecolor orange", fg: { kind: "rgb", r: 255, g: 128, b: 0 } },
    ]);
  });

  it("applies truecolor background (48;2;r;g;b)", () => {
    const line = `${ESC}[48;2;10;20;30mbg${ESC}[0m`;
    expect(parseAnsiLine(line)).toEqual([
      { text: "bg", bg: { kind: "rgb", r: 10, g: 20, b: 30 } },
    ]);
  });

  it("merges adjacent segments that end up with identical styles", () => {
    const line = `${ESC}[1mbold${ESC}[1mstill bold`;
    expect(parseAnsiLine(line)).toEqual([{ text: "boldstill bold", bold: true }]);
  });

  it("strips non-SGR CSI sequences (cursor movement, erase) without emitting text for them", () => {
    // `\x1b[2K` clears the line, `\x1b[1A` moves the cursor up — neither
    // carries text nor SGR state; both must vanish from the rendered output.
    const line = `progress${ESC}[2K${ESC}[1A${ESC}[31mfailed${ESC}[0m`;
    expect(parseAnsiLine(line)).toEqual([
      { text: "progress" },
      { text: "failed", fg: { kind: "base", index: 1 } },
    ]);
  });

  it("treats an unterminated/truncated escape sequence at the end of the line as literal trailing text", () => {
    // The dangling `ESC[3` never matches a full CSI sequence, so it is not
    // consumed as a code — it falls through as ordinary text, still under
    // whatever style was active (no implicit reset), and merges into the
    // preceding same-style segment.
    const line = `${ESC}[31mred${ESC}[3`;
    expect(parseAnsiLine(line)).toEqual([
      { text: `red${ESC}[3`, fg: { kind: "base", index: 1 } },
    ]);
  });

  it("treats an empty SGR parameter list (bare ESC[m) as a reset", () => {
    const line = `${ESC}[1mbold${ESC}[mplain`;
    expect(parseAnsiLine(line)).toEqual([
      { text: "bold", bold: true },
      { text: "plain" },
    ]);
  });
});
