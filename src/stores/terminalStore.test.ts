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
