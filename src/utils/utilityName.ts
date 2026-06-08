// Pure utility-name extractor for the script field's flag-hint feature.
//
// This is the JS twin of `parse_utility_name` in
// `src-tauri/src/core/utility_help.rs`. The two MUST stay in lockstep:
// the frontend only asks the backend about a name this parser accepts,
// so any divergence would either trigger a pointless IPC call (JS
// accepts what Rust rejects) or hide a valid hint (JS rejects what Rust
// would accept). When you change the rules here, change them there too.
//
// The function is pure and platform-agnostic.

/**
 * Inline-escalation tools recognised as a leading prefix. Mirrors
 * `ESCALATION_TOOLS` in `detectAdminEscalation.ts` and the Rust const of
 * the same name. When the first token is one of these we look at the
 * NEXT token for the real utility name (so `sudo apt update` -> `apt`).
 */
const ESCALATION_TOOLS: readonly string[] = ["sudo", "doas", "pkexec"];

/**
 * Shell command separators. We only inspect the FIRST command of a
 * chain, so everything from the first separator onward is discarded
 * before tokenising. Ordered longest-first so `&&`/`||` match before
 * their single-character prefixes (`&`, `|`). Mirrors the Rust
 * `COMMAND_SEPARATORS`.
 */
const COMMAND_SEPARATORS: readonly string[] = ["&&", "||", ";", "|", "&"];

/**
 * The leading utility of a script together with its exact location in
 * the ORIGINAL source string, so callers can highlight the token in
 * place (the script-field overlay) and not just know its name.
 *
 * `start`/`end` are absolute UTF-16 offsets into the string passed to
 * {@link parseUtilityNameWithRange}: `script.slice(start, end) === name`.
 */
export interface UtilityNameRange {
  name: string;
  start: number;
  end: number;
}

/**
 * Like {@link parseUtilityName} but also returns the matched token's
 * absolute `[start, end)` offsets in `script`. Returns `null` under the
 * exact same conditions as {@link parseUtilityName} (no leading line,
 * `${var}` reference, unsafe token, …). The candidate may be a bare
 * utility name OR a safe executable path (see {@link isSafeUtilityToken}).
 *
 * Offsets are tracked through the same pipeline — first executable line,
 * first command segment, env-assignment + escalation prefix stripping —
 * by walking the source instead of `split()`ing it, so the returned
 * range points at the real characters even when leading whitespace,
 * comment lines, or `FOO=bar sudo ` prefixes precede the utility.
 */
/**
 * The leading command of a script, parsed with full shell-prefix
 * awareness, for callers that need to reason about the FIRST real
 * command token (not just the raw first whitespace token).
 *
 * Pipeline (shared with {@link parseUtilityNameWithRange}):
 *   1. First non-empty, non-comment / non-shebang line.
 *   2. First command segment only (cut at the first `&& || ; | &`).
 *   3. Strip leading `NAME=value` env-assignment tokens.
 *   4. Detect an optional single escalation prefix (sudo/doas/pkexec),
 *      then strip any further env-assignments after it.
 *
 * Returns the post-prefix command token (the thing that actually runs,
 * elevated or not) plus whether an escalation prefix preceded it. The
 * `command` token is `undefined` when the segment is empty after
 * stripping (e.g. the script is a bare `sudo` with no following word,
 * or only env-assignments).
 *
 * This is the single source of truth for "what is the leading command",
 * reused by {@link detectAdminEscalation} so the two parsers can never
 * drift on env-prefix / separator handling.
 */
export function parseLeadingCommand(
  script: string,
): { command: string | undefined; escalated: boolean } | null {
  const line = firstExecutableLine(script);
  if (line === null) return null;

  const segmentEnd = firstCommandSegmentEnd(line.text);
  const tokens = tokenizeWithOffsets(
    line.text.slice(0, segmentEnd),
    line.start,
  );

  let index = skipEnvAssignments(tokens, 0);

  let escalated = false;
  const maybePrefix = tokens[index];
  if (maybePrefix !== undefined && ESCALATION_TOOLS.includes(maybePrefix.text)) {
    escalated = true;
    index += 1;
    index = skipEnvAssignments(tokens, index);
  }

  return { command: tokens[index]?.text, escalated };
}

/**
 * True when ANY command position in the script invokes an escalation
 * tool (`sudo`/`doas`/`pkexec`) — not just the leading command that
 * {@link parseLeadingCommand} inspects.
 *
 * Unlike `detectAdminEscalation` (which is deliberately limited to the
 * FIRST command of the FIRST line, because that's the only position we
 * can safely auto-elevate), this scans every line and every
 * `&& || ; | &`-separated segment, stripping each segment's leading
 * `NAME=value` assignments before checking its command token.
 *
 * It exists for the advisory diagnostic in `runCommand`: a script that
 * escalates in a NON-leading position (`cd /x && sudo …`, `echo y |
 * sudo …`, a second-line `sudo …`) will run that `sudo` on the
 * non-elevated child (null stdin, no TTY) and fail with "a terminal is
 * required to read the password". We can't auto-wrap the whole line
 * (that would elevate the leading command too), so we warn instead.
 *
 * Shallow, like the rest of this module: no quoting/escaping awareness.
 * A `sudo` inside a quoted string is split on whitespace and could in
 * principle be seen as a token, but only as a SEGMENT-leading token —
 * `echo "use sudo"` has segment-leading `echo`, so it does not match.
 */
export function scriptReferencesEscalationTool(script: string): boolean {
  for (const rawLine of script.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    // Walk each separator-delimited segment of the line.
    let rest = line;
    while (rest.length > 0) {
      const end = firstCommandSegmentEnd(rest);
      const segment = rest.slice(0, end);
      const tokens = tokenizeWithOffsets(segment, 0);
      const index = skipEnvAssignments(tokens, 0);
      const lead = tokens[index]?.text;
      if (lead !== undefined && ESCALATION_TOOLS.includes(lead)) {
        return true;
      }
      // Advance past this segment AND its trailing separator. The
      // separator is 1 or 2 chars; find which by re-testing at `end`.
      if (end >= rest.length) break;
      const sep = COMMAND_SEPARATORS.find((s) => rest.startsWith(s, end));
      rest = rest.slice(end + (sep?.length ?? 1)).trimStart();
    }
  }
  return false;
}

export function parseUtilityNameWithRange(
  script: string,
): UtilityNameRange | null {
  const line = firstExecutableLine(script);
  if (line === null) return null;

  // Tokens of the first command segment, each with its absolute offset
  // in `script` (lineStart + token offset within the line).
  const segmentEnd = firstCommandSegmentEnd(line.text);
  const tokens = tokenizeWithOffsets(
    line.text.slice(0, segmentEnd),
    line.start,
  );

  let index = skipEnvAssignments(tokens, 0);

  // Optional single escalation prefix, followed by more env-assignments.
  const maybePrefix = tokens[index];
  if (maybePrefix !== undefined && ESCALATION_TOOLS.includes(maybePrefix.text)) {
    index += 1;
    index = skipEnvAssignments(tokens, index);
  }

  const candidate = tokens[index];
  if (candidate === undefined) return null;
  if (!isSafeUtilityToken(candidate.text)) return null;
  return {
    name: candidate.text,
    start: candidate.start,
    end: candidate.start + candidate.text.length,
  };
}

/**
 * Extract the leading utility name from a raw script body, or `null`
 * when there is no plausible bare-utility token. Thin wrapper over
 * {@link parseUtilityNameWithRange} that drops the position.
 *
 * Heuristic (mirrors the Rust `parse_utility_name`):
 *   - Use the FIRST non-empty, non-comment / non-shebang line.
 *   - Keep only the first command segment (cut at the first separator),
 *     so `ls;rm`, `ls ; rm` and `ls && rm` all resolve to `ls`.
 *   - Strip leading `FOO=bar` environment-assignment tokens.
 *   - If the next token is an escalation tool (sudo/doas/pkexec), skip
 *     it AND any further env-assignments, then take the next token.
 *   - Return `null` if the candidate is empty, a `${...}` / `$VAR`
 *     reference, or fails {@link isSafeUtilityToken} (neither a safe
 *     bare name nor a safe executable path).
 */
export function parseUtilityName(script: string): string | null {
  return parseUtilityNameWithRange(script)?.name ?? null;
}

/** A whitespace-delimited token plus its absolute offset in the source. */
interface OffsetToken {
  text: string;
  start: number;
}

/**
 * The first executable line of `script` plus the absolute offset at
 * which its (trimmed) content begins. Skips blank lines and `#`-prefixed
 * comments / shebangs. `null` when there is no such line.
 *
 * `start` points at the first non-whitespace character of the line, so a
 * token offset computed within `text` maps back to the original string
 * by adding `start`.
 */
function firstExecutableLine(
  script: string,
): { text: string; start: number } | null {
  let offset = 0;
  for (const rawLine of script.split("\n")) {
    const trimmedStart = rawLine.length - rawLine.trimStart().length;
    const text = rawLine.trim();
    if (text.length === 0) {
      offset += rawLine.length + 1; // +1 for the consumed "\n"
      continue;
    }
    // `#!` shebang and `#` comments are both skipped — a shebang is a
    // comment to the shell, so collapsing them is correct.
    if (text.startsWith("#")) {
      offset += rawLine.length + 1;
      continue;
    }
    return { text, start: offset + trimmedStart };
  }
  return null;
}

/**
 * Index into `line` at which the first command ends — i.e. the offset of
 * the first shell command separator, or `line.length` when there is
 * none. Deliberately shallow (no quoting/escaping awareness); see the
 * note on the original `firstCommandSegment`.
 */
function firstCommandSegmentEnd(line: string): number {
  let i = 0;
  while (i < line.length) {
    if (COMMAND_SEPARATORS.some((s) => line.startsWith(s, i))) {
      return i;
    }
    i += 1;
  }
  return line.length;
}

/**
 * Split `segment` into whitespace-delimited tokens, each carrying its
 * absolute offset in the original source (`baseOffset` is the source
 * offset of `segment[0]`).
 */
function tokenizeWithOffsets(
  segment: string,
  baseOffset: number,
): OffsetToken[] {
  const tokens: OffsetToken[] = [];
  const re = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(segment)) !== null) {
    tokens.push({ text: match[0], start: baseOffset + match.index });
  }
  return tokens;
}

/**
 * Advance `index` past any leading `NAME=value` environment-assignment
 * tokens, returning the new index. A token counts as an assignment when
 * it contains `=` and the part before `=` is a valid shell identifier.
 */
function skipEnvAssignments(
  tokens: readonly OffsetToken[],
  start: number,
): number {
  let index = start;
  for (let tok = tokens[index]; tok !== undefined; tok = tokens[index]) {
    if (!isEnvAssignment(tok.text)) break;
    index += 1;
  }
  return index;
}

/**
 * True when `tok` is a `NAME=value` assignment whose `NAME` is a valid
 * shell identifier (`[A-Za-z_][A-Za-z0-9_]*`). Mirrors the Rust
 * `is_env_assignment`.
 */
function isEnvAssignment(tok: string): boolean {
  const eq = tok.indexOf("=");
  if (eq <= 0) return false;
  const name = tok.slice(0, eq);
  if (!/^[A-Za-z_]/.test(name)) return false;
  return /^[A-Za-z0-9_]+$/.test(name);
}

/**
 * Validate a bare utility name. This is the security boundary's JS
 * mirror: it allows ONLY `[A-Za-z0-9_.+-]`, requires a non-empty name
 * that STARTS with an alphanumeric (so it can never be parsed as a flag
 * by the spawned binary), and rejects everything else (paths, shell
 * metacharacters, `$`, quotes, whitespace, …). Mirrors the Rust
 * `is_safe_utility_name`.
 *
 * Mid-name `_ . + -` are allowed (e.g. `apt-get`, `g++`, `a.out`, `7z`).
 */
export function isSafeUtilityName(name: string): boolean {
  if (name.length === 0) return false;
  // First char must be ASCII alphanumeric.
  if (!/^[A-Za-z0-9]/.test(name)) return false;
  // Every char must be in the allow-list.
  return /^[A-Za-z0-9_.+-]+$/.test(name);
}

/**
 * Validate a leading-utility token: a safe bare name OR a safe
 * executable path. Mirrors the Rust `is_safe_utility_token`. The parser
 * and the backend both gate on this.
 */
export function isSafeUtilityToken(tok: string): boolean {
  return isSafeUtilityName(tok) || isSafeUtilityPath(tok);
}

/**
 * Validate an executable PATH token (absolute or relative). Mirrors the
 * Rust `is_safe_utility_path`.
 *
 * A path is recognised by containing a `/`. We allow ONLY
 * `[A-Za-z0-9_.+-/]` and require the first char to be `/` (absolute) or
 * `.` (relative `./`, `../`), so the token can never be parsed as a flag.
 * Every shell metacharacter (`$`, backticks, quotes, whitespace, `;`,
 * `|`, `&`, `<`, `>`, glob `*?[]`, `~`, `\`) is excluded by the
 * allow-list. The backend spawns the path directly (no shell, fixed arg
 * array), so the literal file — and nothing else — is executed.
 */
export function isSafeUtilityPath(tok: string): boolean {
  if (!tok.includes("/")) return false;
  // First char must mark an absolute (`/`) or relative (`.`) path.
  if (!/^[/.]/.test(tok)) return false;
  return /^[A-Za-z0-9_.+/-]+$/.test(tok);
}
