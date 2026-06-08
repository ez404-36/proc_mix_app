import { describe, expect, it } from "vitest";
import type { DuplicateMatch, DuplicateKind } from "./importDuplicates";
import type { Command } from "../types";
import {
  resolveImportSelection,
  type DuplicateChoice,
} from "./importSelection";

function existing(id: string, name = `existing-${id}`): Command {
  return {
    id,
    name,
    script: "echo hi",
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
    runAsAdmin: false,
  };
}

function match(kind: DuplicateKind, existingId: string): DuplicateMatch {
  return { kind, existing: existing(existingId) };
}

/** Build a `choiceFor` from a plain map (default rename for absent ids). */
function choices(map: Record<string, DuplicateChoice>) {
  return (id: string): DuplicateChoice => map[id] ?? "rename";
}

describe("resolveImportSelection", () => {
  it("imports a non-duplicate command as a new copy", () => {
    const result = resolveImportSelection({
      commands: [{ id: "c1", name: "Fresh" }],
      workflowIds: [],
      forcedCommandIds: new Set(),
      duplicates: new Map(),
      choiceFor: choices({}),
      existingNames: [],
    });
    expect([...result.commandIds]).toEqual(["c1"]);
    expect(result.rename.size).toBe(0);
  });

  it("imports a script-only collision as a new copy without action", () => {
    const result = resolveImportSelection({
      commands: [{ id: "c1", name: "Fresh" }],
      workflowIds: [],
      forcedCommandIds: new Set(),
      duplicates: new Map([["c1", match("script", "E1")]]),
      // Even if some choice leaked in, a script-only collision ignores it.
      choiceFor: choices({ c1: "skip" }),
      existingNames: ["Other"],
    });
    expect([...result.commandIds]).toEqual(["c1"]);
    expect(result.rename.size).toBe(0);
  });

  it("renames a kept name-duplicate to a unique name", () => {
    const result = resolveImportSelection({
      commands: [{ id: "c1", name: "Deploy" }],
      workflowIds: [],
      forcedCommandIds: new Set(),
      duplicates: new Map([["c1", match("name", "E1")]]),
      choiceFor: choices({ c1: "rename" }),
      existingNames: ["Deploy"],
    });
    expect([...result.commandIds]).toEqual(["c1"]);
    expect(result.rename.get("c1")).toBe("Deploy (2)");
  });

  it("drops a skipped non-forced name-duplicate", () => {
    const result = resolveImportSelection({
      commands: [{ id: "c1", name: "Deploy" }],
      workflowIds: [],
      forcedCommandIds: new Set(),
      duplicates: new Map([["c1", match("name", "E1")]]),
      choiceFor: choices({ c1: "skip" }),
      existingNames: ["Deploy"],
    });
    expect([...result.commandIds]).toEqual([]);
    expect(result.rename.size).toBe(0);
  });

  it("renames a forced name-duplicate even when the choice is skip", () => {
    // A workflow depends on c1, so it cannot be dropped — policy falls back to
    // importing it under a fresh name.
    const result = resolveImportSelection({
      commands: [{ id: "c1", name: "Deploy" }],
      workflowIds: ["w1"],
      forcedCommandIds: new Set(["c1"]),
      duplicates: new Map([["c1", match("name", "E1")]]),
      choiceFor: choices({ c1: "skip" }),
      existingNames: ["Deploy"],
    });
    expect([...result.commandIds]).toEqual(["c1"]);
    expect(result.rename.get("c1")).toBe("Deploy (2)");
  });

  it("mints distinct names for two duplicates of the same base", () => {
    const result = resolveImportSelection({
      commands: [
        { id: "c1", name: "Deploy" },
        { id: "c2", name: "Deploy" },
      ],
      workflowIds: [],
      forcedCommandIds: new Set(),
      duplicates: new Map([
        ["c1", match("name", "E1")],
        ["c2", match("name", "E1")],
      ]),
      choiceFor: choices({ c1: "rename", c2: "rename" }),
      existingNames: ["Deploy"],
    });
    expect(result.rename.get("c1")).toBe("Deploy (2)");
    expect(result.rename.get("c2")).toBe("Deploy (3)");
  });

  it("passes the workflow ids through unchanged", () => {
    const result = resolveImportSelection({
      commands: [],
      workflowIds: ["w1", "w2"],
      forcedCommandIds: new Set(),
      duplicates: new Map(),
      choiceFor: choices({}),
      existingNames: [],
    });
    expect([...result.workflowIds].sort()).toEqual(["w1", "w2"]);
  });

  it("handles a mix of fresh, renamed, script-only, and skipped commands", () => {
    const result = resolveImportSelection({
      commands: [
        { id: "fresh", name: "Fresh" },
        { id: "nameDup", name: "Deploy" },
        { id: "scriptDup", name: "Unrelated" },
        { id: "skipDup", name: "Build" },
      ],
      workflowIds: [],
      forcedCommandIds: new Set(),
      duplicates: new Map([
        ["nameDup", match("name", "ED")],
        ["scriptDup", match("script", "ES")],
        ["skipDup", match("name", "EB")],
      ]),
      choiceFor: choices({ nameDup: "rename", skipDup: "skip" }),
      existingNames: ["Deploy", "Build"],
    });
    expect([...result.commandIds].sort()).toEqual([
      "fresh",
      "nameDup",
      "scriptDup",
    ]);
    expect([...result.rename.entries()]).toEqual([["nameDup", "Deploy (2)"]]);
  });
});
