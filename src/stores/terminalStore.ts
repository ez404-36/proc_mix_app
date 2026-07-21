import { create } from "zustand";
import type {
  RegionNode,
  SplitDirection,
  TerminalRegion,
  TerminalSessionMeta,
} from "../types/terminal";
import {
  collectRegionIds,
  findAdjacentRegion,
  removeRegionFromTree,
  resizeInTree,
  splitRegionInTree,
} from "../utils/regionTree";
import type { RegionSide } from "../utils/regionTree";

/**
 * Which top-level mode the console (`OutputPanel`) is showing: the existing
 * "Runs" view (recents strip + active execution output) or the new
 * "Terminal" view (interactive PTY tabs). Kept in this store — not
 * `executionStore` — because it is purely a Terminal-feature concern and
 * `executionStore` should not need to know Terminal exists.
 */
export type ConsolePanelMode = "runs" | "terminal";

/** Generate a fresh region id. Regions are frontend-only layout containers,
 *  so any unique string works; a random suffix avoids collisions across the
 *  app session. */
function newRegionId(): string {
  return `region-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Deliberately NOT `persist`-ed: a terminal session is a live OS process
 * (a real PTY + shell), which cannot survive an app restart. See
 * `docs/interactive-terminal.md`.
 *
 * The Terminal panel is divided into REGIONS — rectangular areas each with
 * their own tab strip (see `TerminalRegion`). The regions are arranged by a
 * split layout tree (`layoutRoot`, a `RegionNode`). Each open PTY session is
 * a TAB living in exactly one region. "Move right"/"Move down" peel a tab off
 * into a new neighbouring region; a tab can also be dragged between regions.
 */
interface TerminalState {
  panelMode: ConsolePanelMode;
  /** Metadata for every live PTY session (one per tab), keyed by session id. */
  sessions: Record<string, TerminalSessionMeta>;
  /** All regions, keyed by region id. A region always has >= 1 tab. */
  regions: Record<string, TerminalRegion>;
  /** The region split layout tree, or `null` when no terminal is open. */
  layoutRoot: RegionNode | null;
  /** The focused region: a new tab opened without an explicit `regionId`
   *  joins this one (see `openSession`). No longer drives any highlight —
   *  each region's own "+" already targets it directly. */
  activeRegionId: string | null;
  /**
   * Tab numbers currently in use — by an OPEN session, or "reserved" for a
   * spawn that is still in flight (between `reserveTabNumber()` and the
   * matching `openSession`/`releaseTabNumber` call). Backs the default
   * "Terminal N" title: `reserveTabNumber` returns the LOWEST number not in
   * this set, so closing "Terminal 1" and opening a new tab reassigns "1"
   * instead of counting up forever. The reservation step (rather than just
   * reading open numbers at open time) exists because `spawnTerminalSession()`
   * is async — two tabs opened back-to-back before either resolves must not
   * both compute the same "lowest free number".
   */
  reservedTabNumbers: Set<number>;
  /**
   * Guards the "auto-open a first tab" behaviour so it fires ONCE ever, not
   * once per `TerminalPanel` mount. See `docs/interactive-terminal.md`.
   */
  hasAutoOpenedTab: boolean;

  setPanelMode: (mode: ConsolePanelMode) => void;
  reserveTabNumber: () => number;
  releaseTabNumber: (number: number) => void;
  consumeAutoOpen: () => boolean;

  /**
   * Open a new tab. When `regionId` is given (and still exists) the tab joins
   * that region's strip; otherwise it joins the active region, or — if no
   * terminal is open yet — becomes the first region (the whole panel). The
   * new tab becomes its region's active tab, and its region becomes active.
   */
  openSession: (id: string, title: string, number: number, regionId?: string) => void;
  /** Close a tab. Removes it from its region; if it was the region's LAST
   *  tab, the region is removed from the layout tree (collapsing lone
   *  containers). Frees the tab's number. The caller kills the PTY. */
  closeSession: (id: string) => void;
  markExited: (id: string, exitCode?: number) => void;
  renameSession: (id: string, title: string) => void;

  /** Make `tabId` the active (visible) tab of its region, and that region
   *  the active region. */
  setActiveTab: (tabId: string) => void;
  /** Make `regionId` the active region (e.g. on click/focus within it). */
  setActiveRegion: (regionId: string) => void;

  /**
   * "Move right" / "Move down": peel `tabId` out of its current region into a
   * NEW region placed beside it along `direction`. No-op if the tab's region
   * has only one tab (nothing to peel — there'd be nowhere to move it).
   */
  moveTabToNewRegion: (tabId: string, direction: SplitDirection) => void;
  /**
   * Move `tabId` into the existing region `targetRegionId` (drag-and-drop
   * between regions). If the source region is emptied, it is removed from the
   * tree. No-op when the tab is already in the target region alone, or the
   * target is gone.
   */
  moveTabToRegion: (tabId: string, targetRegionId: string) => void;
  /**
   * Move `tabId` into the EXISTING region immediately adjacent to its current
   * region on `side` (left/right/up/down). No-op if there is no neighbour on
   * that side (the region is at that edge). Equivalent to `moveTabToRegion`
   * with the neighbour resolved by `findAdjacentRegion`.
   */
  moveTabToAdjacentRegion: (tabId: string, side: RegionSide) => void;

  /** Persist a resize drag on the border at `index` of the container at
   *  `containerPath` in the layout tree (see `resizeInTree`). */
  setSizes: (containerPath: number[], index: number, delta: number) => void;
}

/** Remove `tabId` from every region; return the updated regions map plus the
 *  id of any region left EMPTY by the removal (its last tab left). Pure over
 *  the passed map (returns a fresh object). */
function detachTab(
  regions: Record<string, TerminalRegion>,
  tabId: string,
): { regions: Record<string, TerminalRegion>; emptiedRegionId: string | null } {
  const next: Record<string, TerminalRegion> = {};
  let emptiedRegionId: string | null = null;
  for (const [rid, region] of Object.entries(regions)) {
    if (!region.tabIds.includes(tabId)) {
      next[rid] = region;
      continue;
    }
    const tabIds = region.tabIds.filter((t) => t !== tabId);
    if (tabIds.length === 0) {
      emptiedRegionId = rid;
      // Drop the region entirely (do not copy into `next`).
      continue;
    }
    // Keep the region; if the removed tab was active, fall back to the last.
    const activeTabId =
      region.activeTabId === tabId ? tabIds[tabIds.length - 1] : region.activeTabId;
    next[rid] = { ...region, tabIds, activeTabId };
  }
  return { regions: next, emptiedRegionId };
}

/** Find the region id currently holding `tabId`, or null. */
function regionOfTab(
  regions: Record<string, TerminalRegion>,
  tabId: string,
): string | null {
  for (const [rid, region] of Object.entries(regions)) {
    if (region.tabIds.includes(tabId)) return rid;
  }
  return null;
}

export const useTerminalStore = create<TerminalState>()((set, get) => ({
  panelMode: "runs",
  sessions: {},
  regions: {},
  layoutRoot: null,
  activeRegionId: null,
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

  openSession: (id, title, number, regionId) =>
    set((state) => {
      const sessions = {
        ...state.sessions,
        [id]: { id, title, number, createdAt: Date.now(), exited: false },
      };
      const reservedTabNumbers = new Set(state.reservedTabNumbers).add(number);

      // No terminal open yet → this tab becomes the first (root) region.
      if (!state.layoutRoot) {
        const rid = newRegionId();
        return {
          sessions,
          reservedTabNumbers,
          regions: { [rid]: { id: rid, tabIds: [id], activeTabId: id } },
          layoutRoot: { type: "region", regionId: rid },
          activeRegionId: rid,
          panelMode: "terminal",
        };
      }

      // Otherwise join the requested region (if it still exists) or the
      // active region (falling back to any region).
      const targetRid =
        (regionId && state.regions[regionId] ? regionId : null) ??
        (state.activeRegionId && state.regions[state.activeRegionId]
          ? state.activeRegionId
          : Object.keys(state.regions)[0]);
      const target = targetRid ? state.regions[targetRid] : undefined;
      if (!targetRid || !target) return { sessions, reservedTabNumbers };

      return {
        sessions,
        reservedTabNumbers,
        regions: {
          ...state.regions,
          [targetRid]: { ...target, tabIds: [...target.tabIds, id], activeTabId: id },
        },
        activeRegionId: targetRid,
        panelMode: "terminal",
      };
    }),

  closeSession: (id) =>
    set((state) => {
      const closedSession = state.sessions[id];
      const sessions = { ...state.sessions };
      delete sessions[id];

      const { regions, emptiedRegionId } = detachTab(state.regions, id);

      let layoutRoot = state.layoutRoot;
      let activeRegionId = state.activeRegionId;
      if (emptiedRegionId && layoutRoot) {
        layoutRoot = removeRegionFromTree(layoutRoot, emptiedRegionId);
        if (state.activeRegionId === emptiedRegionId) {
          activeRegionId = layoutRoot ? (collectRegionIds(layoutRoot)[0] ?? null) : null;
        }
      }

      let reservedTabNumbers = state.reservedTabNumbers;
      if (closedSession) {
        reservedTabNumbers = new Set(reservedTabNumbers);
        reservedTabNumbers.delete(closedSession.number);
      }

      return { sessions, regions, layoutRoot, activeRegionId, reservedTabNumbers };
    }),

  markExited: (id, exitCode) =>
    set((state) => {
      const existing = state.sessions[id];
      if (!existing) return {};
      return {
        sessions: { ...state.sessions, [id]: { ...existing, exited: true, exitCode } },
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

  setActiveTab: (tabId) =>
    set((state) => {
      const rid = regionOfTab(state.regions, tabId);
      if (!rid) return {};
      const region = state.regions[rid];
      if (region.activeTabId === tabId && state.activeRegionId === rid) return {};
      return {
        regions: { ...state.regions, [rid]: { ...region, activeTabId: tabId } },
        activeRegionId: rid,
      };
    }),

  setActiveRegion: (regionId) =>
    set((state) => {
      if (state.activeRegionId === regionId || !state.regions[regionId]) return {};
      return { activeRegionId: regionId };
    }),

  moveTabToNewRegion: (tabId, direction) =>
    set((state) => {
      const sourceRid = regionOfTab(state.regions, tabId);
      if (!sourceRid || !state.layoutRoot) return {};
      const source = state.regions[sourceRid];
      // Nothing to peel: a lone tab has nowhere to move to.
      if (source.tabIds.length < 2) return {};

      // Detach from the source region (it keeps its other tabs).
      const tabIds = source.tabIds.filter((t) => t !== tabId);
      const activeTabId =
        source.activeTabId === tabId ? tabIds[tabIds.length - 1] : source.activeTabId;

      // Create the new region holding just the moved tab, placed beside the
      // source along `direction`.
      const newRid = newRegionId();
      const regions = {
        ...state.regions,
        [sourceRid]: { ...source, tabIds, activeTabId },
        [newRid]: { id: newRid, tabIds: [tabId], activeTabId: tabId },
      };
      const layoutRoot = splitRegionInTree(state.layoutRoot, sourceRid, newRid, direction);

      return { regions, layoutRoot, activeRegionId: newRid };
    }),

  moveTabToRegion: (tabId, targetRegionId) =>
    set((state) => {
      const target = state.regions[targetRegionId];
      if (!target || !state.layoutRoot) return {};
      const sourceRid = regionOfTab(state.regions, tabId);
      if (!sourceRid) return {};
      // Already the sole tab of the target → nothing to do.
      if (sourceRid === targetRegionId) return {};

      // Detach from source (may empty it), then append to target.
      const { regions: detached, emptiedRegionId } = detachTab(state.regions, tabId);
      const stillTarget = detached[targetRegionId];
      if (!stillTarget) return {};
      const regions = {
        ...detached,
        [targetRegionId]: {
          ...stillTarget,
          tabIds: [...stillTarget.tabIds, tabId],
          activeTabId: tabId,
        },
      };

      let layoutRoot = state.layoutRoot;
      if (emptiedRegionId) {
        layoutRoot = removeRegionFromTree(layoutRoot, emptiedRegionId) ?? layoutRoot;
      }

      return { regions, layoutRoot, activeRegionId: targetRegionId };
    }),

  moveTabToAdjacentRegion: (tabId, side) => {
    const state = get();
    if (!state.layoutRoot) return;
    const sourceRid = regionOfTab(state.regions, tabId);
    if (!sourceRid) return;
    const neighbourRid = findAdjacentRegion(state.layoutRoot, sourceRid, side);
    if (!neighbourRid) return; // at that edge — nothing to move into
    get().moveTabToRegion(tabId, neighbourRid);
  },

  setSizes: (containerPath, index, delta) =>
    set((state) => {
      if (!state.layoutRoot) return {};
      const layoutRoot = resizeInTree(state.layoutRoot, containerPath, index, delta);
      if (layoutRoot === state.layoutRoot) return {};
      return { layoutRoot };
    }),
}));
