import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { Command } from "../types";
import {
  collectCategories,
  collectTags,
  filterCommands,
  normalizeTags,
} from "./commandFilters";

/**
 * Minimal `TFunction` stub: returns the key verbatim. Our test commands
 * use literal `name`/`description` (no `nameKey`), so `getCommandName`
 * never consults `t` — but `filterCommands` requires the parameter.
 */
const t = ((key: string) => key) as unknown as TFunction;

function cmd(overrides: Partial<Command> = {}): Command {
  return {
    id: overrides.id ?? "c1",
    name: "Build",
    script: "echo build",
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
    runAsAdmin: false,
    ...overrides,
  };
}

describe("normalizeTags", () => {
  it("trims, drops empties, and dedupes case-insensitively (first casing wins)", () => {
    expect(
      normalizeTags(["  CI  ", "ci", "", "  ", "Deploy", "deploy", "Test"]),
    ).toEqual(["CI", "Deploy", "Test"]);
  });

  it("returns an empty array for all-blank input", () => {
    expect(normalizeTags(["", "   ", "\t"])).toEqual([]);
  });
});

describe("collectTags", () => {
  it("returns unique tags sorted case-insensitively, ignoring blanks", () => {
    const commands = [
      cmd({ id: "a", tags: ["zeta", "alpha"] }),
      cmd({ id: "b", tags: ["Beta", "alpha", "  "] }),
    ];
    expect(collectTags(commands)).toEqual(["alpha", "Beta", "zeta"]);
  });

  it("returns an empty array when no command has tags", () => {
    expect(collectTags([cmd({ tags: [] })])).toEqual([]);
  });
});

describe("collectCategories", () => {
  it("returns unique categories sorted, skipping undefined/blank", () => {
    const commands = [
      cmd({ id: "a", categoryId: "Network" }),
      cmd({ id: "b", categoryId: "Build" }),
      cmd({ id: "c", categoryId: "Build" }),
      cmd({ id: "d", categoryId: undefined }),
      cmd({ id: "e", categoryId: "  " }),
    ];
    expect(collectCategories(commands)).toEqual(["Build", "Network"]);
  });
});

describe("filterCommands", () => {
  const commands = [
    cmd({ id: "a", name: "Deploy app", tags: ["ci", "ship"], categoryId: "Build" }),
    cmd({ id: "b", name: "Run tests", tags: ["ci"], categoryId: "Build" }),
    cmd({ id: "c", name: "Open shell", tags: ["util"], categoryId: "Network" }),
    cmd({ id: "d", name: "Backup db", tags: [], categoryId: undefined }),
  ];

  it("query-only matches name (case-insensitive)", () => {
    const out = filterCommands(commands, { query: "deploy", tags: [] }, t);
    expect(out.map((c) => c.id)).toEqual(["a"]);
  });

  it("query matches a tag", () => {
    const out = filterCommands(commands, { query: "util", tags: [] }, t);
    expect(out.map((c) => c.id)).toEqual(["c"]);
  });

  it("empty query + no tags + no category returns everything", () => {
    const out = filterCommands(commands, { query: "", tags: [] }, t);
    expect(out.map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("tag-only uses ANY semantics (union of selected tags)", () => {
    const out = filterCommands(commands, { query: "", tags: ["ship", "util"] }, t);
    // 'ship' → a, 'util' → c
    expect(out.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("tag filter is case-insensitive", () => {
    const out = filterCommands(commands, { query: "", tags: ["CI"] }, t);
    expect(out.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("category-only filters by exact categoryId", () => {
    const out = filterCommands(
      commands,
      { query: "", tags: [], category: "Network" },
      t,
    );
    expect(out.map((c) => c.id)).toEqual(["c"]);
  });

  it("combines query AND tags AND category with AND", () => {
    const out = filterCommands(
      commands,
      { query: "run", tags: ["ci"], category: "Build" },
      t,
    );
    expect(out.map((c) => c.id)).toEqual(["b"]);
  });

  it("blank category is treated as no category filter", () => {
    const out = filterCommands(
      commands,
      { query: "", tags: [], category: "   " },
      t,
    );
    expect(out.map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
  });
});
