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
