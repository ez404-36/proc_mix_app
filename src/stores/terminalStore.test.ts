// Unit tests for the terminal store's REGION actions — opening tabs into
// regions, closing (collapsing empty regions), "Move right/down" peeling a
// tab into a new region, and drag-and-drop between regions.

import { beforeEach, describe, expect, it } from "vitest";
import { useTerminalStore } from "./terminalStore";
import { collectRegionIds } from "../utils/regionTree";

function reset(): void {
  useTerminalStore.setState({
    panelMode: "runs",
    sessions: {},
    regions: {},
    layoutRoot: null,
    activeRegionId: null,
    reservedTabNumbers: new Set(),
    hasAutoOpenedTab: false,
    lastCommands: {},
    inputLines: {},
  });
}

/** The single region's id after opening `n` tabs into one fresh region. */
function onlyRegionId(): string {
  const ids = Object.keys(useTerminalStore.getState().regions);
  if (ids.length !== 1) throw new Error(`expected 1 region, got ${ids.length}`);
  return ids[0];
}

describe("terminalStore region actions", () => {
  beforeEach(reset);

  it("first openSession creates the root region containing that tab", () => {
    useTerminalStore.getState().openSession("t1", "Terminal 1", 1);
    const s = useTerminalStore.getState();
    const rid = onlyRegionId();
    expect(s.regions[rid]).toEqual({ id: rid, tabIds: ["t1"], activeTabId: "t1" });
    expect(s.layoutRoot).toEqual({ type: "region", regionId: rid });
    expect(s.activeRegionId).toBe(rid);
    expect(s.panelMode).toBe("terminal");
  });

  it("subsequent openSession joins the active region", () => {
    const store = useTerminalStore.getState();
    store.openSession("t1", "Terminal 1", 1);
    store.openSession("t2", "Terminal 2", 2);
    const rid = onlyRegionId();
    expect(useTerminalStore.getState().regions[rid].tabIds).toEqual(["t1", "t2"]);
    expect(useTerminalStore.getState().regions[rid].activeTabId).toBe("t2");
  });

  it("moveTabToNewRegion peels a tab into a sibling region", () => {
    const store = useTerminalStore.getState();
    store.openSession("t1", "Terminal 1", 1);
    store.openSession("t2", "Terminal 2", 2);
    const srcRid = onlyRegionId();

    store.moveTabToNewRegion("t2", "row");
    const s = useTerminalStore.getState();
    expect(s.layoutRoot?.type).toBe("row");
    expect(collectRegionIds(s.layoutRoot!)).toHaveLength(2);
    // Source keeps t1; new region holds t2 and is active.
    expect(s.regions[srcRid].tabIds).toEqual(["t1"]);
    const newRid = collectRegionIds(s.layoutRoot!).find((r) => r !== srcRid)!;
    expect(s.regions[newRid].tabIds).toEqual(["t2"]);
    expect(s.activeRegionId).toBe(newRid);
  });

  it("moveTabToNewRegion is a no-op for a lone tab", () => {
    const store = useTerminalStore.getState();
    store.openSession("t1", "Terminal 1", 1);
    const before = useTerminalStore.getState().layoutRoot;
    store.moveTabToNewRegion("t1", "row");
    expect(useTerminalStore.getState().layoutRoot).toBe(before);
  });

  it("closing the last tab of a region removes the region and collapses the tree", () => {
    const store = useTerminalStore.getState();
    store.openSession("t1", "Terminal 1", 1);
    store.openSession("t2", "Terminal 2", 2);
    store.moveTabToNewRegion("t2", "row");
    const srcRid = Object.keys(useTerminalStore.getState().regions).find(
      (r) => useTerminalStore.getState().regions[r].tabIds.includes("t1"),
    )!;

    // Close t2 (the sole tab of the peeled region) → tree collapses to t1's
    // region alone.
    store.closeSession("t2");
    const s = useTerminalStore.getState();
    expect(s.layoutRoot).toEqual({ type: "region", regionId: srcRid });
    expect(s.sessions.t2).toBeUndefined();
    expect(s.reservedTabNumbers.has(2)).toBe(false);
  });

  it("closing the very last tab empties the panel", () => {
    const store = useTerminalStore.getState();
    store.openSession("t1", "Terminal 1", 1);
    store.closeSession("t1");
    const s = useTerminalStore.getState();
    expect(s.layoutRoot).toBeNull();
    expect(s.activeRegionId).toBeNull();
    expect(Object.keys(s.regions)).toHaveLength(0);
  });

  it("moveTabToRegion moves a tab between regions and empties the source", () => {
    const store = useTerminalStore.getState();
    store.openSession("t1", "Terminal 1", 1);
    store.openSession("t2", "Terminal 2", 2);
    store.moveTabToNewRegion("t2", "row");

    const before = useTerminalStore.getState();
    const srcRid = Object.keys(before.regions).find((r) =>
      before.regions[r].tabIds.includes("t1"),
    )!;
    const targetRid = Object.keys(before.regions).find((r) =>
      before.regions[r].tabIds.includes("t2"),
    )!;

    // Move t1 into t2's region → source region empties and disappears.
    store.moveTabToRegion("t1", targetRid);
    const s = useTerminalStore.getState();
    expect(s.regions[srcRid]).toBeUndefined();
    expect(s.regions[targetRid].tabIds).toEqual(["t2", "t1"]);
    expect(s.layoutRoot).toEqual({ type: "region", regionId: targetRid });
  });

  it("moveTabToAdjacentRegion moves a tab into the neighbour region", () => {
    const store = useTerminalStore.getState();
    // Two regions side by side: [t1 | t2], plus a spare tab t3 in the right.
    store.openSession("t1", "Terminal 1", 1);
    store.openSession("t2", "Terminal 2", 2);
    store.moveTabToNewRegion("t2", "row"); // right region = {t2}
    store.openSession("t3", "Terminal 3", 3); // joins the active (right) region

    const before = useTerminalStore.getState();
    const leftRid = Object.keys(before.regions).find((r) =>
      before.regions[r].tabIds.includes("t1"),
    )!;
    const rightRid = Object.keys(before.regions).find((r) =>
      before.regions[r].tabIds.includes("t2"),
    )!;

    // Move t3 LEFT into t1's region.
    store.moveTabToAdjacentRegion("t3", "left");
    const s = useTerminalStore.getState();
    expect(s.regions[leftRid].tabIds).toEqual(["t1", "t3"]);
    expect(s.regions[rightRid].tabIds).toEqual(["t2"]);
    expect(s.activeRegionId).toBe(leftRid);
  });

  it("moveTabToAdjacentRegion is a no-op at the edge", () => {
    const store = useTerminalStore.getState();
    store.openSession("t1", "Terminal 1", 1);
    store.openSession("t2", "Terminal 2", 2);
    store.moveTabToNewRegion("t2", "row"); // [t1 | t2]
    const before = useTerminalStore.getState().layoutRoot;
    // t1's region has no left neighbour.
    store.moveTabToAdjacentRegion("t1", "left");
    expect(useTerminalStore.getState().layoutRoot).toBe(before);
  });

  it("setSizes applies a clamped resize to the layout root", () => {
    const store = useTerminalStore.getState();
    store.openSession("t1", "Terminal 1", 1);
    store.openSession("t2", "Terminal 2", 2);
    store.moveTabToNewRegion("t2", "row");
    store.setSizes([], 0, 0.2);

    const root = useTerminalStore.getState().layoutRoot;
    if (!root || root.type === "region") throw new Error("expected a container");
    expect(root.sizes[0]).toBeCloseTo(0.7);
    expect(root.sizes[1]).toBeCloseTo(0.3);
  });
});

describe("terminalStore last-command tracking", () => {
  beforeEach(reset);

  it("commits the typed line on Enter and keeps it as the last command", () => {
    const store = useTerminalStore.getState();
    store.recordTerminalInput("t1", "htop");
    expect(useTerminalStore.getState().lastCommands.t1).toBeUndefined();
    store.recordTerminalInput("t1", "\r");
    expect(useTerminalStore.getState().lastCommands.t1).toBe("htop");
    expect(useTerminalStore.getState().inputLines.t1).toBe("");
  });

  it("handles backspace, Ctrl+U, and pasted multi-char lines", () => {
    const store = useTerminalStore.getState();
    store.recordTerminalInput("t1", "ls -la");
    store.recordTerminalInput("t1", "\x7f\x7f"); // two backspaces
    store.recordTerminalInput("t1", "z\r");
    expect(useTerminalStore.getState().lastCommands.t1).toBe("ls -z");

    store.recordTerminalInput("t1", "wrong\x15fix\r"); // Ctrl+U clears the line
    expect(useTerminalStore.getState().lastCommands.t1).toBe("fix");

    store.recordTerminalInput("t1", "echo hi\r");
    expect(useTerminalStore.getState().lastCommands.t1).toBe("echo hi");
  });

  it("drops the pending line on escape sequences and Tab (line rewritten)", () => {
    const store = useTerminalStore.getState();
    store.recordTerminalInput("t1", "git che");
    store.recordTerminalInput("t1", "\t"); // completion rewrites the line
    store.recordTerminalInput("t1", "\r");
    expect(useTerminalStore.getState().lastCommands.t1).toBeUndefined();

    store.recordTerminalInput("t1", "old");
    store.recordTerminalInput("t1", "\x1b[A"); // history recall
    store.recordTerminalInput("t1", "\r");
    expect(useTerminalStore.getState().lastCommands.t1).toBeUndefined();
  });

  it("never commits after a cancelled (Ctrl+C) line and keeps last on empty Enter", () => {
    const store = useTerminalStore.getState();
    store.recordTerminalInput("t1", "first\r");
    store.recordTerminalInput("t1", "cancelled\x03");
    store.recordTerminalInput("t1", "\r");
    expect(useTerminalStore.getState().lastCommands.t1).toBe("first");

    store.recordTerminalInput("t1", "\r");
    expect(useTerminalStore.getState().lastCommands.t1).toBe("first");
  });

  it("closeSession forgets the session's tracking state", () => {
    const store = useTerminalStore.getState();
    store.openSession("t1", "Terminal 1", 1);
    store.recordTerminalInput("t1", "htop\r");
    expect(useTerminalStore.getState().lastCommands.t1).toBe("htop");
    store.closeSession("t1");
    expect(useTerminalStore.getState().lastCommands.t1).toBeUndefined();
    expect(useTerminalStore.getState().inputLines.t1).toBeUndefined();
  });
});

describe("terminalStore.applyLayoutSnapshot", () => {
  beforeEach(reset);

  const twoByOne = {
    type: "row" as const,
    children: [
      { type: "region" as const, tabs: [{ lastCommand: "htop" }], activeTabIndex: 0 },
      { type: "region" as const, tabs: [{}, { title: "Logs", lastCommand: "tail -f" }], activeTabIndex: 1 },
    ],
    sizes: [0.5, 0.5],
  };

  it("builds sessions, regions, tree, and seeds lastCommands in one shot", () => {
    useTerminalStore.getState().openSession("stale", "Stale", 1);

    useTerminalStore.getState().applyLayoutSnapshot(twoByOne, [
      { regionSlot: 0, tabIndex: 0, sessionId: "s1", number: 1, title: "Terminal 1" },
      { regionSlot: 1, tabIndex: 0, sessionId: "s2", number: 2, title: "Terminal 2" },
      { regionSlot: 1, tabIndex: 1, sessionId: "s3", number: 3, title: "Logs" },
    ]);

    const s = useTerminalStore.getState();
    expect(Object.keys(s.sessions).sort()).toEqual(["s1", "s2", "s3"]);
    expect(s.sessions.stale).toBeUndefined();
    expect(s.panelMode).toBe("terminal");

    expect(s.layoutRoot?.type).toBe("row");
    const rids = collectRegionIds(s.layoutRoot!);
    expect(rids).toHaveLength(2);
    expect(s.regions[rids[0]].tabIds).toEqual(["s1"]);
    expect(s.regions[rids[1]].tabIds).toEqual(["s2", "s3"]);
    // Active tab per region comes from the snapshot (index 1 in the second).
    expect(s.regions[rids[1]].activeTabId).toBe("s3");
    expect(s.activeRegionId).toBe(rids[0]);

    expect(s.lastCommands).toEqual({ s1: "htop", s3: "tail -f" });
    expect(s.inputLines).toEqual({});
    expect(s.reservedTabNumbers.has(1)).toBe(true);
    expect(s.reservedTabNumbers.has(3)).toBe(true);
  });

  it("replaces a previous layout entirely", () => {
    useTerminalStore.getState().applyLayoutSnapshot(twoByOne, [
      { regionSlot: 0, tabIndex: 0, sessionId: "a", number: 1, title: "A" },
      { regionSlot: 1, tabIndex: 0, sessionId: "b", number: 2, title: "B" },
      { regionSlot: 1, tabIndex: 1, sessionId: "c", number: 3, title: "C" },
    ]);
    useTerminalStore.getState().applyLayoutSnapshot(
      { type: "region", tabs: [{}], activeTabIndex: 0 },
      [{ regionSlot: 0, tabIndex: 0, sessionId: "z", number: 4, title: "Z" }],
    );
    const s = useTerminalStore.getState();
    expect(Object.keys(s.sessions)).toEqual(["z"]);
    expect(collectRegionIds(s.layoutRoot!)).toHaveLength(1);
    expect(s.reservedTabNumbers.has(4)).toBe(true);
  });
});
