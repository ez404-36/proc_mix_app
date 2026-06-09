/**
 * Pure script-highlighting tokenizer shared by {@link ScriptEditor} and its
 * unit tests. Kept in a non-component module so the editor file can export a
 * single component (Fast Refresh requirement).
 */

import type { ParsedFlag } from "../../types";

/** Regex used to split the script into "plain" and "reference"
 *  segments for highlighting. Mirrors the parser's grammar but is
 *  intentionally permissive: it matches `${...}` regardless of
 *  inner-name validity so that the user sees a malformed reference
 *  highlighted (and styled as "unknown"). The capture groups are
 *  used to extract the name part for unknown-name detection. */
const HIGHLIGHT_RE = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g;

/**
 * Highlight status of the leading utility token, mirroring the resolved
 * `useUtilityHelp` state:
 *   - "pending"   — lookup not yet resolved; render WITHOUT colour so the
 *     token doesn't flash green/red before the answer arrives.
 *   - "found"     — utility recognised; render in the "found" colour.
 *   - "not-found" — utility unknown; render in the danger colour.
 */
export type UtilityHighlightStatus = "pending" | "found" | "not-found";

export interface HighlightSegment {
  kind: "text" | "known" | "unknown" | "escape" | "utility" | "flag";
  text: string;
  /** Only set on `kind: "utility"` segments. */
  utilityStatus?: UtilityHighlightStatus;
  /** Only set on `kind: \"flag\"` segments. */
  parsedFlag?: ParsedFlag;
  /** Only set on `kind: \"flag\"` segments. */
  flagStatus?: "found" | "not-found";
}

/**
 * The leading-utility token to carve out and tag, in absolute offsets
 * into `script`. Supplied by the caller from `parseUtilityNameWithRange`.
 */
export interface UtilityHighlight {
  start: number;
  end: number;
  status: UtilityHighlightStatus;
}

/**
 * A flag token range within the script string. Produced by
 * {@link buildFlagHighlights} and consumed by `applyFlagHighlights`.
 */
export interface FlagHighlight {
  /** Byte offset of the flag token start (inclusive). */
  start: number;
  /** Byte offset of the flag token end (exclusive). */
  end: number;
  /**
   * - `"found"`     — token matched a known flag alias → green highlight.
   * - `"not-found"` — token starts with `-` but matched nothing → red highlight.
   */
  flagStatus: "found" | "not-found";
  /** The resolved ParsedFlag when `flagStatus === "found"`. */
  flag: ParsedFlag | null;
}

// ---------------------------------------------------------------------------
// Flag highlight builder
// ---------------------------------------------------------------------------

/** Characters that terminate a whitespace-delimited token. */
const WORD_TERMINATORS = new Set([" ", "\t", "\n", "\r", ";", "&", "|", ">"]);

/**
 * Split `script` into whitespace-delimited tokens, returning each token's
 * text and its byte start offset.
 */
function scriptTokens(script: string): Array<{ text: string; start: number }> {
  const tokens: Array<{ text: string; start: number }> = [];
  let i = 0;
  const n = script.length;
  while (i < n) {
    while (i < n && WORD_TERMINATORS.has(script[i]!)) i += 1;
    if (i >= n) break;
    const start = i;
    while (i < n && !WORD_TERMINATORS.has(script[i]!)) i += 1;
    tokens.push({ text: script.slice(start, i), start });
  }
  return tokens;
}

/**
 * Build a sorted, non-overlapping list of {@link FlagHighlight} ranges for
 * all flag tokens found in `script`.
 *
 * Rules:
 * - The first non-escalation token (the utility name) is always skipped.
 * - Tokens starting with `-` are tested against every alias of every flag.
 * - Combined short flags (`-czf`) are matched as a single token associated
 *   with the first short alias found in the group.
 * - Value tokens following a value-taking flag are left as plain text.
 */
export function buildFlagHighlights(
  script: string,
  flags: ReadonlyArray<ParsedFlag>,
): FlagHighlight[] {
  if (flags.length === 0) return [];

  const byAlias = new Map<string, ParsedFlag>();
  for (const flag of flags) {
    for (const alias of flag.flags) {
      byAlias.set(alias, flag);
    }
  }

  const tokens = scriptTokens(script);
  if (tokens.length === 0) return [];

  const ESCALATION = new Set(["sudo", "doas", "pkexec"]);
  let skipCount = 1;
  if (tokens.length > 0 && ESCALATION.has(tokens[0]!.text)) {
    skipCount = 2;
  }

  const highlights: FlagHighlight[] = [];
  let i = skipCount;

  while (i < tokens.length) {
    const { text, start } = tokens[i]!;
    i += 1;

    if (!text.startsWith("-")) continue;

    // Direct match: `-v`, `--verbose`, `--output=value` (strip `=...` suffix).
    const eqIdx = text.indexOf("=");
    const bareToken = eqIdx !== -1 ? text.slice(0, eqIdx) : text;
    const direct = byAlias.get(bareToken);
    if (direct !== undefined) {
      highlights.push({ start, end: start + text.length, flagStatus: "found", flag: direct });
      if (
        direct.takesValue &&
        eqIdx === -1 &&
        i < tokens.length &&
        !tokens[i]!.text.startsWith("-")
      ) {
        i += 1;
      }
      continue;
    }

    // Combined short flags: `-hP`, `-czf` — not `--` prefix, length > 2.
    // Emit one FlagHighlight per character so each char gets its own span,
    // its own tooltip, and its own found/not-found colour.
    if (!text.startsWith("--") && text.length > 2) {
      const chars = text.slice(1);
      let anyMatched = false;
      for (let ci = 0; ci < chars.length; ci++) {
        const ch = chars[ci]!;
        // Char offset: skip the leading `-` (offset 1) then the char index.
        const charStart = start + 1 + ci;
        const matched = byAlias.get(`-${ch}`);
        if (matched !== undefined) {
          anyMatched = true;
          highlights.push({ start: charStart, end: charStart + 1, flagStatus: "found", flag: matched });
          // If the last char's flag takes a value, consume the next token.
          if (
            ci === chars.length - 1 &&
            matched.takesValue &&
            i < tokens.length &&
            !tokens[i]!.text.startsWith("-")
          ) {
            i += 1;
          }
        } else {
          // Unknown char inside a combined group — still highlight as not-found.
          highlights.push({ start: charStart, end: charStart + 1, flagStatus: "not-found", flag: null });
          anyMatched = true;
        }
      }
      if (anyMatched) continue;
    }

    // Unrecognised flag token — highlight as not-found.
    highlights.push({ start, end: start + text.length, flagStatus: "not-found", flag: null });
  }

  highlights.sort((a, b) => a.start - b.start);
  return highlights;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Tokenize the script into highlight segments. Pure function — easy
 * to unit-test. The `knownNames` set determines whether a reference
 * is highlighted as "known" (declared) or "unknown" (likely typo).
 *
 * When `utility` is provided, the `[start, end)` slice of the script is
 * emitted as a dedicated `kind: "utility"` segment carrying its status.
 *
 * When `flagHighlights` is provided, each matched flag range is carved out
 * of the nearest plain-text segment and emitted as a `kind: "flag"` segment
 * carrying the associated {@link ParsedFlag}.
 */
export function tokenizeScript(
  script: string,
  knownNames: ReadonlySet<string>,
  utility?: UtilityHighlight | null,
  flagHighlights?: ReadonlyArray<FlagHighlight>,
): HighlightSegment[] {
  const base = tokenizeReferences(script, knownNames);

  let result = base;
  if (utility && utility.end > utility.start) {
    result = applyUtilityHighlight(result, script, utility);
  }
  if (flagHighlights && flagHighlights.length > 0) {
    result = applyFlagHighlights(result, flagHighlights);
  }
  return result;
}

/** Variable/escape segmentation (the original behaviour). */
function tokenizeReferences(
  script: string,
  knownNames: ReadonlySet<string>,
): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  let lastIndex = 0;
  HIGHLIGHT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HIGHLIGHT_RE.exec(script)) !== null) {
    const fullMatch = match[0];
    const start = match.index;
    if (start > lastIndex) {
      segments.push({ kind: "text", text: script.slice(lastIndex, start) });
    }
    if (fullMatch === "$$") {
      segments.push({ kind: "escape", text: "$$" });
    } else {
      const name = match[1];
      if (name === undefined) {
        segments.push({ kind: "text", text: fullMatch });
      } else {
        segments.push({
          kind: knownNames.has(name) ? "known" : "unknown",
          text: fullMatch,
        });
      }
    }
    lastIndex = HIGHLIGHT_RE.lastIndex;
  }
  if (lastIndex < script.length) {
    segments.push({ kind: "text", text: script.slice(lastIndex) });
  }
  return segments;
}

/**
 * Carve the utility range out of whichever PLAIN-text segment contains it.
 */
function applyUtilityHighlight(
  base: HighlightSegment[],
  script: string,
  utility: UtilityHighlight,
): HighlightSegment[] {
  const out: HighlightSegment[] = [];
  let cursor = 0;
  let placed = false;

  for (const seg of base) {
    const segStart = cursor;
    const segEnd = cursor + seg.text.length;
    cursor = segEnd;

    const fullyInsideText =
      !placed &&
      seg.kind === "text" &&
      utility.start >= segStart &&
      utility.end <= segEnd;

    if (!fullyInsideText) {
      out.push(seg);
      continue;
    }

    const relStart = utility.start - segStart;
    const relEnd = utility.end - segStart;
    const before = seg.text.slice(0, relStart);
    const mid = seg.text.slice(relStart, relEnd);
    const after = seg.text.slice(relEnd);

    if (before.length > 0) out.push({ kind: "text", text: before });
    out.push({ kind: "utility", text: mid, utilityStatus: utility.status });
    if (after.length > 0) out.push({ kind: "text", text: after });
    placed = true;
  }

  void script;
  return placed ? out : base;
}

/**
 * Carve flag ranges out of plain-text segments in a single left-to-right pass.
 * Non-text segments (utility, variable, escape) are passed through unchanged.
 */
function applyFlagHighlights(
  base: HighlightSegment[],
  flagHighlights: ReadonlyArray<FlagHighlight>,
): HighlightSegment[] {
  if (flagHighlights.length === 0) return base;

  let cursor = 0;
  let flagIdx = 0;
  const out: HighlightSegment[] = [];

  for (const seg of base) {
    const segStart = cursor;
    const segEnd = cursor + seg.text.length;
    cursor = segEnd;

    if (seg.kind !== "text") {
      out.push(seg);
      continue;
    }

    let localText = seg.text;
    let localOffset = segStart;

    while (
      flagIdx < flagHighlights.length &&
      flagHighlights[flagIdx]!.start >= segStart &&
      flagHighlights[flagIdx]!.start < segEnd
    ) {
      const fh = flagHighlights[flagIdx]!;
      flagIdx += 1;

      const fEnd = Math.min(fh.end, segEnd);
      const relStart = fh.start - localOffset;
      const relEnd = fEnd - localOffset;

      if (relStart < 0 || relEnd > localText.length || relStart >= relEnd) {
        continue;
      }

      const before = localText.slice(0, relStart);
      const mid = localText.slice(relStart, relEnd);
      const after = localText.slice(relEnd);

      if (before.length > 0) out.push({ kind: "text", text: before });
      out.push({ kind: "flag", text: mid, parsedFlag: fh.flag ?? undefined, flagStatus: fh.flagStatus });

      localText = after;
      localOffset = localOffset + relEnd;
    }

    if (localText.length > 0) out.push({ kind: "text", text: localText });
  }

  return out;
}
