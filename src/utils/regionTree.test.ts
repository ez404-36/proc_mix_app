// Unit tests for the pure region-layout-tree algebra (`utils/regionTree.ts`).

import { describe, expect, it } from "vitest";
import type { RegionContainer, RegionNode } from "../types/terminal";
import {
  MIN_REGION_FRACTION,
  collectRegionIds,
  findAdjacentRegion,
  removeRegionFromTree,
  resizeInTree,
  splitRegionInTree,
  treeContainsRegion,
} from "./regionTree";

const region = (id: string): RegionNode => ({ type: "region", regionId: id });

describe("splitRegionInTree", () => {
  it("wraps a root region into a container at 50/50", () => {
    expect(splitRegionInTree(region("a"), "a", "b", "row")).toEqual({
      type: "row",
      children: [region("a"), region("b")],
      sizes: [0.5, 0.5],
    });
  });

  it("inserts a sibling when the parent orientation matches", () => {
    const start: RegionNode = {
      type: "row",
      children: [region("a"), region("b")],
      sizes: [0.5, 0.5],
    };
    const tree = splitRegionInTree(start, "a", "c", "row") as RegionContainer;
    expect(tree.children).toEqual([region("a"), region("c"), region("b")]);
    expect(tree.sizes).toEqual([0.25, 0.25, 0.5]);
  });

  it("nests a new container when orientation differs", () => {
    const start: RegionNode = {
      type: "row",
      children: [region("a"), region("b")],
      sizes: [0.5, 0.5],
    };
    const tree = splitRegionInTree(start, "a", "c", "column") as RegionContainer;
    expect(tree.type).toBe("row");
    expect(tree.children[0]).toEqual({
      type: "column",
      children: [region("a"), region("c")],
      sizes: [0.5, 0.5],
    });
    expect(tree.children[1]).toEqual(region("b"));
  });

  it("returns the input unchanged when the target is absent", () => {
    const start = region("a");
    expect(splitRegionInTree(start, "zzz", "b", "row")).toBe(start);
  });
});

describe("removeRegionFromTree", () => {
  it("collapses a 2-child container into the survivor", () => {
    const start: RegionNode = {
      type: "row",
      children: [region("a"), region("b")],
      sizes: [0.3, 0.7],
    };
    expect(removeRegionFromTree(start, "a")).toEqual(region("b"));
  });

  it("keeps a 3-child container and renormalises sizes", () => {
    const start: RegionNode = {
      type: "row",
      children: [region("a"), region("b"), region("c")],
      sizes: [0.5, 0.25, 0.25],
    };
    const tree = removeRegionFromTree(start, "a") as RegionContainer;
    expect(tree.children).toEqual([region("b"), region("c")]);
    expect(tree.sizes[0]).toBeCloseTo(0.5);
    expect(tree.sizes[1]).toBeCloseTo(0.5);
  });

  it("returns null when the last region is removed", () => {
    expect(removeRegionFromTree(region("a"), "a")).toBeNull();
  });

  it("collapses nested lone containers recursively", () => {
    const start: RegionNode = {
      type: "row",
      children: [
        { type: "column", children: [region("a"), region("b")], sizes: [0.5, 0.5] },
        region("c"),
      ],
      sizes: [0.5, 0.5],
    };
    const tree = removeRegionFromTree(start, "b") as RegionContainer;
    expect(tree.children).toEqual([region("a"), region("c")]);
  });
});

describe("resizeInTree", () => {
  const base: RegionNode = {
    type: "row",
    children: [region("a"), region("b")],
    sizes: [0.5, 0.5],
  };

  it("moves fraction from the right region to the left on positive delta", () => {
    const tree = resizeInTree(base, [], 0, 0.2) as RegionContainer;
    expect(tree.sizes[0]).toBeCloseTo(0.7);
    expect(tree.sizes[1]).toBeCloseTo(0.3);
  });

  it("clamps so neither region drops below MIN_REGION_FRACTION", () => {
    const tree = resizeInTree(base, [], 0, 5) as RegionContainer;
    expect(tree.sizes[0]).toBeCloseTo(1 - MIN_REGION_FRACTION);
    expect(tree.sizes[1]).toBeCloseTo(MIN_REGION_FRACTION);
  });

  it("targets a nested container via its path", () => {
    const start: RegionNode = {
      type: "row",
      children: [
        region("a"),
        { type: "column", children: [region("b"), region("c")], sizes: [0.5, 0.5] },
      ],
      sizes: [0.5, 0.5],
    };
    const tree = resizeInTree(start, [1], 0, 0.2) as RegionContainer;
    const nested = tree.children[1] as RegionContainer;
    expect(nested.sizes[0]).toBeCloseTo(0.7);
    expect(tree.sizes).toEqual([0.5, 0.5]);
  });

  it("returns the input unchanged for an invalid path", () => {
    expect(resizeInTree(base, [9], 0, 0.1)).toBe(base);
  });
});

describe("traversal helpers", () => {
  const tree: RegionNode = {
    type: "row",
    children: [
      region("a"),
      { type: "column", children: [region("b"), region("c")], sizes: [0.5, 0.5] },
    ],
    sizes: [0.5, 0.5],
  };

  it("collectRegionIds returns every region in reading order", () => {
    expect(collectRegionIds(tree)).toEqual(["a", "b", "c"]);
  });

  it("treeContainsRegion finds nested regions", () => {
    expect(treeContainsRegion(tree, "c")).toBe(true);
    expect(treeContainsRegion(tree, "zzz")).toBe(false);
  });
});

describe("findAdjacentRegion", () => {
  // A simple horizontal row: [a | b | c].
  const row: RegionNode = {
    type: "row",
    children: [region("a"), region("b"), region("c")],
    sizes: [1 / 3, 1 / 3, 1 / 3],
  };

  it("finds left/right neighbours in a row", () => {
    expect(findAdjacentRegion(row, "b", "left")).toBe("a");
    expect(findAdjacentRegion(row, "b", "right")).toBe("c");
  });

  it("returns null at the row edges", () => {
    expect(findAdjacentRegion(row, "a", "left")).toBeNull();
    expect(findAdjacentRegion(row, "c", "right")).toBeNull();
    // No vertical neighbours in a pure row.
    expect(findAdjacentRegion(row, "b", "up")).toBeNull();
    expect(findAdjacentRegion(row, "b", "down")).toBeNull();
  });

  it("crosses orientation levels (grid layout)", () => {
    // Left column = a; right side is a column of [b over c].
    //   [ a | (b / c) ]
    const grid: RegionNode = {
      type: "row",
      children: [
        region("a"),
        { type: "column", children: [region("b"), region("c")], sizes: [0.5, 0.5] },
      ],
      sizes: [0.5, 0.5],
    };
    // From b: left → a (up one level to the row), down → c.
    expect(findAdjacentRegion(grid, "b", "left")).toBe("a");
    expect(findAdjacentRegion(grid, "b", "down")).toBe("c");
    expect(findAdjacentRegion(grid, "b", "up")).toBeNull();
    // From a: right → the nearest region of the right column, which is b (top).
    expect(findAdjacentRegion(grid, "a", "right")).toBe("b");
  });

  it("returns null for an unknown region", () => {
    expect(findAdjacentRegion(row, "zzz", "left")).toBeNull();
  });
});
