/**
 * Pure script-highlighting tokenizer shared by {@link ScriptEditor} and its
 * unit tests. Kept in a non-component module so the editor file can export a
 * single component (Fast Refresh requirement).
 */

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
  kind: "text" | "known" | "unknown" | "escape" | "utility";
  text: string;
  /** Only set on `kind: "utility"` segments. */
  utilityStatus?: UtilityHighlightStatus;
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
 * Tokenize the script into highlight segments. Pure function — easy
 * to unit-test. The `knownNames` set determines whether a reference
 * is highlighted as "known" (declared) or "unknown" (likely typo).
 *
 * When `utility` is provided, the `[start, end)` slice of the script is
 * emitted as a dedicated `kind: "utility"` segment carrying its status,
 * so the editor can colour the leading command and attach a hover
 * target to it. The utility range is assumed to sit within plain text
 * (a leading command token never overlaps a `${...}` reference); if it
 * somehow intersects a reference the variable segmentation wins and the
 * utility carve-out for that span is skipped.
 */
export function tokenizeScript(
  script: string,
  knownNames: ReadonlySet<string>,
  utility?: UtilityHighlight | null,
): HighlightSegment[] {
  const base = tokenizeReferences(script, knownNames);
  if (!utility || utility.end <= utility.start) return base;
  return applyUtilityHighlight(base, script, utility);
}

/** Variable/escape segmentation (the original behaviour). */
function tokenizeReferences(
  script: string,
  knownNames: ReadonlySet<string>,
): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  let lastIndex = 0;
  // Regexes with /g state must be reset before each scan to avoid
  // sticky state leaking from a previous call.
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
      // `name` is captured by the regex group and guaranteed present
      // for the `${...}` branch, but TS's regex type doesn't know
      // that. Defensive guard: treat as text if missing.
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
 * Carve the utility range out of whichever PLAIN-text segment contains
 * it, splitting that segment into up-to-three parts (before / utility /
 * after). Non-text segments (variable refs, escapes) are passed through
 * untouched — the utility token never legitimately overlaps one.
 */
function applyUtilityHighlight(
  base: HighlightSegment[],
  script: string,
  utility: UtilityHighlight,
): HighlightSegment[] {
  const out: HighlightSegment[] = [];
  let cursor = 0; // absolute offset of the current segment's start
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

  // If the range didn't land inside any text segment (shouldn't happen
  // for a valid range), fall back to the un-annotated segments so the
  // editor still renders correctly.
  void script;
  return placed ? out : base;
}
