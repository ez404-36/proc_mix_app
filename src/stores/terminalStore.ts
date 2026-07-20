import { create } from "zustand";
import type { TerminalSessionMeta } from "../types/terminal";

/**
 * Which top-level mode the console (`OutputPanel`) is showing: the existing
 * "Runs" view (recents strip + active execution output) or the new
 * "Terminal" view (interactive PTY tabs). Kept in this store — not
 * `executionStore` — because it is purely a Terminal-feature concern and
 * `executionStore` should not need to know Terminal exists.
 */
export type ConsolePanelMode = "runs" | "terminal";

/**
 * Deliberately NOT `persist`-ed: a terminal session is a live OS process
 * (a real PTY + shell), which cannot survive an app restart. Every session
 * is closed by the backend's `shutdown_all_sync` on exit, so restoring
 * stale session ids here would only produce dead tabs. See
 * `docs/interactive-terminal.md`.
 *
 * The xterm.js `Terminal` instances themselves are NOT stored here either
 * (not serialisable, not Zustand-friendly) — they live in a ref map inside
 * the `TerminalTabs`/`TerminalView` components, keyed by the same session id
 * this store tracks.
 */
interface TerminalState {
  panelMode: ConsolePanelMode;
  sessions: Record<string, TerminalSessionMeta>;
  sessionOrder: string[];
  activeSessionId: string | null;
  /**
   * Tab numbers currently in use — by an OPEN session, or "reserved" for a
   * spawn that is still in flight (between `reserveTabNumber()` and the
   * matching `openSession`/`releaseTabNumber` call). Backs the default
   * "Terminal N" title: `reserveTabNumber` returns the LOWEST number not in
   * this set, so closing "Terminal 1" and opening a new tab reassigns "1"
   * instead of counting up forever. The reservation step (rather than just
   * reading `sessionOrder`'s numbers at open time) exists because
   * `spawnTerminalSession()` is async — two tabs opened back-to-back before
   * either resolves must not both compute the same "lowest free number".
   */
  reservedTabNumbers: Set<number>;
  /**
   * Guards the "auto-open a first tab" behaviour so it fires ONCE ever, not
   * once per `TerminalPanel` mount. `TerminalPanel` is only rendered while
   * `panelMode === "terminal"` (see `OutputPanel`), so it fully unmounts
   * every time the user switches to "runs" and remounts fresh on switching
   * back — a component-local ref guard would reset on every such remount
   * and re-open a tab even after the user deliberately closed every one.
   * Living in the store instead makes the guard survive across those
   * mount/unmount cycles for the lifetime of the app session.
   */
  hasAutoOpenedTab: boolean;

  setPanelMode: (mode: ConsolePanelMode) => void;
  /** Reserve and return the lowest tab number not currently in use. Must be
   *  paired with either `openSession` (consumes the reservation) or
   *  `releaseTabNumber` (e.g. the spawn failed) — see field doc above. */
  reserveTabNumber: () => number;
  /** Release a reserved number without ever opening a session for it (the
   *  backend spawn failed after the number was reserved). */
  releaseTabNumber: (number: number) => void;
  /** Mark the one-time auto-open as done; returns whether it had NOT
   *  already fired (i.e. whether the caller should proceed to open a tab). */
  consumeAutoOpen: () => boolean;
  openSession: (id: string, title: string, number: number) => void;
  closeSession: (id: string) => void;
  setActiveSession: (id: string | null) => void;
  markExited: (id: string, exitCode?: number) => void;
  renameSession: (id: string, title: string) => void;
}

export const useTerminalStore = create<TerminalState>()((set, get) => ({
  panelMode: "runs",
  sessions: {},
  sessionOrder: [],
  activeSessionId: null,
  reservedTabNumbers: new Set(),
  hasAutoOpenedTab: false,

  setPanelMode: (mode) => set({ panelMode: mode }),

  reserveTabNumber: () => {
    const reserved = get().reservedTabNumbers;
    let candidate = 1;
    while (reserved.has(candidate)) candidate += 1;
    set({ reservedTabNumbers: new Set(reserved).add(candidate) });
    return candidate;
  },

  releaseTabNumber: (number) =>
    set((state) => {
      if (!state.reservedTabNumbers.has(number)) return {};
      const next = new Set(state.reservedTabNumbers);
      next.delete(number);
      return { reservedTabNumbers: next };
    }),

  consumeAutoOpen: () => {
    if (get().hasAutoOpenedTab) return false;
    set({ hasAutoOpenedTab: true });
    return true;
  },

  openSession: (id, title, number) =>
    set((state) => ({
      sessions: {
        ...state.sessions,
        [id]: {
          id,
          title,
          number,
          createdAt: Date.now(),
          exited: false,
        },
      },
      sessionOrder: [...state.sessionOrder, id],
      activeSessionId: id,
      panelMode: "terminal",
      // The number was already added to the set by `reserveTabNumber`; this
      // is a no-op in the common case, but stays correct if a future caller
      // ever opens a session for a number it did not reserve first.
      reservedTabNumbers: new Set(state.reservedTabNumbers).add(number),
    })),

  closeSession: (id) =>
    set((state) => {
      const closedSession = state.sessions[id];
      const sessions = { ...state.sessions };
      delete sessions[id];
      const sessionOrder = state.sessionOrder.filter((s) => s !== id);
      const activeSessionId =
        state.activeSessionId === id
          ? (sessionOrder[sessionOrder.length - 1] ?? null)
          : state.activeSessionId;
      // Release the closed tab's number back to the pool so the next
      // `reserveTabNumber()` call can reuse it.
      let reservedTabNumbers = state.reservedTabNumbers;
      if (closedSession) {
        reservedTabNumbers = new Set(reservedTabNumbers);
        reservedTabNumbers.delete(closedSession.number);
      }
      return { sessions, sessionOrder, activeSessionId, reservedTabNumbers };
    }),

  setActiveSession: (id) => set({ activeSessionId: id }),

  markExited: (id, exitCode) =>
    set((state) => {
      const existing = state.sessions[id];
      if (!existing) return {};
      return {
        sessions: {
          ...state.sessions,
          [id]: { ...existing, exited: true, exitCode },
        },
      };
    }),

  renameSession: (id, title) =>
    set((state) => {
      const existing = state.sessions[id];
      if (!existing) return {};
      const trimmed = title.trim();
      if (trimmed === "") return {};
      return {
        sessions: { ...state.sessions, [id]: { ...existing, title: trimmed } },
      };
    }),
}));
