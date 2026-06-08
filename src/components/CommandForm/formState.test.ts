import { describe, expect, it } from "vitest";
import type { Command } from "../../types";
import {
  buildInitialState,
  buildShellOptions,
  computeVariableErrors,
  fingerprintForm,
  parseTimeoutSeconds,
  pickCreateModeShell,
  rowsToVariableSpecs,
  specsToVariableRows,
} from "./formState";
import type { FormState, VariableRow } from "./formState";

/**
 * Unit tests for the pure form-state helpers extracted from CommandForm.
 * Behavioural tests for the full form (rendering, live-run, save flow)
 * live in CommandForm.test.tsx.
 */

const tIdentity = ((key: string) => key) as never;

function makeRow(over: Partial<VariableRow> = {}): VariableRow {
  return {
    rowId: "r",
    name: "FOO",
    defaultValue: "",
    description: "",
    sensitive: false,
    promptAtRuntime: false,
    nameTouched: true,
    ...over,
  };
}

describe("pickCreateModeShell", () => {
  it("prefers the platform default when installed", () => {
    expect(pickCreateModeShell("macos", ["bash", "zsh"])).toBe("zsh");
    expect(pickCreateModeShell("windows", ["powershell", "cmd"])).toBe(
      "powershell",
    );
  });

  it("falls back to the first detected shell when the default is absent", () => {
    expect(pickCreateModeShell("macos", ["bash", "sh"])).toBe("bash");
  });

  it("returns the platform default when nothing is detected", () => {
    expect(pickCreateModeShell("linux", [])).toBe("bash");
    expect(pickCreateModeShell("windows", [])).toBe("powershell");
  });
});

describe("buildShellOptions", () => {
  it("lists detected shells in order", () => {
    const opts = buildShellOptions("bash", ["bash", "zsh"], "(n/a)");
    expect(opts).toEqual([
      { value: "bash", label: "bash" },
      { value: "zsh", label: "zsh" },
    ]);
  });

  it("prepends the current value as a disabled option when not installed", () => {
    const opts = buildShellOptions("fish", ["bash", "zsh"], "(not available)");
    expect(opts[0]).toEqual({
      value: "fish",
      label: "fish (not available)",
      disabled: true,
    });
    expect(opts.slice(1)).toEqual([
      { value: "bash", label: "bash" },
      { value: "zsh", label: "zsh" },
    ]);
  });
});

describe("computeVariableErrors", () => {
  it("flags an empty or invalid name", () => {
    expect(computeVariableErrors([makeRow({ name: "" })])).toEqual([
      "invalidName",
    ]);
    expect(computeVariableErrors([makeRow({ name: "1bad" })])).toEqual([
      "invalidName",
    ]);
  });

  it("flags the second occurrence of a duplicate name (first-wins)", () => {
    const rows = [makeRow({ name: "X" }), makeRow({ name: "X" })];
    expect(computeVariableErrors(rows)).toEqual([undefined, "duplicateName"]);
  });

  it("treats names case-sensitively", () => {
    const rows = [makeRow({ name: "FOO" }), makeRow({ name: "foo" })];
    expect(computeVariableErrors(rows)).toEqual([undefined, undefined]);
  });
});

describe("rowsToVariableSpecs / specsToVariableRows", () => {
  it("omits defaultValue when prompting at runtime", () => {
    const spec = rowsToVariableSpecs([
      makeRow({ name: "TOKEN", promptAtRuntime: true, defaultValue: "x" }),
    ])[0];
    expect(spec).not.toHaveProperty("defaultValue");
    expect(spec).toMatchObject({ name: "TOKEN", sensitive: false });
  });

  it("keeps an explicit (even empty) defaultValue", () => {
    const spec = rowsToVariableSpecs([
      makeRow({ name: "HOST", promptAtRuntime: false, defaultValue: "" }),
    ])[0];
    expect(spec.defaultValue).toBe("");
  });

  it("includes a non-blank description only", () => {
    const withDesc = rowsToVariableSpecs([makeRow({ description: "hi" })])[0];
    expect(withDesc.description).toBe("hi");
    const noDesc = rowsToVariableSpecs([makeRow({ description: "  " })])[0];
    expect(noDesc).not.toHaveProperty("description");
  });

  it("round-trips: a missing defaultValue spec becomes a prompt row", () => {
    const rows = specsToVariableRows([{ name: "PW", sensitive: true }]);
    expect(rows[0]).toMatchObject({
      name: "PW",
      sensitive: true,
      promptAtRuntime: true,
      defaultValue: "",
      nameTouched: true,
    });
  });
});

describe("parseTimeoutSeconds", () => {
  it("returns undefined for blank, zero, negative, or non-integer", () => {
    expect(parseTimeoutSeconds("")).toBeUndefined();
    expect(parseTimeoutSeconds("0")).toBeUndefined();
    expect(parseTimeoutSeconds("-5")).toBeUndefined();
    expect(parseTimeoutSeconds("1.5")).toBeUndefined();
    expect(parseTimeoutSeconds("abc")).toBeUndefined();
  });

  it("parses a positive integer (trimming whitespace)", () => {
    expect(parseTimeoutSeconds("  30 ")).toBe(30);
  });
});

describe("fingerprintForm", () => {
  const base: FormState = {
    name: "n",
    description: "d",
    script: "echo",
    shell: "bash",
    tags: ["a"],
    category: "cat",
    runAsAdmin: false,
    variables: [makeRow({ name: "V", defaultValue: "1" })],
    timeoutSeconds: "10",
    disableHints: false,
    outputSchema: undefined,
    envRows: [],
  };

  it("is stable for identical persisted fields", () => {
    expect(fingerprintForm(base)).toBe(fingerprintForm({ ...base }));
  });

  it("ignores disableHints (session-only)", () => {
    expect(fingerprintForm({ ...base, disableHints: true })).toBe(
      fingerprintForm(base),
    );
  });

  it("ignores per-row rowId and nameTouched", () => {
    const moved: FormState = {
      ...base,
      variables: [
        makeRow({ name: "V", defaultValue: "1", rowId: "z", nameTouched: false }),
      ],
    };
    expect(fingerprintForm(moved)).toBe(fingerprintForm(base));
  });

  it("changes when a persisted field changes", () => {
    expect(fingerprintForm({ ...base, name: "other" })).not.toBe(
      fingerprintForm(base),
    );
  });
});

describe("buildInitialState", () => {
  it("creates an empty non-elevated state in create mode", () => {
    const state = buildInitialState(null, "create", tIdentity, "linux", [
      "bash",
    ]);
    expect(state).toMatchObject({
      name: "",
      script: "",
      shell: "bash",
      runAsAdmin: false,
      variables: [],
      timeoutSeconds: "",
    });
  });

  it("hydrates from a command in edit mode", () => {
    const command: Command = {
      id: "c1",
      name: "My cmd",
      script: "ls",
      shell: "zsh",
      tags: ["t"],
      categoryId: "Tools",
      runAsAdmin: true,
      variables: [{ name: "DIR", sensitive: false, defaultValue: "/" }],
      timeoutSeconds: 5,
    } as Command;
    const state = buildInitialState(command, "edit", tIdentity, "macos", [
      "zsh",
    ]);
    expect(state).toMatchObject({
      name: "My cmd",
      script: "ls",
      shell: "zsh",
      category: "Tools",
      runAsAdmin: true,
      timeoutSeconds: "5",
    });
    expect(state.variables[0]).toMatchObject({ name: "DIR", promptAtRuntime: false });
  });
});
