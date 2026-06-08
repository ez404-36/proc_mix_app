import { describe, expect, it } from "vitest";
import type { Command } from "../types";
import { findDuplicate, findImportDuplicates } from "./importDuplicates";
import type { ExportedCommand } from "./dataTransfer";

function existing(
  id: string,
  name: string,
  script: string,
): Command {
  return {
    id,
    name,
    script,
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
    runAsAdmin: false,
  };
}

function candidate(
  id: string,
  name: string,
  script: string,
): ExportedCommand {
  return { id, name, script, tags: [], runAsAdmin: false };
}

describe("findDuplicate", () => {
  const library = [
    existing("e1", "Build", "npm run build"),
    existing("e2", "Deploy", "npm run deploy"),
  ];

  it("returns null when nothing matches", () => {
    expect(findDuplicate(candidate("c1", "Brand New", "echo hi"), library)).toBe(
      null,
    );
  });

  it("flags a name collision with kind 'name'", () => {
    const match = findDuplicate(
      candidate("c1", "Build", "different script"),
      library,
    );
    expect(match?.kind).toBe("name");
    expect(match?.existing.id).toBe("e1");
  });

  it("flags a script-only collision (different name) with kind 'script'", () => {
    const match = findDuplicate(
      candidate("c1", "Other name", "npm run deploy"),
      library,
    );
    expect(match?.kind).toBe("script");
    expect(match?.existing.id).toBe("e2");
  });

  it("treats a same-name-and-same-script match as kind 'name'", () => {
    const match = findDuplicate(
      candidate("c1", "Build", "npm run build"),
      library,
    );
    expect(match?.kind).toBe("name");
    expect(match?.existing.id).toBe("e1");
  });

  it("matches names case-insensitively and trimmed", () => {
    const match = findDuplicate(
      candidate("c1", "  bUiLd  ", "echo hi"),
      library,
    );
    expect(match?.kind).toBe("name");
    expect(match?.existing.id).toBe("e1");
  });

  it("matches scripts case-insensitively and trimmed", () => {
    const match = findDuplicate(
      candidate("c1", "Unrelated", "  NPM run Deploy "),
      library,
    );
    expect(match?.kind).toBe("script");
    expect(match?.existing.id).toBe("e2");
  });

  it("does not match on an empty name or script", () => {
    const blankLibrary = [existing("e1", "", "")];
    expect(findDuplicate(candidate("c1", "", ""), blankLibrary)).toBe(null);
  });

  it("prefers a name collision over an earlier script-only collision", () => {
    const lib = [
      existing("script-only", "Something else", "shared-script"),
      existing("name-hit", "Target", "unrelated"),
    ];
    const match = findDuplicate(
      candidate("c1", "Target", "shared-script"),
      lib,
    );
    // Name collision wins even though the script-only one comes first.
    expect(match?.kind).toBe("name");
    expect(match?.existing.id).toBe("name-hit");
  });
});

describe("findImportDuplicates", () => {
  it("maps only the colliding imported command ids", () => {
    const library = [existing("e1", "Build", "npm run build")];
    const map = findImportDuplicates(
      [
        candidate("c1", "Build", "x"), // collides by name
        candidate("c2", "Fresh", "y"), // no match
      ],
      library,
    );
    expect([...map.keys()]).toEqual(["c1"]);
    expect(map.get("c1")?.kind).toBe("name");
    expect(map.get("c1")?.existing.id).toBe("e1");
  });
});
