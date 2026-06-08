import { describe, expect, it } from "vitest";

import {
  commandVariablesSatisfied,
  requiredVariableNames,
  seedVariableValues,
} from "./scheduleVariables";
import type { Command } from "../types";

function cmd(overrides: Partial<Command> = {}): Command {
  return {
    id: "c-1",
    name: "Greet",
    script: "echo ${name}",
    tags: [],
    favorite: false,
    createdAt: "2026-06-03T00:00:00Z",
    updatedAt: "2026-06-03T00:00:00Z",
    runCount: 0,
    runAsAdmin: false,
    ...overrides,
  };
}

describe("seedVariableValues", () => {
  it("pre-fills defaults and blanks for no-default specs", () => {
    const seed = seedVariableValues([
      { name: "withDefault", defaultValue: "hi" },
      { name: "emptyDefault", defaultValue: "" },
      { name: "noDefault" },
    ]);
    expect(seed).toEqual({
      withDefault: "hi",
      emptyDefault: "",
      noDefault: "",
    });
  });

  it("returns an empty object for no variables", () => {
    expect(seedVariableValues(undefined)).toEqual({});
  });
});

describe("requiredVariableNames", () => {
  it("returns only the specs without a default", () => {
    const names = requiredVariableNames([
      { name: "a", defaultValue: "x" },
      { name: "b", defaultValue: "" },
      { name: "c" },
    ]);
    // Empty-string default is a real default and is NOT required.
    expect(names).toEqual(["c"]);
  });
});

describe("commandVariablesSatisfied", () => {
  it("is satisfied when every no-default var has a value", () => {
    const command = cmd({ variables: [{ name: "token" }] });
    expect(commandVariablesSatisfied(command, { token: "abc" })).toBe(true);
  });

  it("is NOT satisfied when a no-default var is blank", () => {
    const command = cmd({ variables: [{ name: "token" }] });
    expect(commandVariablesSatisfied(command, { token: "" })).toBe(false);
    expect(commandVariablesSatisfied(command, { token: "   " })).toBe(false);
    expect(commandVariablesSatisfied(command, {})).toBe(false);
  });

  it("is satisfied when all vars have defaults regardless of values", () => {
    const command = cmd({
      variables: [{ name: "x", defaultValue: "" }],
    });
    expect(commandVariablesSatisfied(command, {})).toBe(true);
  });
});
