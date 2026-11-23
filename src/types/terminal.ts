/**
 * Types for the interactive Terminal feature — real PTY sessions opened
 * from the console (`OutputPanel`), separate from the sandboxed command
 * executor's `Execution` model. See `docs/interactive-terminal.md` for the
 * security-boundary rationale.
 */

/**
 * Wire event emitted by the Rust `core::terminal` backend on the
 * `terminal-event` channel. Mirrors the Rust `TerminalEvent` enum
 * (`tag = "type"`, camelCase).
 */
export type TerminalEvent = TerminalDataEvent | TerminalExitEvent;

export interface TerminalDataEvent {
  type: "data";
  sessionId: string;
  /** Base64-encoded raw bytes read from the PTY. Decode and feed directly
   *  to xterm.js's `Terminal.write(Uint8Array)`, which assembles any
   *  multi-byte UTF-8 sequence split across chunks. */
  data: string;
}

export interface TerminalExitEvent {
  type: "exit";
  sessionId: string;
  exitCode?: number;
}

/**
 * Frontend-only session metadata (the store never holds the xterm.js
 * `Terminal` instance itself — that lives in a component ref, see
 * `TerminalView`).
 */
export interface TerminalSessionMeta {
  id: string;
  /** Display title for the tab. Defaults to a generic "Terminal N" label
   *  assigned when the tab is opened; renamable later if needed. */
  title: string;
  /**
   * The tab NUMBER reserved for this session (independent of `title`, which
   * the user can rename). Kept so closing the tab can release exactly this
   * number back to `terminalStore`'s "lowest free number" allocator — e.g.
   * opening "Terminal 1", closing it, then opening a new tab reassigns "1"
   * rather than counting up forever.
   */
  number: number;
  createdAt: number;
  exited: boolean;
  exitCode?: number;
}

/**
 * Orientation of a split CONTAINER node (see {@link RegionNode}).
 *
 * - `"row"` lays its children out left-to-right — the resizable borders
 *   between them are VERTICAL (a `col-resize` drag adjusts widths). This is
 *   the "Move right" direction (a new region appears to the side).
 * - `"column"` lays its children out top-to-bottom — the borders are
 *   HORIZONTAL (`row-resize`) — the "Move down" direction.
 */
export type SplitDirection = "row" | "column";

/**
 * A REGION: one rectangular area of the Terminal panel, with its OWN tab
 * strip. A region holds one or more terminal tabs (`tabIds`, each a PTY
 * session id tracked in `terminalStore.sessions`); only `activeTabId` is
 * shown, the rest are hidden-but-mounted (scrollback preserved), exactly
 * like a browser's tab bar. The screen is divided into regions by the split
 * layout tree ({@link RegionNode}); "Move right"/"Move down" peel a tab off
 * into a NEW neighbouring region, and a tab can be dragged between regions.
 *
 * A region with an empty `tabIds` never exists — closing/moving its last tab
 * removes the region from the tree.
 */
export interface TerminalRegion {
  id: string;
  tabIds: string[];
  activeTabId: string;
}

/**
 * One node of the Terminal panel's LAYOUT TREE. Either a `region` leaf
 * (references a {@link TerminalRegion} by id) or a `row`/`column` container
 * that arranges `children` — each itself a `RegionNode`, so the screen can be
 * split arbitrarily into a grid of regions.
 *
 * Frontend-only layout state (lives in `terminalStore`, which is deliberately
 * not `persist`-ed — a PTY cannot survive an app restart).
 */
export type RegionNode = RegionLeaf | RegionContainer;

export interface RegionLeaf {
  type: "region";
  regionId: string;
}

export interface RegionContainer {
  type: "row" | "column";
  children: RegionNode[];
  /**
   * Flex-basis FRACTIONS for each child, in the same order as `children`
   * and always summing to 1. `children.length === sizes.length` is an
   * invariant maintained by every tree mutation (`regionTree.ts`). A
   * `SplitHandle` drag rebalances only the two adjacent fractions it sits
   * between, leaving the rest.
   */
  sizes: number[];
}

/* ------------------------------------------------------------------------- *
 * Tab completion (see docs/plans/terminal-tab-completion-plan.md)
 * ------------------------------------------------------------------------- */

/**
 * What KIND of word is being completed — decided by the frontend parser
 * (`parseCompletionContext`), consumed by the Rust `core::terminal::
 * completion` module. Mirrors the Rust `CompletionKind` enum.
 */
export type TerminalCompletionKind = "command" | "path" | "dir";

/** Payload of the `terminal_complete` command. Mirrors the Rust
 *  `CompletionRequest`. `prefix` is the already-unquoted text being
 *  matched; `baseDir` is the absolute directory to search (path/dir kinds
 *  only — resolved from `~` and the session cwd by the frontend). */
export interface TerminalCompletionRequest {
  kind: TerminalCompletionKind;
  prefix: string;
  baseDir?: string | null;
}

/** One completion candidate. Mirrors the Rust `CompletionCandidate`.
 *  `name` is the last path segment (or bare executable name for the
 *  command kind) — the frontend re-joins it onto the typed directory
 *  part. */
export interface TerminalCompletionCandidate {
  name: string;
  isDir: boolean;
}

/** Response of the `terminal_complete` command. An empty `candidates`
 *  list tells the frontend to fall through to the shell's native
 *  readline completion (pass the raw Tab into the PTY). */
export interface TerminalCompletionResponse {
  candidates: TerminalCompletionCandidate[];
}
