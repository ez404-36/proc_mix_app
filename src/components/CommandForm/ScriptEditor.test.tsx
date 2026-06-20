import { describe, expect, it } from "vitest";
import { tokenizeScript } from "./scriptHighlight";

/**
 * Unit tests for the pure `tokenizeScript` helper. Behavioural
 * tests for the full editor (overlay alignment, scroll sync,
 * context menu) require a real layout engine and live in the
 * CommandForm test suite or future E2E.
 */
describe("tokenizeScript", () => {
  const known = new Set<string>(["who", "env"]);
  const noKnown = new Set<string>();

  it("returns a single text segment when the script has no references", () => {
    const segs = tokenizeScript("echo hello", known);
    expect(segs).toEqual([{ kind: "text", text: "echo hello" }]);
  });

  it("classifies a known ${name} reference as 'known'", () => {
    const segs = tokenizeScript("hi ${who}", known);
    expect(segs).toEqual([
      { kind: "text", text: "hi " },
      { kind: "known", text: "${who}" },
    ]);
  });

  it("classifies an undeclared reference as 'unknown'", () => {
    const segs = tokenizeScript("echo ${typo}", known);
    expect(segs).toEqual([
      { kind: "text", text: "echo " },
      { kind: "unknown", text: "${typo}" },
    ]);
  });

  it("recognises ${name:default} as a single token", () => {
    const segs = tokenizeScript("deploy ${env:staging}", known);
    expect(segs).toEqual([
      { kind: "text", text: "deploy " },
      { kind: "known", text: "${env:staging}" },
    ]);
  });

  it("handles multiple references in one string", () => {
    const segs = tokenizeScript("${who} loves ${env:staging}", known);
    expect(segs).toEqual([
      { kind: "known", text: "${who}" },
      { kind: "text", text: " loves " },
      { kind: "known", text: "${env:staging}" },
    ]);
  });

  it("classifies $$ as an 'escape' token (preserved literally)", () => {
    const segs = tokenizeScript("price $$5", known);
    expect(segs).toEqual([
      { kind: "text", text: "price " },
      { kind: "escape", text: "$$" },
      { kind: "text", text: "5" },
    ]);
  });

  it("treats an unmatched `${unclosed` as plain text", () => {
    // The regex requires a closing brace; if it never sees one, the
    // whole tail is left as text (no segment is created for the
    // dangling `${`). This matches what the user sees: just plain
    // characters, no highlight.
    const segs = tokenizeScript("foo ${unclosed bar", known);
    expect(segs).toEqual([{ kind: "text", text: "foo ${unclosed bar" }]);
  });

  it("does NOT treat env keys as references (only `${...}` syntax matters)", () => {
    // env-style $FOO references without braces are out of scope —
    // the parser doesn't recognise them either.
    const segs = tokenizeScript("echo $WHO", known);
    expect(segs).toEqual([{ kind: "text", text: "echo $WHO" }]);
  });

  it("returns an empty array for an empty script", () => {
    expect(tokenizeScript("", noKnown)).toEqual([]);
  });

  it("everything is unknown when no names are declared", () => {
    const segs = tokenizeScript("${a} ${b}", noKnown);
    expect(segs).toEqual([
      { kind: "unknown", text: "${a}" },
      { kind: "text", text: " " },
      { kind: "unknown", text: "${b}" },
    ]);
  });

  it("carves out the leading-utility range as a `utility` segment", () => {
    // "df -h" — utility "df" at [0,2).
    const segs = tokenizeScript("df -h", noKnown, [
      { name: "df", start: 0, end: 2, status: "found" },
    ]);
    expect(segs).toEqual([
      { kind: "utility", text: "df", utilityStatus: "found", utilityName: "df" },
      { kind: "text", text: " -h" },
    ]);
  });

  it("splits text before AND after the utility token", () => {
    // Leading whitespace before the utility, args after it.
    const segs = tokenizeScript("  git status", noKnown, [
      { name: "git", start: 2, end: 5, status: "not-found" },
    ]);
    expect(segs).toEqual([
      { kind: "text", text: "  " },
      {
        kind: "utility",
        text: "git",
        utilityStatus: "not-found",
        utilityName: "git",
      },
      { kind: "text", text: " status" },
    ]);
  });

  it("keeps a following ${var} reference intact alongside the utility", () => {
    const segs = tokenizeScript("echo ${who}", known, [
      { name: "echo", start: 0, end: 4, status: "found" },
    ]);
    expect(segs).toEqual([
      {
        kind: "utility",
        text: "echo",
        utilityStatus: "found",
        utilityName: "echo",
      },
      { kind: "text", text: " " },
      { kind: "known", text: "${who}" },
    ]);
  });

  it("carves out EVERY command's utility in a pipe chain", () => {
    // "ls | grep" — "ls" at [0,2), "grep" at [5,9).
    const segs = tokenizeScript("ls | grep", noKnown, [
      { name: "ls", start: 0, end: 2, status: "found" },
      { name: "grep", start: 5, end: 9, status: "found" },
    ]);
    expect(segs).toEqual([
      { kind: "utility", text: "ls", utilityStatus: "found", utilityName: "ls" },
      { kind: "text", text: " | " },
      {
        kind: "utility",
        text: "grep",
        utilityStatus: "found",
        utilityName: "grep",
      },
    ]);
  });

  it("ignores a utility range list that is empty (no highlight)", () => {
    const segs = tokenizeScript("df -h", noKnown, null);
    expect(segs).toEqual([{ kind: "text", text: "df -h" }]);
  });
});
