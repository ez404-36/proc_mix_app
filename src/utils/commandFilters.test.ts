import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { Command } from "../types";
import {
  collectCategories,
  collectTags,
  commandsForWorkflowScope,
  filterCommands,
  globalCommands,
  isGlobalCommand,
  localCommandsForWorkflow,
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

describe("scope helpers", () => {
  const globalA = cmd({ id: "g1" });
  const globalUndefined = cmd({ id: "g2", scope: undefined });
  const localOfW1 = cmd({ id: "l1", scope: "local", workflowId: "w1" });
  const localOfW2 = cmd({ id: "l2", scope: "local", workflowId: "w2" });
  const all = [globalA, globalUndefined, localOfW1, localOfW2];

  it("isGlobalCommand treats undefined and 'global' scope as global", () => {
    expect(isGlobalCommand(globalA)).toBe(true);
    expect(isGlobalCommand(globalUndefined)).toBe(true);
    expect(isGlobalCommand(localOfW1)).toBe(false);
  });

  it("globalCommands drops every local command", () => {
    expect(globalCommands(all).map((c) => c.id)).toEqual(["g1", "g2"]);
  });

  it("commandsForWorkflowScope shows globals + THIS workflow's locals only", () => {
    expect(commandsForWorkflowScope(all, "w1").map((c) => c.id)).toEqual([
      "g1",
      "g2",
      "l1",
    ]);
    // Other workflows' locals (l2) are hidden.
    expect(commandsForWorkflowScope(all, "w2").map((c) => c.id)).toEqual([
      "g1",
      "g2",
      "l2",
    ]);
  });

  it("commandsForWorkflowScope on a new (null) workflow shows only globals", () => {
    expect(commandsForWorkflowScope(all, null).map((c) => c.id)).toEqual([
      "g1",
      "g2",
    ]);
  });

  it("localCommandsForWorkflow returns ONLY this workflow's locals", () => {
    expect(localCommandsForWorkflow(all, "w1").map((c) => c.id)).toEqual(["l1"]);
    expect(localCommandsForWorkflow(all, "w2").map((c) => c.id)).toEqual(["l2"]);
  });

  it("localCommandsForWorkflow is empty for a new (null) workflow", () => {
    expect(localCommandsForWorkflow(all, null)).toEqual([]);
  });
});
