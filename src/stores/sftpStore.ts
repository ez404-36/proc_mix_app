// Store for the SFTP dual-pane file manager.
//
// Holds one local pane and one remote pane (for a chosen SSH alias), a shared
// clipboard, per-pane selection, and the in-progress drag payload. The single
// `transfer` action backs BOTH clipboard paste and drag-and-drop, so copy/move
// semantics can never diverge between the two gestures.
//
// All IPC goes through `sftpService` — this store never calls `invoke`.
//
// Reference stability: selectors that read a "missing" value return a hoisted
// constant, never a fresh literal — a new `{}`/`[]` each call would defeat
// zustand's `Object.is` comparison and cause an infinite render loop.

import { create } from 'zustand';
import {
  listLocalDir,
  localDelete,
  localMkdir,
  localRename,
  sftpDelete,
  sftpDownload,
  sftpListDir,
  sftpMkdir,
  sftpRename,
  sftpUpload,
} from '../services/sftpService';
import type {
  ClipboardOp,
  DragPayload,
  LocalEntry,
  PaneSide,
  SftpEntry,
  SftpEntryKind,
  TransferMode,
} from '../types/sftp';

/** A pane entry normalised across local/remote so the UI renders one shape. */
export interface PaneEntry {
  name: string;
  kind: SftpEntryKind;
  size: number | null;
}

/** One pane's browsing state. */
export interface PaneState {
  /** Absolute current directory, or `null` before the first load. */
  cwd: string | null;
  entries: PaneEntry[];
  isLoading: boolean;
  /** Last load/op error for this pane, or `null`. */
  error: string | null;
  /** Selected entry names within `cwd`. */
  selection: string[];
}

/** Hoisted stable default for an unopened pane (see reference-stability note). */
const EMPTY_PANE: PaneState = {
  cwd: null,
  entries: [],
  isLoading: false,
  error: null,
  selection: [],
};

/** Result of a {@link SftpState.transfer}: which paths failed, if any. */
export interface TransferResult {
  ok: boolean;
  /** Source paths that failed to transfer (and so were NOT deleted on a move). */
  failed: string[];
}

/** One completed transfer action, recorded for the header status bar. */
export interface TransferLogEntry {
  /** Stable id for React keys (monotonic). */
  id: number;
  /** Base name of the transferred entry. */
  name: string;
  /** `copy` or `move` (the requested mode). */
  mode: TransferMode;
  /** Direction, for the icon/label (`'upload' | 'download' | 'local' | 'remote'`). */
  direction: 'upload' | 'download' | 'local' | 'remote';
  /** Whether the action succeeded. */
  ok: boolean;
  /** The error message when `ok` is false; `null` on success. */
  error: string | null;
  /** Epoch ms when the action completed. */
  at: number;
}

/** Cap on retained log entries so a long session can't grow unbounded. */
const TRANSFER_LOG_CAP = 100;

/** Monotonic id source for {@link TransferLogEntry} (stable React keys). */
let transferLogCounter = 0;
function nextLogId(): number {
  transferLogCounter += 1;
  return transferLogCounter;
}

export interface SftpState {
  /** The remote host alias both the remote pane and ops target. */
  alias: string | null;
  local: PaneState;
  remote: PaneState;
  clipboard: ClipboardOp | null;
  /** The in-progress drag payload, or `null`. */
  drag: DragPayload | null;
  /** A transfer is running (disables conflicting actions, shows progress). */
  isTransferring: boolean;
  /** Newest-first log of completed transfer actions (for the header status bar). */
  transferLog: TransferLogEntry[];

  /** Clear the transfer action log. */
  clearTransferLog: () => void;

  /** Open a session for `alias`, loading both panes' initial directories. */
  openSession: (alias: string, localHome: string, remoteHome: string) => Promise<void>;
  /** Close the session, resetting all state. */
  closeSession: () => void;
  /** Navigate a pane to `path` and load it. */
  navigate: (side: PaneSide, path: string) => Promise<void>;
  /** Reload a pane's current directory. */
  refresh: (side: PaneSide) => Promise<void>;
  /** Replace a pane's selection. */
  setSelection: (side: PaneSide, names: string[]) => void;

  /** Copy the given paths from `side` into the clipboard. */
  copy: (side: PaneSide, paths: string[]) => void;
  /** Cut (move-on-paste) the given paths from `side` into the clipboard. */
  cut: (side: PaneSide, paths: string[]) => void;
  /** Paste the clipboard into `targetSide`'s directory `targetDir`. */
  paste: (targetSide: PaneSide, targetDir: string) => Promise<TransferResult>;

  /** Set/clear the in-progress drag payload. */
  setDrag: (drag: DragPayload | null) => void;

  /**
   * The unified transfer primitive backing paste AND drag-drop. Moves/copies
   * `paths` from `fromSide` into `toDir` on `toSide`. On `mode: 'move'` a
   * source is deleted ONLY after its own transfer succeeds; a failed item is
   * left in place and reported in {@link TransferResult.failed}.
   */
  transfer: (args: {
    fromSide: PaneSide;
    toSide: PaneSide;
    paths: string[];
    toDir: string;
    mode: TransferMode;
  }) => Promise<TransferResult>;

  /** Delete the given paths on `side` (best-effort across all). */
  remove: (side: PaneSide, entries: { path: string; isDir: boolean }[]) => Promise<void>;
  /** Rename an entry on `side` from `from` to `to` (absolute paths). */
  rename: (side: PaneSide, from: string, to: string) => Promise<void>;
  /** Create a directory named `name` under `side`'s current directory. */
  makeDir: (side: PaneSide, name: string) => Promise<void>;
}

/**
 * Join a directory and a base name into a POSIX/local path.
 *
 * If `name` is itself absolute (starts with `/`) it REPLACES `dir` rather than
 * being appended — this guards against producing mangled paths like
 * `//home///home/x` when a user types an absolute destination. Any resulting
 * run of slashes is collapsed to a single `/` (except a path is never reduced
 * to empty — the root stays `/`).
 */
export function joinPath(dir: string, name: string): string {
  const joined = name.startsWith('/') ? name : `${dir}/${name}`;
  const collapsed = joined.replace(/\/{2,}/g, '/');
  return collapsed === '' ? '/' : collapsed;
}

/** The parent directory of an absolute path (POSIX-style), or `/` at the root. */
export function parentDir(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

/** Sort entries: directories first, then case-insensitive by name. */
function sortEntries(entries: PaneEntry[]): PaneEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = a.kind === 'dir' ? 0 : 1;
    const bDir = b.kind === 'dir' ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

function toPaneEntries(entries: (SftpEntry | LocalEntry)[]): PaneEntry[] {
  return entries.map((e) => ({ name: e.name, kind: e.kind, size: e.size }));
}

/** Load a directory for `side`, returning the new pane state. */
async function loadPane(
  side: PaneSide,
  alias: string | null,
  path: string,
): Promise<PaneState> {
  if (side === 'remote') {
    if (alias === null) {
      return { ...EMPTY_PANE, error: 'no remote host selected' };
    }
    const listing = await sftpListDir(alias, path);
    return {
      cwd: listing.path,
      entries: sortEntries(toPaneEntries(listing.entries)),
      isLoading: false,
      error: null,
      selection: [],
    };
  }
  const listing = await listLocalDir(path);
  return {
    cwd: listing.path,
    entries: sortEntries(toPaneEntries(listing.entries)),
    isLoading: false,
    error: null,
    selection: [],
  };
}

export const useSftpStore = create<SftpState>((set, get) => ({
  alias: null,
  local: EMPTY_PANE,
  remote: EMPTY_PANE,
  clipboard: null,
  drag: null,
  isTransferring: false,
  transferLog: [],

  clearTransferLog: () => set({ transferLog: [] }),

  openSession: async (alias, localHome, remoteHome) => {
    set({
      alias,
      local: { ...EMPTY_PANE, isLoading: true },
      remote: { ...EMPTY_PANE, isLoading: true },
      clipboard: null,
      drag: null,
      transferLog: [],
    });
    // Load both panes independently so one failing doesn't blank the other.
    await Promise.all([
      get().navigate('local', localHome),
      get().navigate('remote', remoteHome),
    ]);
  },

  closeSession: () => {
    set({
      alias: null,
      local: EMPTY_PANE,
      remote: EMPTY_PANE,
      clipboard: null,
      drag: null,
      isTransferring: false,
      transferLog: [],
    });
  },

  navigate: async (side, path) => {
    set((s) => ({ [side]: { ...s[side], isLoading: true, error: null } }) as Partial<SftpState>);
    try {
      const pane = await loadPane(side, get().alias, path);
      set({ [side]: pane } as Partial<SftpState>);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set(
        (s) =>
          ({ [side]: { ...s[side], isLoading: false, error: message } }) as Partial<SftpState>,
      );
    }
  },

  refresh: async (side) => {
    const cwd = get()[side].cwd;
    if (cwd === null) return;
    await get().navigate(side, cwd);
  },

  setSelection: (side, names) => {
    set((s) => ({ [side]: { ...s[side], selection: names } }) as Partial<SftpState>);
  },

  copy: (side, paths) => {
    if (paths.length === 0) return;
    set({ clipboard: { mode: 'copy', side, paths } });
  },

  cut: (side, paths) => {
    if (paths.length === 0) return;
    set({ clipboard: { mode: 'move', side, paths } });
  },

  paste: async (targetSide, targetDir) => {
    const clipboard = get().clipboard;
    if (clipboard === null) return { ok: true, failed: [] };
    const result = await get().transfer({
      fromSide: clipboard.side,
      toSide: targetSide,
      paths: clipboard.paths,
      toDir: targetDir,
      mode: clipboard.mode,
    });
    // A successful cut consumes the clipboard; a copy keeps it for re-paste.
    if (result.ok && clipboard.mode === 'move') {
      set({ clipboard: null });
    }
    return result;
  },

  setDrag: (drag) => set({ drag }),

  transfer: async ({ fromSide, toSide, paths, toDir, mode }) => {
    const alias = get().alias;
    if (paths.length === 0) return { ok: true, failed: [] };
    set({ isTransferring: true });
    const failed: string[] = [];
    // The direction label for the log: cross-pane is upload/download; same-pane
    // is a local/remote relocation.
    const direction: TransferLogEntry['direction'] =
      fromSide === toSide ? fromSide : toSide === 'remote' ? 'upload' : 'download';
    const newEntries: TransferLogEntry[] = [];
    try {
      for (const sourcePath of paths) {
        const name = sourcePath.split('/').pop() ?? sourcePath;
        const destPath = joinPath(toDir, name);
        // Reject a no-op or a move into the source's own location.
        if (fromSide === toSide && sourcePath === destPath) continue;
        try {
          const { movedSource } = await transferOne({
            alias,
            fromSide,
            toSide,
            sourcePath,
            destPath,
          });
          // Move: delete the source ONLY after a confirmed-successful transfer,
          // and ONLY when the transfer itself did not already relocate it (a
          // same-pane rename moves in one atomic step — deleting afterward
          // would target a path that no longer exists).
          if (mode === 'move' && !movedSource) {
            await deleteSource(alias, fromSide, sourcePath);
          }
          newEntries.push({
            id: nextLogId(),
            name,
            mode,
            direction,
            ok: true,
            error: null,
            at: Date.now(),
          });
        } catch (err) {
          failed.push(sourcePath);
          newEntries.push({
            id: nextLogId(),
            name,
            mode,
            direction,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            at: Date.now(),
          });
        }
      }
    } finally {
      // Prepend newest-first and cap the retained history.
      set((s) => ({
        isTransferring: false,
        transferLog: [...newEntries.reverse(), ...s.transferLog].slice(0, TRANSFER_LOG_CAP),
      }));
    }
    // Refresh affected panes so the UI reflects the result.
    await Promise.all([get().refresh(fromSide), get().refresh(toSide)]);
    return { ok: failed.length === 0, failed };
  },

  remove: async (side, entries) => {
    const alias = get().alias;
    for (const { path, isDir } of entries) {
      try {
        if (side === 'remote') {
          if (alias === null) continue;
          await sftpDelete(alias, path, isDir);
        } else {
          await localDelete(path, isDir);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set((s) => ({ [side]: { ...s[side], error: message } }) as Partial<SftpState>);
      }
    }
    await get().refresh(side);
  },

  rename: async (side, from, to) => {
    const alias = get().alias;
    if (side === 'remote') {
      if (alias === null) return;
      await sftpRename(alias, from, to);
    } else {
      await localRename(from, to);
    }
    await get().refresh(side);
  },

  makeDir: async (side, name) => {
    const alias = get().alias;
    const cwd = get()[side].cwd;
    if (cwd === null) return;
    const path = joinPath(cwd, name);
    if (side === 'remote') {
      if (alias === null) return;
      await sftpMkdir(alias, path);
    } else {
      await localMkdir(path);
    }
    await get().refresh(side);
  },
}));

/** Outcome of a single {@link transferOne}. */
interface TransferOneResult {
  /**
   * `true` when the primitive itself relocated the source (a same-pane
   * rename), so the caller must NOT issue a separate source delete for a move.
   * `false` for cross-pane copies (upload/download), where a move still needs
   * an explicit source delete.
   */
  movedSource: boolean;
}

/**
 * Transfer a single entry across (or within) panes, choosing the right
 * primitive:
 *   - local→remote = upload (copy; `movedSource: false`)
 *   - remote→local = download (copy; `movedSource: false`)
 *   - remote→remote = rename (atomic move; `movedSource: true`)
 *   - local→local = local rename (atomic move; `movedSource: true`)
 */
async function transferOne(args: {
  alias: string | null;
  fromSide: PaneSide;
  toSide: PaneSide;
  sourcePath: string;
  destPath: string;
}): Promise<TransferOneResult> {
  const { alias, fromSide, toSide, sourcePath, destPath } = args;
  if (fromSide === 'local' && toSide === 'remote') {
    if (alias === null) throw new Error('no remote host selected');
    await sftpUpload(alias, sourcePath, destPath);
    return { movedSource: false };
  }
  if (fromSide === 'remote' && toSide === 'local') {
    if (alias === null) throw new Error('no remote host selected');
    await sftpDownload(alias, sourcePath, destPath);
    return { movedSource: false };
  }
  if (fromSide === 'remote' && toSide === 'remote') {
    if (alias === null) throw new Error('no remote host selected');
    await sftpRename(alias, sourcePath, destPath);
    return { movedSource: true };
  }
  // local → local: an atomic OS rename moves the entry in one step.
  await localRename(sourcePath, destPath);
  return { movedSource: true };
}

/**
 * Delete a transferred source after a confirmed-successful CROSS-pane move
 * (same-pane moves relocate via rename and never reach here). `isDir` is
 * unknown at this layer, so deletion is attempted as a file first and, if the
 * source is actually a directory, as a recursive directory removal.
 */
async function deleteSource(
  alias: string | null,
  side: PaneSide,
  path: string,
): Promise<void> {
  if (side === 'remote') {
    if (alias === null) throw new Error('no remote host selected');
    try {
      await sftpDelete(alias, path, false);
    } catch {
      await sftpDelete(alias, path, true);
    }
    return;
  }
  try {
    await localDelete(path, false);
  } catch {
    await localDelete(path, true);
  }
}

/** Read a pane's state, returning a stable empty default when unset. */
export function selectPane(state: SftpState, side: PaneSide): PaneState {
  return side === 'local' ? state.local : state.remote;
}
