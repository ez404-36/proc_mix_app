import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { Command } from "../types";
import { getCommandDescription, getCommandName } from "./commandLabels";

function cmd(overrides: Partial<Command> = {}): Command {
  return {
    id: overrides.id ?? "c1",
    name: "Literal Name",
    script: "echo hi",
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
    runAsAdmin: false,
    ...overrides,
  };
}

/** Translator that returns the key unchanged — simulates a missing resource. */
const missingT = ((key: string) => key) as unknown as TFunction;

/** Translator that returns a fixed translated string for any key. */
const hitT = (() => "Translated") as unknown as TFunction;

describe("getCommandName", () => {
  it("returns the translated name when nameKey resolves", () => {
    expect(getCommandName(cmd({ nameKey: "cmd.name" }), hitT)).toBe(
      "Translated",
    );
  });

  it("falls back to the literal name when the translation is missing", () => {
    expect(
      getCommandName(cmd({ name: "Literal Name", nameKey: "cmd.name" }), missingT),
    ).toBe("Literal Name");
  });

  it("returns the literal name when there is no nameKey", () => {
    expect(getCommandName(cmd({ name: "Literal Name" }), hitT)).toBe(
      "Literal Name",
    );
  });
});

describe("getCommandDescription", () => {
  it("returns the translated description when descriptionKey resolves", () => {
    expect(
      getCommandDescription(cmd({ descriptionKey: "cmd.desc" }), hitT),
    ).toBe("Translated");
  });

  it("falls back to the literal description when the translation is missing", () => {
    expect(
      getCommandDescription(
        cmd({ description: "Literal Desc", descriptionKey: "cmd.desc" }),
        missingT,
      ),
    ).toBe("Literal Desc");
  });

  it("returns the literal description when there is no descriptionKey", () => {
    expect(
      getCommandDescription(cmd({ description: "Literal Desc" }), hitT),
    ).toBe("Literal Desc");
  });

  it("returns undefined when the command has no description at all", () => {
    expect(getCommandDescription(cmd({ description: undefined }), hitT)).toBe(
      undefined,
    );
  });
});
