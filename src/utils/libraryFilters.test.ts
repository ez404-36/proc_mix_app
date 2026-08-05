import { describe, expect, it } from "vitest";
import { filterEntities } from "./libraryFilters";

interface Item {
  id: string;
  name: string;
  tags: string[];
  categoryId?: string;
}

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: overrides.id ?? "i1",
    name: "Item",
    tags: [],
    ...overrides,
  };
}

const matchesName = (i: Item, query: string): boolean => {
  if (query.trim() === "") return true;
  return i.name.toLowerCase().includes(query.trim().toLowerCase());
};

describe("filterEntities", () => {
  const items = [
    item({ id: "a", name: "Deploy app", tags: ["ci", "ship"], categoryId: "Build" }),
    item({ id: "b", name: "Run tests", tags: ["ci"], categoryId: "Build" }),
    item({ id: "c", name: "Open shell", tags: ["util"], categoryId: "Network" }),
    item({ id: "d", name: "Backup db", tags: [], categoryId: undefined }),
  ];

  it("delegates query matching to the caller-supplied predicate", () => {
    const out = filterEntities(items, { query: "deploy", tags: [] }, matchesName);
    expect(out.map((i) => i.id)).toEqual(["a"]);
  });

  it("empty query + no tags + no category returns everything", () => {
    const out = filterEntities(items, { query: "", tags: [] }, matchesName);
    expect(out.map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("tag filter uses ANY semantics (union of selected tags)", () => {
    const out = filterEntities(
      items,
      { query: "", tags: ["ship", "util"] },
      matchesName,
    );
    expect(out.map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("tag filter is case-insensitive", () => {
    const out = filterEntities(items, { query: "", tags: ["CI"] }, matchesName);
    expect(out.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("category filter is an exact match", () => {
    const out = filterEntities(
      items,
      { query: "", tags: [], category: "Network" },
      matchesName,
    );
    expect(out.map((i) => i.id)).toEqual(["c"]);
  });

  it("blank category is treated as no category filter", () => {
    const out = filterEntities(
      items,
      { query: "", tags: [], category: "   " },
      matchesName,
    );
    expect(out.map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("combines query AND tags AND category with AND", () => {
    const out = filterEntities(
      items,
      { query: "run", tags: ["ci"], category: "Build" },
      matchesName,
    );
    expect(out.map((i) => i.id)).toEqual(["b"]);
  });
});
