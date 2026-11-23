/**
 * Bash-style command-line parsing for Tab completion — the FRONTEND half
 * of the terminal completion feature (see
 * docs/plans/terminal-tab-completion-plan.md). Pure functions only: no
 * xterm access, no invoke, no filesystem. The Rust
 * `core::terminal::completion` module receives the already-parsed result
 * and does the actual PATH/read_dir lookup.
 *
 * MVP scope (matches the plan): cursor at end-of-line, POSIX-style paths
 * (`/`; `\` is recognised as a separator when quoting requires it but
 * Windows drive-letter resolution is v2), single active quote region,
 * backslash escapes outside single quotes. Anything the parser cannot
 * confidently handle still yields a usable context — the HOOK decides to
 * fall through to the shell's native readline completion, not the parser.
 */

/** What kind of word is being completed. Mirrors the Rust `CompletionKind`
 *  and the TS `TerminalCompletionKind`. */
export type CompletionWordKind = "command" | "path" | "dir";

/** Parsed state of the word under `cursor` in `line`. Everything the
 *  completion hook needs to build a `TerminalCompletionRequest` — plus
 *  the raw word span the hook needs to retype the completed text. */
export interface CompletionContext {
  /** Raw text from `wordStart` up to `cursor`, quotes included
   *  (`"My Fi`). Empty when the cursor sits on a word boundary. */
  word: string;
  /** Index in `line` where the word begins (the opening quote counts as
   *  part of the word). Equals `cursor` when no word is under the cursor. */
  wordStart: number;
  /** Quote character currently OPEN at the cursor, if any. A quote that
   *  already closed inside the word (`"My Files"/sub`) leaves this null. */
  quote: '"' | "'" | null;
  /** `word` with the active quote char stripped and backslash escapes
   *  resolved — the text the candidates' names are matched against. */
  unquoted: string;
  kind: CompletionWordKind;
  /** Directory portion of `unquoted` INCLUDING its trailing separator
   *  (`"/usr/`), or `""` when the word has no separator. `""` for the
   *  command kind. Resolve to an absolute base dir with
   *  {@link resolveBaseDir}. */
  dirPart: string;
  /** Final path segment being matched (`"Pro` for `cd ~/Pro`). For the
   *  command kind this is the executable-name prefix. This is the value
   *  sent to the backend as `prefix`. */
  namePrefix: string;
}

/** Characters that end a word OUTSIDE quotes. */
const WORD_SEPARATORS = new Set([" ", "\t", "\n", ";", "|", "&", "(", ")", "<", ">"]);

/** Tokens that keep the NEXT word at a command position (`sudo apt …`).
 *  Deliberately small; expansion is cheap and safe. */
const COMMAND_PREFIX_WORDS = new Set([
  "command",
  "env",
  "exec",
  "nice",
  "nohup",
  "stdbuf",
  "sudo",
  "time",
  "timeout",
  "watch",
]);

/** Tokens whose ONLY argument kind is a directory (dir-only completion). */
const DIR_ONLY_COMMANDS = new Set(["cd", "pushd", "rmdir"]);

/** `NAME=value` environment assignment — keeps the following word at a
 *  command position, like bash. */
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** How the completed token is connected to what follows it:
 *  - `start` — it is the very first token of the line;
 *  - `cmd`   — a `;`, `|`, `&`, `(`/`)` separator directly precedes the
 *              next word, which therefore starts a NEW pipeline;
 *  - `redirect` — a `<`/`>` precedes the next word (a filename);
 *  - `arg`   — plain whitespace: the next word continues the same
 *              pipeline (an argument, flag, etc.). */
type TokenSeparator = "start" | "cmd" | "redirect" | "arg";

/**
 * Parse `line` up to `cursor` (a char index into `line`) and return the
 * completion context of the word under the cursor.
 */
export function parseCompletionContext(line: string, cursor: number): CompletionContext {
  const clamped = Math.max(0, Math.min(cursor, line.length));
  let inQuote: '"' | "'" | null = null;
  let escaped = false;
  const completedTokens: { text: string; sep: TokenSeparator }[] = [];
  let nextTokenSep: TokenSeparator = "start";
  // True only while the cursor region sits DIRECTLY after a completed
  // token with no separator char in between — i.e. the next separator
  // char is plain whitespace closing off an argument.
  let justCompletedToken = false;
  let wordStart = -1;
  let text = "";

  for (let i = 0; i < clamped; i += 1) {
    const ch = line[i];
    if (inQuote === "'") {
      // Single quotes: NO escapes inside, `'` is the only special char.
      if (ch === "'") {
        inQuote = null;
      } else {
        text += ch;
      }
      continue;
    }
    if (escaped) {
      text += ch;
      escaped = false;
      continue;
    }
    // (The single-quote case already continued above, so reaching here
    // means we are outside quotes or inside double quotes — both of which
    // treat a backslash as an escape, like bash.)
    if (ch === "\\") {
      escaped = true;
      if (wordStart < 0) wordStart = i;
      continue;
    }
    if (inQuote === '"') {
      if (ch === '"') {
        inQuote = null;
      } else {
        text += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      if (wordStart < 0) wordStart = i;
      continue;
    }
    if (WORD_SEPARATORS.has(ch)) {
      if (wordStart >= 0) {
        completedTokens.push({ text, sep: nextTokenSep });
        wordStart = -1;
        text = "";
        justCompletedToken = true;
      }
      if (ch === "<" || ch === ">") {
        nextTokenSep = "redirect";
        justCompletedToken = false;
      } else if (ch === " " || ch === "\t" || ch === "\n") {
        // Whitespace after a token closes it off as an argument; whitespace
        // after another separator (`ls | `) must NOT downgrade the
        // structural `cmd` state — it's just more separation.
        if (justCompletedToken) {
          nextTokenSep = "arg";
          justCompletedToken = false;
        }
      } else {
        nextTokenSep = "cmd";
        justCompletedToken = false;
      }
      continue;
    }
    if (wordStart < 0) wordStart = i;
    text += ch;
  }

  const unquoted = text;
  const hasWord = wordStart >= 0;
  const isCommandPosition = computeCommandPosition(completedTokens, nextTokenSep);

  let kind: CompletionWordKind;
  if (isCommandPosition) {
    // A command position containing a separator is a PATH — bash offers
    // path completion for `/usr/bin/ls<Tab>` too.
    kind = unquoted.includes("/") || unquoted.includes("\\") ? "path" : "command";
  } else {
    const previous = completedTokens[completedTokens.length - 1]?.text ?? "";
    kind = DIR_ONLY_COMMANDS.has(previous) ? "dir" : "path";
  }

  const separatorIdx =
    kind === "command" ? -1 : Math.max(unquoted.lastIndexOf("/"), unquoted.lastIndexOf("\\"));
  const dirPart = separatorIdx === -1 ? "" : unquoted.slice(0, separatorIdx + 1);
  const namePrefix = separatorIdx === -1 ? unquoted : unquoted.slice(separatorIdx + 1);

  return {
    word: hasWord ? line.slice(wordStart, clamped) : "",
    wordStart: hasWord ? wordStart : clamped,
    quote: inQuote,
    unquoted,
    kind,
    dirPart,
    namePrefix,
  };
}

/**
 * Is the word under the cursor at a command position? Immediately after a
 * `;|&(` separator — yes. After `<`/`>` — no (filename). After plain
 * whitespace: only when every completed token so far is an env assignment
 * or a command-prefix wrapper (`sudo apt …`); the first real command
 * makes everything after it an argument.
 */
function computeCommandPosition(
  completedTokens: { text: string; sep: TokenSeparator }[],
  currentSep: TokenSeparator,
): boolean {
  if (currentSep === "start") return true;
  if (currentSep === "cmd") return true;
  if (currentSep === "redirect") return false;
  for (let i = completedTokens.length - 1; i >= 0; i -= 1) {
    const { text } = completedTokens[i];
    if (ENV_ASSIGNMENT_RE.test(text)) continue;
    if (COMMAND_PREFIX_WORDS.has(text)) continue;
    return false;
  }
  return true;
}

/**
 * Resolve a parsed {@link CompletionContext} `dirPart` into the absolute
 * base directory the backend should search. Returns null when the
 * reference cannot be resolved (`~user` syntax, or neither cwd nor home
 * is known) — the hook then falls through to native completion.
 *
 * POSIX-flavoured by design for M1 (see the plan's §4 "v2" note): `~`
 * expands against `home`, relative parts join onto `cwd` with `/`.
 */
export function resolveBaseDir(dirPart: string, cwd: string | null, home: string | null): string | null {
  if (dirPart === "~") return home;
  if (dirPart.startsWith("~/")) {
    if (home === null) return null;
    return joinDir(home, dirPart.slice(1));
  }
  if (dirPart.startsWith("~")) return null; // `~user/...` — not supported
  if (dirPart.startsWith("/")) return dirPart;
  const base = cwd ?? home;
  if (base === null) return null;
  return joinDir(base, dirPart);
}

/** Join `part` onto a base directory, tolerating a missing/extra trailing
 *  slash on either side (`/home/u` + `/docs/` → `/home/u/docs/`). An
 *  empty part returns the base unchanged — it already IS a directory. */
function joinDir(base: string, part: string): string {
  if (part === "") return base;
  if (base.endsWith("/")) {
    return part.startsWith("/") ? base + part.slice(1) : base + part;
  }
  return part.startsWith("/") ? base + part : `${base}/${part}`;
}
