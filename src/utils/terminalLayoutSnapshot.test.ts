// Unit tests for the terminal layout snapshot algebra: live-state → snapshot
// conversion, validation, tree rebuilding, and equality.

import { describe, expect, it } from "vitest";
import type { RegionNode, TerminalRegion, TerminalSessionMeta } from "../types/terminal";
import type { LayoutSnapshotNode } from "../types/terminalLayout";
import {
  buildLayoutTree,
  buildReplaySteps,
  countSpecTabs,
  isValidSnapshot,
  layoutSnapshotEquals,
  normalizeSizes,
  posixQuote,
  snapshotFromState,
  specRegionSlots,
  terminalLayoutStateEquals,
} from "./terminalLayoutSnapshot";

const sessions: Record<string, TerminalSessionMeta> = {
  t1: { id: "t1", title: "Terminal 1", number: 1, createdAt: 1, exited: false },
  t2: { id: "t2", title: "Monitor", number: 2, createdAt: 2, exited: false },
  t3: { id: "t3", title: "Terminal 3", number: 3, createdAt: 3, exited: false },
};

function region(id: string, tabIds: string[], activeTabId = tabIds[0]): TerminalRegion {
  return { id, tabIds, activeTabId };
}

describe("snapshotFromState", () => {
  it("converts a single-region tree with tabs and last commands", () => {
    const layoutRoot: RegionNode = { type: "region", regionId: "r1" };
    const snap = snapshotFromState({
      layoutRoot,
      regions: { r1: region("r1", ["t1", "t2"], "t2") },
      sessions,
      lastCommands: { t1: "htop" },
    });
    expect(snap).toEqual({
      type: "region",
      tabs: [
        { title: "Terminal 1", lastCommand: "htop", cwd: null, remoteCommand: null },
        { title: "Monitor", lastCommand: null, cwd: null, remoteCommand: null },
      ],
      activeTabIndex: 1,
    });
  });

  it("converts a split tree preserving structure and sizes", () => {
    const layoutRoot: RegionNode = {
      type: "row",
      children: [
        { type: "region", regionId: "r1" },
        { type: "region", regionId: "r2" },
      ],
      sizes: [0.6, 0.4],
    };
    const snap = snapshotFromState({
      layoutRoot,
      regions: { r1: region("r1", ["t1"]), r2: region("r2", ["t2", "t3"]) },
      sessions,
      lastCommands: { t2: "npm test" },
    });
    expect(snap.type).toBe("row");
    if (snap.type !== "row") return;
    expect(snap.sizes).toEqual([0.6, 0.4]);
    expect(snap.children[0]).toEqual({
      type: "region",
      tabs: [{ title: "Terminal 1", lastCommand: null, cwd: null, remoteCommand: null }],
      activeTabIndex: 0,
    });
    expect(snap.children[1]).toMatchObject({ type: "region", activeTabIndex: 0 });
  });

  it("records per-window cwd and ssh connection command from descriptions", () => {
    const snap = snapshotFromState({
      layoutRoot: { type: "region", regionId: "r1" },
      regions: { r1: region("r1", ["t1", "t2"]) },
      sessions,
      lastCommands: { t2: "ls" },
      descriptions: {
        t1: { cwd: "/var/log", remoteCommand: "ssh -A deploy@prod" },
        t2: { cwd: "/tmp", remoteCommand: null },
        // t3 is not in the tree; a missing entry = unobservable.
      },
    });
    if (snap.type !== "region") throw new Error("expected region");
    expect(snap.tabs[0]).toEqual({
      title: "Terminal 1",
      lastCommand: null,
      cwd: "/var/log",
      remoteCommand: "ssh -A deploy@prod",
    });
    expect(snap.tabs[1]).toEqual({
      title: "Monitor",
      lastCommand: "ls",
      cwd: "/tmp",
      remoteCommand: null,
    });
  });
});

describe("posixQuote / buildReplaySteps", () => {
  it("posixQuote single-quotes and escapes embedded quotes", () => {
    expect(posixQuote("/opt/my app")).toBe("'/opt/my app'");
    expect(posixQuote("/it's")).toBe("'/it'\\''s'");
  });

  const tree: LayoutSnapshotNode = {
    type: "row",
    children: [
      {
        type: "region",
        tabs: [{ cwd: "/var/log", lastCommand: "htop" }],
        activeTabIndex: 0,
      },
      {
        type: "region",
        tabs: [
          { remoteCommand: "ssh -A deploy@prod", lastCommand: "kubectl get pods" },
          { cwd: "/tmp", lastCommand: null },
        ],
        activeTabIndex: 0,
      },
    ],
    sizes: [0.5, 0.5],
  };

  it("remote windows replay only the connection; local ones the last command", () => {
    const steps = buildReplaySteps(tree, (slot, tabIndex) => `s${slot}-${tabIndex}`);
    expect(steps).toEqual([
      { sessionId: "s0-0", text: "htop\r" },
      { sessionId: "s1-0", text: "ssh -A deploy@prod\r" },
      // s1-1 has no lastCommand → no write.
    ]);
  });

  it("skips windows whose session was not spawned (cap)", () => {
    const steps = buildReplaySteps(tree, (slot, tabIndex) =>
      slot === 0 && tabIndex === 0 ? "only" : undefined,
    );
    expect(steps).toEqual([{ sessionId: "only", text: "htop\r" }]);
  });
});

describe("isValidSnapshot / slots", () => {
  const validRegion: LayoutSnapshotNode = {
    type: "region",
    tabs: [{ lastCommand: "ls" }],
    activeTabIndex: 0,
  };

  it("accepts a valid tree and rejects broken shapes", () => {
    expect(isValidSnapshot(validRegion)).toBe(true);
    expect(
      isValidSnapshot({
        type: "column",
        children: [validRegion, validRegion],
        sizes: [0.5, 0.5],
      }),
    ).toBe(true);

    expect(isValidSnapshot({ type: "region", tabs: [], activeTabIndex: 0 })).toBe(false);
    expect(isValidSnapshot({ type: "row", children: [], sizes: [] })).toBe(false);
    expect(
      isValidSnapshot({ type: "row", children: [validRegion], sizes: [] }),
    ).toBe(false);
    expect(
      isValidSnapshot({ type: "row", children: [validRegion], sizes: [0, 1] }),
    ).toBe(false);
    expect(
      isValidSnapshot({
        type: "row",
        children: [validRegion, { type: "region", tabs: [], activeTabIndex: 0 }],
        sizes: [0.5, 0.5],
      }),
    ).toBe(false);
  });

  it("lists depth-first slots and total tab count", () => {
    const tree: LayoutSnapshotNode = {
      type: "column",
      children: [
        validRegion,
        { type: "region", tabs: [{}, {}, {}], activeTabIndex: 2 },
      ],
      sizes: [0.5, 0.5],
    };
    expect(specRegionSlots(tree)).toEqual([{ tabCount: 1 }, { tabCount: 3 }]);
    expect(countSpecTabs(tree)).toBe(4);
    expect(countSpecTabs(validRegion)).toBe(1);
  });
});

describe("normalizeSizes", () => {
  it("keeps sound sizes and normalizes drift", () => {
    expect(normalizeSizes([0.5, 0.5])).toEqual([0.5, 0.5]);
    const [a, b] = normalizeSizes([1, 3]);
    expect(a).toBeCloseTo(0.25);
    expect(b).toBeCloseTo(0.75);
  });

  it("redistributes non-positive sizes and recovers an all-zero list", () => {
    const [a, b, c] = normalizeSizes([0, 2, 6]);
    expect(a).toBe(0);
    expect(b).toBeCloseTo(0.25);
    expect(c).toBeCloseTo(0.75);

    const [x, y] = normalizeSizes([0, 0]);
    expect(x).toBeCloseTo(0.5);
    expect(y).toBeCloseTo(0.5);
    expect(normalizeSizes([0.5, 0.5]).reduce((s, v) => s + v)).toBeCloseTo(1);
  });
});

describe("buildLayoutTree", () => {
  it("rebuilds the live tree shape with fresh region ids in depth-first order", () => {
    const tree: LayoutSnapshotNode = {
      type: "column",
      children: [
        { type: "region", tabs: [{}], activeTabIndex: 0 },
        {
          type: "row",
          children: [
            { type: "region", tabs: [{}, {}], activeTabIndex: 1 },
            { type: "region", tabs: [{}], activeTabIndex: 0 },
          ],
          sizes: [0.7, 0.3],
        },
      ],
      sizes: [0.4, 0.6],
    };

    const slots: string[] = [];
    const built = buildLayoutTree(tree, (slot) => {
      slots.push(`r${slot}`);
      return `r${slot}`;
    });

    expect(slots).toEqual(["r0", "r1", "r2"]);
    if (built.type !== "column") throw new Error("expected column root");
    expect(built.sizes).toEqual([0.4, 0.6]);
    const row = built.children[1];
    if (row.type !== "row") throw new Error("expected row child");
    expect(row.children.map((c) => (c.type === "region" ? c.regionId : null))).toEqual([
      "r1",
      "r2",
    ]);
    expect(row.sizes[0]).toBeCloseTo(0.7);
  });

  it("degrades an invalid snapshot to a single-region tree", () => {
    const invalid: LayoutSnapshotNode = { type: "region", tabs: [], activeTabIndex: 0 };
    const built = buildLayoutTree(invalid, () => "fresh");
    expect(built).toEqual({ type: "region", regionId: "fresh" });
  });
});

describe("equality helpers", () => {
  const regionA: LayoutSnapshotNode = {
    type: "region",
    tabs: [{ title: "T", lastCommand: "ls" }],
    activeTabIndex: 0,
  };

  it("layoutSnapshotEquals is deep and key-order independent", () => {
    const reordered = {
      activeTabIndex: 0,
      tabs: [{ lastCommand: "ls", title: "T" }],
      type: "region" as const,
    };
    expect(layoutSnapshotEquals(regionA, reordered)).toBe(true);
    expect(
      layoutSnapshotEquals(regionA, { ...regionA, activeTabIndex: 1 }),
    ).toBe(false);
  });

  it("layoutSnapshotEquals treats null optional fields as omitted", () => {
    const live: LayoutSnapshotNode = {
      type: "region",
      tabs: [{ title: "T", lastCommand: "ls", cwd: null, remoteCommand: null }],
      activeTabIndex: 0,
    };
    const saved: LayoutSnapshotNode = {
      type: "region",
      tabs: [{ title: "T", lastCommand: "ls" }],
      activeTabIndex: 0,
    };
    expect(layoutSnapshotEquals(live, saved)).toBe(true);
  });

  it("terminalLayoutStateEquals compares display state and layout", () => {
    const current = {
      position: "bottom" as const,
      fullscreen: false,
      size: { height: 360 },
      layout: regionA,
    };
    expect(terminalLayoutStateEquals(current, { ...current })).toBe(true);
    expect(
      terminalLayoutStateEquals(current, { ...current, position: "left" }),
    ).toBe(false);
    expect(
      terminalLayoutStateEquals(current, { ...current, size: { height: 420 } }),
    ).toBe(false);
    expect(
      terminalLayoutStateEquals(current, { ...current, fullscreen: true }),
    ).toBe(false);
  });
});
