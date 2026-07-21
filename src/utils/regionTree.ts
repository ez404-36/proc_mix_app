// Pure, immutable operations on the Terminal panel's REGION LAYOUT TREE
// (`RegionNode`, see `types/terminal.ts`). These back the tree-mutating
// actions on `terminalStore` but are kept here — free of any Zustand/React
// dependency — so the recursive tree algebra can be unit-tested in isolation.
//
// Every function returns a NEW tree (or `null`) and never mutates its input,
// so the store can hand results straight to `set(...)` and React's
// referential-equality checks re-render exactly the changed subtree.
//
// Invariant maintained by all of these: for a container node,
// `children.length === sizes.length` and `sizes` sums to 1 (within float
// error). `RegionLayout` renders each child's `flex-basis` from it.

import type { RegionContainer, RegionNode, SplitDirection } from "../types/terminal";

/**
 * A spatial direction for "move to the existing neighbouring region"
 * (`findAdjacentRegion`). `"left"`/`"right"` traverse `row` containers,
 * `"up"`/`"down"` traverse `column` containers — mapping the on-screen axis
 * to the tree orientation that lays regions along it.
 */
export type RegionSide = "left" | "right" | "up" | "down";

/** Smallest fraction a region may shrink to via a `setSizes` drag, so a
 *  terminal is never collapsed to a zero-size PTY. Enforced in
 *  {@link resizeChildren}; a pixel `min-width`/`min-height` in CSS is the
 *  visual backstop. */
export const MIN_REGION_FRACTION = 0.1;

function isContainer(node: RegionNode): node is RegionContainer {
  return node.type === "row" || node.type === "column";
}

/** Every region id appearing as a leaf anywhere in `node`, in reading order. */
export function collectRegionIds(node: RegionNode): string[] {
  if (node.type === "region") return [node.regionId];
  return node.children.flatMap(collectRegionIds);
}

/** Whether `node` contains a leaf for `regionId` anywhere. */
export function treeContainsRegion(node: RegionNode, regionId: string): boolean {
  if (node.type === "region") return node.regionId === regionId;
  return node.children.some((c) => treeContainsRegion(c, regionId));
}

/**
 * Insert `newRegionId` as a NEW region beside the region `targetRegionId`,
 * along `direction` (the new region placed AFTER the target). This is the
 * "Move right" (`row`) / "Move down" (`column`) operation.
 *
 * If the target's PARENT container already has the same orientation as
 * `direction`, the new region is inserted as a SIBLING there (so repeatedly
 * peeling tabs off in the same direction yields evenly-sized regions in one
 * container, not a lopsided nest); the two regions that came from the one
 * target share its former fraction equally, other siblings keep theirs.
 * Otherwise the target leaf is replaced by a new container of the two at
 * 50/50.
 *
 * Returns a new tree, or the input unchanged if `targetRegionId` is absent.
 */
export function splitRegionInTree(
  node: RegionNode,
  targetRegionId: string,
  newRegionId: string,
  direction: SplitDirection,
): RegionNode {
  if (node.type === "region") {
    if (node.regionId !== targetRegionId) return node;
    return {
      type: direction,
      children: [node, { type: "region", regionId: newRegionId }],
      sizes: [0.5, 0.5],
    };
  }

  const directIdx = node.children.findIndex(
    (c) => c.type === "region" && c.regionId === targetRegionId,
  );
  if (directIdx !== -1 && node.type === direction) {
    return insertSiblingRegion(node, directIdx, newRegionId);
  }

  let changed = false;
  const children = node.children.map((child) => {
    if (changed || !treeContainsRegion(child, targetRegionId)) return child;
    changed = true;
    return splitRegionInTree(child, targetRegionId, newRegionId, direction);
  });
  if (!changed) return node;
  return { ...node, children };
}

/** Insert a new region right after `node.children[idx]`, splitting that
 *  child's fraction in half between the two so siblings are untouched. */
function insertSiblingRegion(
  node: RegionContainer,
  idx: number,
  newRegionId: string,
): RegionContainer {
  const newLeaf: RegionNode = { type: "region", regionId: newRegionId };
  const half = node.sizes[idx] / 2;
  const children = [...node.children];
  const sizes = [...node.sizes];
  children.splice(idx + 1, 0, newLeaf);
  sizes.splice(idx, 1, half, half);
  return { ...node, children, sizes };
}

/**
 * Remove the region leaf `regionId` from the tree. When its parent container
 * is left with a single child, that container COLLAPSES into the child,
 * recursively. Returns the new tree, or `null` if removing the region empties
 * the whole tree (no regions left — the panel is empty). Returns the input
 * unchanged if `regionId` is absent.
 */
export function removeRegionFromTree(node: RegionNode, regionId: string): RegionNode | null {
  if (node.type === "region") {
    return node.regionId === regionId ? null : node;
  }

  let changed = false;
  const kept: RegionNode[] = [];
  const keptSizes: number[] = [];
  node.children.forEach((child, i) => {
    const next = removeRegionFromTree(child, regionId);
    if (next === null) {
      changed = true;
      return;
    }
    if (next !== child) changed = true;
    kept.push(next);
    keptSizes.push(node.sizes[i]);
  });

  if (!changed) return node;
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];
  return { ...node, children: kept, sizes: normalize(keptSizes) };
}

/** Re-scale a fraction list so it sums to 1 (after a child was removed). */
function normalize(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= 0) return sizes.map(() => 1 / sizes.length);
  return sizes.map((s) => s / total);
}

/**
 * Apply a resize drag on the border between children `index` and `index+1`
 * of the container identified by `containerPath` (child indices from the root
 * to that container; empty = the root). `delta` is the fraction of the
 * container's extent to move from the right child into the left. Clamped so
 * neither drops below {@link MIN_REGION_FRACTION}. Returns a new tree (input
 * unchanged if the path/index is invalid).
 */
export function resizeInTree(
  node: RegionNode,
  containerPath: number[],
  index: number,
  delta: number,
): RegionNode {
  if (containerPath.length === 0) {
    if (!isContainer(node)) return node;
    const sizes = resizeChildren(node.sizes, index, delta);
    if (sizes === node.sizes) return node;
    return { ...node, sizes };
  }
  if (!isContainer(node)) return node;
  const [head, ...rest] = containerPath;
  const child = node.children[head];
  if (!child) return node;
  const nextChild = resizeInTree(child, rest, index, delta);
  if (nextChild === child) return node;
  const children = [...node.children];
  children[head] = nextChild;
  return { ...node, children };
}

function resizeChildren(sizes: number[], index: number, delta: number): number[] {
  if (index < 0 || index + 1 >= sizes.length) return sizes;
  const left = sizes[index];
  const right = sizes[index + 1];
  const pair = left + right;
  let nextLeft = left + delta;
  nextLeft = Math.max(MIN_REGION_FRACTION, Math.min(pair - MIN_REGION_FRACTION, nextLeft));
  const nextRight = pair - nextLeft;
  if (nextLeft === left) return sizes;
  const next = [...sizes];
  next[index] = nextLeft;
  next[index + 1] = nextRight;
  return next;
}

/** The child-index path from the root to the `region` leaf `regionId`, or
 *  null if absent. `[]` means the root itself is that leaf. */
function pathToRegion(node: RegionNode, regionId: string): number[] | null {
  if (node.type === "region") return node.regionId === regionId ? [] : null;
  for (let i = 0; i < node.children.length; i += 1) {
    const sub = pathToRegion(node.children[i], regionId);
    if (sub !== null) return [i, ...sub];
  }
  return null;
}

/** Follow a child-index path from the root, returning the node there (or null
 *  if the path runs off the tree). */
function nodeAtPath(node: RegionNode, path: number[]): RegionNode | null {
  let current: RegionNode = node;
  for (const idx of path) {
    if (current.type === "region") return null;
    const child = current.children[idx];
    if (!child) return null;
    current = child;
  }
  return current;
}

/** Descend into `node` toward the side we CAME FROM, to land on the region
 *  visually nearest the origin. When moving `right`/`down` we entered the
 *  neighbour from its start, so take the FIRST child at each `row`/`column`
 *  step (the leftmost/topmost); when moving `left`/`up`, take the LAST. Steps
 *  through the OTHER orientation always take the first child (any is fine —
 *  pick a stable one). */
function descendToNearestRegion(node: RegionNode, side: RegionSide): string {
  let current = node;
  while (current.type !== "region") {
    const matchesAxis =
      (current.type === "row" && (side === "left" || side === "right")) ||
      (current.type === "column" && (side === "up" || side === "down"));
    const takeLast = matchesAxis && (side === "left" || side === "up");
    current = takeLast ? current.children[current.children.length - 1] : current.children[0];
  }
  return current.regionId;
}

/**
 * The region id of the existing region immediately ADJACENT to `regionId` on
 * the given `side`, or null if there is none (the region is at that edge).
 *
 * Walks from the region's leaf up toward the root; at the first ancestor
 * container whose orientation matches the side's axis (`row` for left/right,
 * `column` for up/down) AND where the branch we came up through has a sibling
 * on that side, it steps into that sibling and descends to the region nearest
 * the origin (tmux `select-pane -L/-R/-U/-D`).
 */
export function findAdjacentRegion(
  root: RegionNode,
  regionId: string,
  side: RegionSide,
): string | null {
  const path = pathToRegion(root, regionId);
  if (path === null) return null;

  const wantRow = side === "left" || side === "right";
  const towardEnd = side === "right" || side === "down"; // sibling at index+1

  // Walk ancestors from the deepest (the region's parent) up to the root.
  for (let depth = path.length - 1; depth >= 0; depth -= 1) {
    const ancestorPath = path.slice(0, depth);
    const ancestor = nodeAtPath(root, ancestorPath);
    if (!ancestor || ancestor.type === "region") continue;
    const orientationMatches = wantRow ? ancestor.type === "row" : ancestor.type === "column";
    if (!orientationMatches) continue;

    const childIndex = path[depth];
    const siblingIndex = towardEnd ? childIndex + 1 : childIndex - 1;
    if (siblingIndex < 0 || siblingIndex >= ancestor.children.length) continue; // at the edge here

    // Found a sibling on the requested side — descend into it.
    return descendToNearestRegion(ancestor.children[siblingIndex], side);
  }
  return null;
}
