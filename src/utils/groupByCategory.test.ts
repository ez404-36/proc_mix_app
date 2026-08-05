import { describe, expect, it } from "vitest";
import { groupEntitiesByCategory } from "./groupByCategory";

interface Item {
  id: string;
  name: string;
  categoryId?: string;
}

function item(overrides: Partial<Item> = {}): Item {
  return { id: overrides.id ?? "i1", name: "Item", ...overrides };
}

const byName = (items: Item[]): Item[] =>
  [...items].sort((a, b) => a.name.localeCompare(b.name));

describe("groupEntitiesByCategory", () => {
  it("buckets items by categoryId, sorting each bucket via the supplied sortFn", () => {
    const items = [
      item({ id: "a", name: "Zeta", categoryId: "Build" }),
      item({ id: "b", name: "Alpha", categoryId: "Build" }),
      item({ id: "c", name: "Mid", categoryId: "Network" }),
    ];
    const groups = groupEntitiesByCategory(items, byName, "Uncategorized");
    expect(groups.map((g) => g.key)).toEqual(["Build", "Network"]);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(["b", "a"]);
    expect(groups[1]?.items.map((i) => i.id)).toEqual(["c"]);
  });

  it("real categories are sorted case-insensitively by name", () => {
    const items = [
      item({ id: "a", categoryId: "zeta" }),
      item({ id: "b", categoryId: "Alpha" }),
    ];
    const groups = groupEntitiesByCategory(items, byName, "Uncategorized");
    expect(groups.map((g) => g.key)).toEqual(["Alpha", "zeta"]);
  });

  it("items with a blank/undefined categoryId fall into the uncategorized bucket, always last", () => {
    const items = [
      item({ id: "a", categoryId: "Build" }),
      item({ id: "b", categoryId: undefined }),
      item({ id: "c", categoryId: "  " }),
    ];
    const groups = groupEntitiesByCategory(items, byName, "Uncategorized");
    expect(groups.map((g) => g.key)).toEqual(["Build", ""]);
    expect(groups[1]?.label).toBe("Uncategorized");
    expect(groups[1]?.items.map((i) => i.id)).toEqual(["b", "c"]);
  });

  it("returns an empty array for an empty input", () => {
    expect(groupEntitiesByCategory([], byName, "Uncategorized")).toEqual([]);
  });
});
