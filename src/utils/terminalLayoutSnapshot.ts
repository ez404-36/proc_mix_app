// Pure, immutable algebra for terminal layout snapshots ("макеты терминала").
//
// A snapshot is the persisted form of the Terminal panel's region tree: the
// live `RegionNode` tree (`terminalStore.layoutRoot`) stripped of volatile
// region/session ids, each saved window carrying its tab title and last typed
// command. Kept free of any Zustand/React dependency (like `regionTree.ts`)
// so it unit-tests in isolation.

import type { RegionNode, TerminalRegion, TerminalSessionMeta } from "../types/terminal";
import type {
  LayoutSnapshotContainer,
  LayoutSnapshotNode,
  LayoutSnapshotRegion,
  LayoutSnapshotTab,
  LayoutSize,
  TerminalLayoutState,
  TerminalSessionDescription,
} from "../types/terminalLayout";

/** Everything `snapshotFromState` reads out of `terminalStore` (+ the
 * backend's per-session observations fetched at save time). */
export interface SnapshotSource {
  layoutRoot: RegionNode;
  regions: Record<string, TerminalRegion>;
  sessions: Record<string, TerminalSessionMeta>;
  /** Last typed line per session id (see `terminalStore.lastCommands`). */
  lastCommands: Record<string, string>;
  /**
   * Backend observations (`terminal_describe_session`) per session id —
   * the shell cwd and the running ssh connection command. Sessions without
   * an entry (fetch failed / nothing observable) simply save without cwd.
   */
  descriptions?: Record<string, TerminalSessionDescription>;
}

/** Depth-first list of every region leaf, with its saved tab count. */
export interface SpecRegionSlot {
  tabCount: number;
}

/** Structural validation: is this snapshot safe to build a layout from? */
export function isValidSnapshot(snapshot: LayoutSnapshotNode): boolean {
  if (snapshot.type === "region") {
    return snapshot.tabs.length >= 1;
  }
  return (
    snapshot.children.length >= 1 &&
    snapshot.children.length === snapshot.sizes.length &&
    snapshot.sizes.every((s) => Number.isFinite(s) && s > 0) &&
    snapshot.children.every(isValidSnapshot)
  );
}

/** Convert the live terminal state into a persisted snapshot. */
export function snapshotFromState(source: SnapshotSource): LayoutSnapshotNode {
  return nodeFromRegionNode(source.layoutRoot, source);

  function nodeFromRegionNode(node: RegionNode, src: SnapshotSource): LayoutSnapshotNode {
    if (node.type === "region") {
      const region = src.regions[node.regionId];
      if (!region) {
        // A tree node without its region record should never happen (the
        // store keeps them in lockstep) — degrade to a single empty window
        // rather than produce an invalid snapshot.
        return emptyRegion();
      }
      const tabs = region.tabIds.map(
        (tabId): LayoutSnapshotTab => ({
          title: src.sessions[tabId]?.title ?? null,
          lastCommand: src.lastCommands[tabId] ?? null,
          cwd: src.descriptions?.[tabId]?.cwd ?? null,
          remoteCommand: src.descriptions?.[tabId]?.remoteCommand ?? null,
        }),
      );
      const rawIndex = region.tabIds.indexOf(region.activeTabId);
      const snapshot: LayoutSnapshotRegion = {
        type: "region",
        tabs,
        activeTabIndex: rawIndex >= 0 ? rawIndex : Math.max(0, tabs.length - 1),
      };
      return snapshot;
    }
    const container: LayoutSnapshotContainer = {
      type: node.type,
      children: node.children.map((child) => nodeFromRegionNode(child, src)),
      sizes: [...node.sizes],
    };
    return container;
  }

  function emptyRegion(): LayoutSnapshotRegion {
    return { type: "region", tabs: [{}], activeTabIndex: 0 };
  }
}

/** Depth-first region slots of a snapshot (apply order). */
export function specRegionSlots(snapshot: LayoutSnapshotNode): SpecRegionSlot[] {
  if (snapshot.type === "region") {
    return [{ tabCount: snapshot.tabs.length }];
  }
  return snapshot.children.flatMap(specRegionSlots);
}

/** Total saved windows (tabs) across every region of the snapshot. */
export function countSpecTabs(snapshot: LayoutSnapshotNode): number {
  return specRegionSlots(snapshot).reduce((sum, slot) => sum + slot.tabCount, 0);
}

/**
 * Normalize container fractions: drop non-positive values (redistributing
 * their share), then scale the rest to sum to exactly 1 — the `RegionNode`
 * invariant. Returns the input untouched when it is already sound.
 */
export function normalizeSizes(sizes: number[]): number[] {
  const finite = sizes.map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
  const total = finite.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    const even = 1 / Math.max(1, sizes.length);
    return sizes.map(() => even);
  }
  return finite.map((s) => s / total);
}

/**
 * Build a live `RegionNode` tree from a validated snapshot, assigning each
 * depth-first region slot a fresh id via `resolveRegionId(slotIndex)`.
 * Snapshots arriving from the DB are re-validated here: an invalid node
 * degrades to a single-region tree rather than corrupting the store.
 */
export function buildLayoutTree(
  snapshot: LayoutSnapshotNode,
  resolveRegionId: (slotIndex: number) => string,
): RegionNode {
  let nextSlot = 0;
  return build(snapshot);

  function build(node: LayoutSnapshotNode): RegionNode {
    if (node.type === "region") {
      if (!isValidSnapshot(node)) {
        // Should be unreachable (the root is validated before use); keep a
        // guaranteed-valid leaf rather than propagate a corrupt subtree.
        return { type: "region", regionId: resolveRegionId(nextSlot++) };
      }
      return { type: "region", regionId: resolveRegionId(nextSlot++) };
    }
    if (!isValidSnapshot(node)) {
      return { type: "region", regionId: resolveRegionId(nextSlot++) };
    }
    return {
      type: node.type,
      children: node.children.map((child) => build(child)),
      sizes: normalizeSizes(node.sizes),
    };
  }
}

/**
 * Single-quote a path for POSIX shell consumption (`cd '<path>'`): embedded
 * single quotes become the standard `'\''` escape. Applied to a saved
 * window's `cwd` before it is written to the PTY on apply.
 */
export function posixQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** One queued PTY write of the apply pipeline. */
export interface ReplayStep {
  sessionId: string;
  text: string;
}

/**
 * Build the per-window replay writes for an applied layout, in depth-first
 * window order:
 *   - a window saved INSIDE an ssh session (`remoteCommand`) replays ONLY
 *     its connection command — the recorded lastCommand ran REMOTELY and we
 *     cannot observe the remote state (see docs/interactive-terminal.md);
 *   - a local window replays its `lastCommand` (its saved `cwd` is applied
 *     at SPAWN time via `terminal_spawn`'s `cwd` override, not here).
 */
export function buildReplaySteps(
  spec: LayoutSnapshotNode,
  resolveSessionId: (slotIndex: number, tabIndex: number) => string | undefined,
): ReplayStep[] {
  const steps: ReplayStep[] = [];
  let slot = 0;
  const walk = (node: LayoutSnapshotNode): void => {
    if (node.type !== "region") {
      node.children.forEach(walk);
      return;
    }
    // `slot` indexes REGION leaves (same depth-first order as
    // `specRegionSlots` / `buildLayoutTree`), `tabIndex` the tabs within.
    const regionSlot = slot;
    slot += 1;
    node.tabs.forEach((tab, tabIndex) => {
      const sessionId = resolveSessionId(regionSlot, tabIndex);
      if (sessionId === undefined) return;
      if (tab.remoteCommand && tab.remoteCommand.trim() !== "") {
        steps.push({ sessionId, text: `${tab.remoteCommand}\r` });
        return;
      }
      if (tab.lastCommand && tab.lastCommand.trim() !== "") {
        steps.push({ sessionId, text: `${tab.lastCommand}\r` });
      }
    });
  };
  walk(spec);
  return steps;
}

/** Stable (key-order-independent) deep equality for snapshot values. */
export function layoutSnapshotEquals(a: LayoutSnapshotNode, b: LayoutSnapshotNode): boolean {
  return stableStringify(a) === stableStringify(b);

  function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map(stableStringify).join(",")}]`;
    }
    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([k1], [k2]) => (k1 < k2 ? -1 : k1 > k2 ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
  }
}

/** Compare the current display+layout state against a saved layout. */
export function terminalLayoutStateEquals(
  current: TerminalLayoutState,
  saved: TerminalLayoutState,
): boolean {
  return (
    current.position === saved.position &&
    current.fullscreen === saved.fullscreen &&
    layoutSizeEquals(current.size, saved.size) &&
    layoutSnapshotEquals(current.layout, saved.layout)
  );
}

function layoutSizeEquals(a: LayoutSize, b: LayoutSize): boolean {
  return (a.height ?? null) === (b.height ?? null) && (a.width ?? null) === (b.width ?? null);
}
