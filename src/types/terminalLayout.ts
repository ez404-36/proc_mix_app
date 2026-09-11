import type { ConsoleDockPosition } from "../stores/executionStore";

/**
 * Types for terminal layout presets ("макеты терминала") — named, user-saved
 * snapshots of the console's Terminal mode: the display variant (dock
 * position / fullscreen / panel size), the region split tree, and the last
 * typed command per saved window. Persisted in SQLite via the
 * `terminal_layouts` commands (see `services/terminalLayoutsService.ts`).
 *
 * Live PTY sessions are never part of the snapshot — a session cannot survive
 * an apply; only the tree structure and the command strings are saved. See
 * `docs/interactive-terminal.md` ("Layouts").
 */

/**
 * One saved terminal window (a tab slot inside a region leaf). `title` is
 * the tab's custom title when it was renamed (absent = default "Terminal N"
 * title, re-derived on apply). `lastCommand` is the last command typed into
 * that window at save time (absent = nothing typed). `cwd` is the directory
 * the shell was observed in at save time (absent = unobservable — /proc is
 * Linux-only). `remoteCommand` is the running `ssh` child's command line
 * when the window was INSIDE an ssh session at save time: such a window
 * replays ONLY the connection on apply — the other fields describe remote
 * state we cannot restore.
 */
export interface LayoutSnapshotTab {
  title?: string | null;
  lastCommand?: string | null;
  cwd?: string | null;
  remoteCommand?: string | null;
}

/**
 * What the backend can OBSERVE about a live session at one instant
 * (mirrors the Rust `SessionDescription`, `terminal_describe_session`).
 * Both slots are `null` when unobservable (non-Linux OS, ssh already
 * exited, /proc read race) — describing a session is best-effort.
 */
export interface TerminalSessionDescription {
  cwd: string | null;
  remoteCommand: string | null;
}

/** A `region` leaf of the snapshot: its tab slots + which tab was active. */
export interface LayoutSnapshotRegion {
  type: "region";
  tabs: LayoutSnapshotTab[];
  /** Index into `tabs` of the tab that was active when saved. */
  activeTabIndex: number;
}

/**
 * A `row`/`column` container of the snapshot. Mirrors the live `RegionNode`
 * container: `sizes` are per-child fractions (positive, normalized to sum 1
 * when a layout is built from the snapshot).
 */
export interface LayoutSnapshotContainer {
  type: "row" | "column";
  children: LayoutSnapshotNode[];
  sizes: number[];
}

export type LayoutSnapshotNode = LayoutSnapshotRegion | LayoutSnapshotContainer;

/** Saved panel size: `height` for the bottom dock, `width` for a side dock. */
export interface LayoutSize {
  height?: number;
  width?: number;
}

/** One persisted terminal layout — mirrors the Rust `TerminalLayoutRecord`. */
export interface TerminalLayoutDto {
  id: string;
  name: string;
  position: ConsoleDockPosition;
  fullscreen: boolean;
  size: LayoutSize;
  layout: LayoutSnapshotNode;
  createdAt: string;
  updatedAt: string;
}

/** Payload of `saveTerminalLayout` (create when `id` is absent). */
export interface SaveTerminalLayoutRequest {
  id?: string;
  name: string;
  position: ConsoleDockPosition;
  fullscreen: boolean;
  size: LayoutSize;
  layout: LayoutSnapshotNode;
}

/** The display+layout part of a layout, independent of its DB metadata. */
export interface TerminalLayoutState {
  position: ConsoleDockPosition;
  fullscreen: boolean;
  size: LayoutSize;
  layout: LayoutSnapshotNode;
}
