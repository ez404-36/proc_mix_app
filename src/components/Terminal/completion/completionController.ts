/**
 * Tab-completion controller for one xterm.js Terminal / PTY session — the
 * M2 core of docs/plans/terminal-tab-completion-plan.md (no popup UI yet).
 *
 * Contract with the shell: the current input line belongs to the PTY's
 * readline, and xterm only renders its echo. EVERY text change therefore
 * goes through the PTY ({@link CompletionControllerDeps.write}): we send
 * backspaces to erase the typed word and then the replacement characters,
 * and the shell redraws the line itself. We never `term.write` into the
 * buffer directly.
 *
 * Fallback rule: when we cannot produce candidates (empty result, cursor
 * not at end-of-line, alternate-screen app, unresolvable base dir, race
 * with the user typing), we forward a literal `\t` into the PTY so the
 * shell's own native readline completion still runs — this feature is an
 * enhancement layered OVER bash, never a replacement for it.
 *
 * MVP scope (per the plan): cursor at end-of-line only, POSIX path
 * resolution, single-word commands. Prompt detection is a heuristic (last
 * `$ `/`# `/`% ` chunk) — arbitrary multi-line prompts are a documented
 * v2 limitation.
 */

import type { Terminal } from "@xterm/xterm";
import type {
  TerminalCompletionCandidate,
  TerminalCompletionRequest,
  TerminalCompletionResponse,
} from "../../../types/terminal";
import { parseCompletionContext, resolveBaseDir } from "./parseLine";
import type { CompletionContext } from "./parseLine";

export interface CompletionControllerDeps {
  sessionId: string;
  /** Write raw text into the PTY (same path the user's keystrokes take). */
  write: (data: string) => void;
  /** Backend candidate lookup (`terminal_complete`). */
  complete: (request: TerminalCompletionRequest) => Promise<TerminalCompletionResponse>;
  /** Best-effort session cwd (null where unobservable, e.g. non-Linux). */
  describeSession: (sessionId: string) => Promise<{ cwd: string | null } | null>;
  /** The user's home directory (null when unavailable). */
  homeDir: () => Promise<string | null>;
  /** M3 popup state stream. Null = nothing to show (also used for a
   *  single-candidate completion — a one-item list is noise). */
  onPopupStateChange?: (state: CompletionPopupState | null) => void;
}

const BACKSPACE = "\x7F";
const TAB = "\t";

/** State of an ONGOING menu-complete cycle. */
interface ActiveCompletion {
  candidates: TerminalCompletionCandidate[];
  /** -1 = the longest-common-prefix (or the original word) is on screen;
   *  >= 0 = the candidate at this index is fully inserted. */
  index: number;
  /** Raw text we last inserted (exactly what a cycle step must erase). */
  insertedRaw: string;
  /** The word as the user typed it — restored when the cycle wraps. */
  originalRaw: string;
  ctx: CompletionContext;
  /** True after an explicit accept (popup click) — the list hides but the
   *  cycle stays armed until new user input or Escape. */
  hidden: boolean;
}

/** Render state of the M3 popup. Mirrored 1:1 by `CompletionPopup`. */
export interface CompletionPopupState {
  candidates: TerminalCompletionCandidate[];
  /** Current cycle index; -1 = the LCP / original word is on screen. */
  index: number;
}

/** A snapshot of where the cursor was when Tab was pressed, used to drop
 *  stale async results if the user keeps typing while we compute. */
interface BufferSnapshot {
  line: string;
  cursorX: number;
}

export function createCompletionController(
  term: Terminal,
  deps: CompletionControllerDeps,
): {
  /** xterm key-event handler: returns false ONLY for Tab keydowns we own
   *  (they are re-sent as `\t` on the passthrough path). */
  handleKeyEvent: (event: KeyboardEvent) => boolean;
  /** Must be called for every user keystroke chunk (`onData`) — any user
   *  input invalidates an in-flight completion cycle. */
  notifyInput: (data: string) => void;
  /** Accept a candidate by index (popup click / Enter handling). */
  accept: (candidateIndex: number) => void;
} {
  let active: ActiveCompletion | null = null;

  const notifyPopup = (): void => {
    const current = active;
    if (current === null || current.hidden || current.candidates.length < 2) {
      deps.onPopupStateChange?.(null);
      return;
    }
    deps.onPopupStateChange?.({
      candidates: current.candidates,
      index: current.index,
    });
  };

  const snapshot = (): BufferSnapshot | null => {
    const buffer = term.buffer.active;
    return {
      // TRIMMED: with trimRight=false xterm pads the string out to the
      // full row width, which would break the end-of-line check (the
      // cursor cell can never equal a padded length). A just-inserted
      // trailing suffix (space after a command, `/` after a directory) is
      // therefore invisible HERE — the cycle sanity check compensates by
      // comparing against insertedRaw.trimEnd() (see `cycle`).
      line: buffer.getLine(buffer.cursorY)?.translateToString(true) ?? "",
      cursorX: buffer.cursorX,
    };
  };

  const handleKeyEvent = (event: KeyboardEvent): boolean => {
    if (event.type !== "keydown") return true;
    if (event.key === "Escape" && active !== null && !active.hidden) {
      // Esc dismisses a VISIBLE popup but keeps the completed word on
      // screen (bash keeps its completion too). When the list is already
      // hidden (after a click-accept), Esc reaches the shell untouched.
      event.preventDefault();
      active = null;
      notifyPopup();
      return false;
    }
    if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) return true;
    event.preventDefault();
    if (event.shiftKey) {
      void cycle(-1);
    } else {
      void startOrCycle(1);
    }
    return false;
  };

  const notifyInput = (data: string): void => {
    if (data.length > 0 && active !== null) {
      active = null;
      notifyPopup();
    }
  };

  /** Send a raw Tab to the PTY: the shell's native completion handles it. */
  const passthrough = (): void => {
    deps.write(TAB);
  };

  /** Erase `count` input characters at the cursor via backspaces. */
  const erase = (count: number): string => BACKSPACE.repeat(count);

  /** Replace the currently inserted tail with `raw` text (erase + write). */
  const replaceInserted = (raw: string): void => {
    const current = active;
    if (current === null) return;
    const data = erase(current.insertedRaw.length) + raw;
    current.insertedRaw = raw;
    deps.write(data);
  };

  const startOrCycle = async (direction: 1 | -1): Promise<void> => {
    if (active !== null) {
      await cycle(direction);
      return;
    }
    await startFresh(direction);
  };

  /** Accept one candidate explicitly (popup click). Inserts it fully
   *  (with suffix) and hides the list, keeping the cycle armed so a
   *  subsequent Tab keeps stepping through the candidates. */
  const accept = (candidateIndex: number): void => {
    const current = active;
    const candidate = current?.candidates[candidateIndex];
    if (current === null || candidate === undefined) return;
    current.index = candidateIndex;
    current.hidden = true;
    applyInsertion(
      rawInsertion(fullValue(candidate.name, current.ctx), current.ctx) +
        candidateSuffix(candidate, current.ctx.kind),
    );
    notifyPopup();
  };

  const startFresh = async (direction: 1 | -1): Promise<void> => {
    if (term.buffer.active.type === "alternate") {
      passthrough(); // full-screen app (vim, htop) — never intercept
      return;
    }
    const before = snapshot();
    // MVP: only complete at end-of-line — a mid-line cursor needs
    // readline-aware retyping that v2 (per the plan) must solve first.
    // "End of line" = everything AFTER the cursor cell is whitespace
    // (the cursor may sit past the trimmed length right after we inserted
    // a trailing space/`/` suffix in a previous step).
    if (before === null || before.line.slice(before.cursorX).trim().length > 0) {
      passthrough();
      return;
    }

    // Strip the prompt heuristically (see the module doc): everything after
    // the LAST `$ `/`# `/`% ` chunk is the user's command line.
    const promptLen = promptPrefixLength(before.line);
    const cmdLine = before.line.slice(promptLen);
    const cmdCursor = before.cursorX - promptLen;
    const ctx = parseCompletionContext(cmdLine, cmdCursor);

    const home = await deps.homeDir();
    const cwd = (await deps.describeSession(deps.sessionId))?.cwd ?? null;
    const baseDir = ctx.kind === "command" ? null : resolveBaseDir(ctx.dirPart, cwd, home);
    if (ctx.kind !== "command" && baseDir === null) {
      passthrough();
      return;
    }
    let response: TerminalCompletionResponse;
    try {
      response = await deps.complete({
        kind: ctx.kind,
        prefix: ctx.namePrefix,
        baseDir,
      });
    } catch {
      passthrough(); // backend hiccup → native completion, never a dead key
      return;
    }
    if (response.candidates.length === 0) {
      passthrough();
      return;
    }

    // Race guard: the user typed (or the shell output moved the cursor)
    // while we awaited — drop silently rather than corrupt the line.
    const after = snapshot();
    if (
      after === null ||
      after.cursorX !== before.cursorX ||
      after.line.slice(promptLen) !== cmdLine
    ) {
      active = null;
      notifyPopup();
      return;
    }

    active = {
      candidates: response.candidates,
      index: -1,
      insertedRaw: ctx.word,
      originalRaw: ctx.word,
      ctx,
      hidden: false,
    };

    if (direction === 1) {
      if (response.candidates.length === 1) {
        // Bash: a single match completes fully AND takes its trailing
        // suffix (space for a command, `/` for a directory).
        const candidate = response.candidates[0];
        applyInsertion(
          rawInsertion(fullValue(candidate.name, ctx), ctx) + candidateSuffix(candidate, ctx.kind),
        );
      } else {
        // Multiple candidates: complete to the longest common prefix,
        // WITHOUT a suffix (even if the LCP is itself a full name —
        // bash keeps no-space there because more input may disambiguate).
        // The LCP extends the NAME SEGMENT only; compare against
        // `namePrefix`, not the whole word — a `~/` dirPart must never
        // count towards (or swallow) the common prefix.
        const lcp = longestCommonPrefix(response.candidates.map((c) => c.name));
        if (lcp.length > ctx.namePrefix.length) {
          applyInsertion(rawInsertion(fullValue(lcp, ctx), ctx));
        }
      }
      notifyPopup();
    } else {
      // Shift+Tab starts the cycle at the LAST candidate.
      await cycle(-1);
    }
  };

  const cycle = async (direction: 1 | -1): Promise<void> => {
    const current = active;
    if (current === null) {
      await startFresh(direction);
      return;
    }
    // Sanity: the shell line must still end with what we inserted, or the
    // cycle bookkeeping no longer matches reality (user pasted, output
    // arrived) — drop the cycle instead of erasing the wrong text.
    const view = snapshot();
    // The snapshot is trimmed (see `snapshot`), so a trailing suffix
    // space/`/` is invisible on screen — compare without it. Everything
    // BEFORE the suffix must match exactly, or the bookkeeping is stale.
    const visibleInserted = current.insertedRaw.trimEnd();
    if (view === null || !view.line.endsWith(visibleInserted)) {
      active = null;
      notifyPopup();
      return;
    }

    let nextIndex = current.index + direction;
    if (nextIndex >= current.candidates.length || nextIndex === -1) {
      // Cycle wrap: the state BEFORE the first candidate (index -1) is the
      // word as the user originally typed it. Reached by cycling forward
      // past the last candidate, or backwards from the first one.
      replaceInserted(current.originalRaw);
      current.index = -1;
      notifyPopup();
      return;
    }
    if (nextIndex === -2) {
      // Cycling backwards from the original word wraps to the last
      // candidate (menu-complete semantics).
      nextIndex = current.candidates.length - 1;
    }
    const candidate = current.candidates[nextIndex];
    current.index = nextIndex;
    current.hidden = false;
    applyInsertion(
      rawInsertion(fullValue(candidate.name, current.ctx), current.ctx) +
        candidateSuffix(candidate, current.ctx.kind),
    );
    notifyPopup();
  };

  /** Commit `raw` as the new word tail. Identical text is a no-op — an
   *  erase+rewrite of unchanged characters would only fight the shell's
   *  echo for nothing. */
  const applyInsertion = (raw: string): void => {
    const current = active;
    if (current === null || raw === current.insertedRaw) return;
    replaceInserted(raw);
  };

  return { handleKeyEvent, notifyInput, accept };
}

/** Length of the prompt prefix per the documented heuristic: everything up
 *  to and including the last `$ `, `# ` or `% ` on the line. Covers the
 *  default bash (`user@host:~$ `), root (`host:~# `) and zsh
 *  (`user@host ~ %`) prompts; custom prompts without these delimiters
 *  simply complete with the prompt text as part of the "first token" —
 *  degraded, never destructive. */
export function promptPrefixLength(line: string): number {
  let best = -1;
  const re = /[$#%]\s/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    best = match.index + match[0].length;
  }
  return best === -1 ? 0 : best;
}

/** Longest common prefix of all names (candidates arrive sorted; prefix
 *  computation is order-independent). */
export function longestCommonPrefix(names: string[]): string {
  if (names.length === 0) return "";
  let prefix = names[0];
  for (const name of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) break;
  }
  return prefix;
}

/** Characters that force quoting when a candidate is inserted outside of
 *  an existing quote (bash quotes the same set). */
// Characters that force quoting when a candidate is inserted outside of
// an existing quote (bash quotes the same set). `~` is deliberately NOT
// here: bash never quotes it (tilde expansion only fires at word start,
// and quoting "~/x" would BREAK the expansion the user asked for).
const NEEDS_QUOTING_RE = new RegExp('[\\s"\'\\\\|&;<>()$*?\\[\\]{}#!]');

/** Render `name` as the raw keystrokes to type so the shell's word value
 *  becomes exactly `name`, honouring a quote the user already opened. */
export function rawInsertion(name: string, ctx: Pick<CompletionContext, "quote">): string {
  if (ctx.quote === "'") return name; // inside single quotes: fully literal
  if (ctx.quote === '"') return name.replace(/(["\\$`])/g, "\\$1");
  if (!NEEDS_QUOTING_RE.test(name)) return name;
  return `'${name.replace(/'/g, "'\\''")}'`;
}

/** The full word VALUE a candidate represents: the typed directory part
 *  (`~/`, `src/`, `"My Files"/`) plus the candidate's last segment. The
 *  controller ERASES the whole typed word and retypes this, so dropping
 *  the dirPart would lose the `~/` the user already typed (exactly the
 *  bug where `cd ~/Pro<Tab>` degraded to `cd Projects/`). */
function fullValue(candidateName: string, ctx: Pick<CompletionContext, "dirPart">): string {
  return ctx.dirPart + candidateName;
}

/** Trailing keystrokes after a FULLY inserted candidate: `/` for a
 *  directory (bash enters it), a space for a completed command word. */
function candidateSuffix(
  candidate: TerminalCompletionCandidate,
  kind: CompletionContext["kind"],
): string {
  if (candidate.isDir) return "/";
  if (kind === "command") return " ";
  return "";
}
