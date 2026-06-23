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
  syncScriptDefaultsToRows,
  syncVariableDefaultToScript,
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
  it("persists BOTH defaultValue AND promptAtRuntime when the user combines them", () => {
    const spec = rowsToVariableSpecs([
      makeRow({ name: "TOKEN", promptAtRuntime: true, defaultValue: "x" }),
    ])[0];
    expect(spec).toMatchObject({
      name: "TOKEN",
      sensitive: false,
      defaultValue: "x",
      promptAtRuntime: true,
    });
  });

  it("omits defaultValue when prompting at runtime with an empty default (no pre-fill)", () => {
    const spec = rowsToVariableSpecs([
      makeRow({ name: "TOKEN", promptAtRuntime: true, defaultValue: "" }),
    ])[0];
    expect(spec).not.toHaveProperty("defaultValue");
    // promptAtRuntime is implicit when defaultValue is absent, so the
    // explicit field is omitted to keep wire payloads compact.
    expect(spec).not.toHaveProperty("promptAtRuntime");
  });

  it("keeps an explicit (even empty) defaultValue when not prompting", () => {
    const spec = rowsToVariableSpecs([
      makeRow({ name: "HOST", promptAtRuntime: false, defaultValue: "" }),
    ])[0];
    expect(spec.defaultValue).toBe("");
    expect(spec).not.toHaveProperty("promptAtRuntime");
  });

  it("omits promptAtRuntime when it agrees with the legacy convention", () => {
    // Case A: prompting with no default → promptAtRuntime is implicit.
    const a = rowsToVariableSpecs([
      makeRow({ name: "A", promptAtRuntime: true, defaultValue: "" }),
    ])[0];
    expect(a).not.toHaveProperty("promptAtRuntime");
    // Case B: not prompting with a default → no prompt is implicit.
    const b = rowsToVariableSpecs([
      makeRow({ name: "B", promptAtRuntime: false, defaultValue: "v" }),
    ])[0];
    expect(b).not.toHaveProperty("promptAtRuntime");
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

  it("round-trips: a spec with default + promptAtRuntime restores both", () => {
    const rows = specsToVariableRows([
      { name: "HOST", defaultValue: "localhost", promptAtRuntime: true },
    ]);
    expect(rows[0]).toMatchObject({
      name: "HOST",
      defaultValue: "localhost",
      promptAtRuntime: true,
    });
  });

  it("round-trips: a spec with default and no explicit prompt flag stays non-prompt (legacy)", () => {
    const rows = specsToVariableRows([
      { name: "HOST", defaultValue: "localhost" },
    ]);
    expect(rows[0]).toMatchObject({
      name: "HOST",
      defaultValue: "localhost",
      promptAtRuntime: false,
    });
  });

  it("round-trips through rowsToVariableSpecs → specsToVariableRows preserving promptAtRuntime + default", () => {
    const original = makeRow({
      name: "HOST",
      defaultValue: "localhost",
      promptAtRuntime: true,
    });
    const spec = rowsToVariableSpecs([original])[0];
    expect(spec).toBeDefined();
    if (!spec) return;
    const restored = specsToVariableRows([spec])[0];
    expect(restored).toMatchObject({
      name: "HOST",
      defaultValue: "localhost",
      promptAtRuntime: true,
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
    workingDir: "",
    promptWorkingDir: false,
    target: { kind: "local" },
    promptSshPassword: false,
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

  it("changes when the execution target changes", () => {
    expect(
      fingerprintForm({ ...base, target: { kind: "remote", alias: "prod" } }),
    ).not.toBe(fingerprintForm(base));
    expect(
      fingerprintForm({ ...base, target: { kind: "remotePrompt" } }),
    ).not.toBe(fingerprintForm(base));
  });

  it("changes when promptSshPassword toggles", () => {
    expect(
      fingerprintForm({ ...base, promptSshPassword: true }),
    ).not.toBe(fingerprintForm(base));
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
      target: { kind: "local" },
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
      target: { kind: "remote", alias: "prod" },
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
      target: { kind: "remote", alias: "prod" },
    });
    expect(state.variables[0]).toMatchObject({ name: "DIR", promptAtRuntime: false });
  });

  it("defaults a command with no target to local in edit mode", () => {
    const command: Command = {
      id: "c2",
      name: "Local cmd",
      script: "ls",
      tags: [],
      favorite: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      runCount: 0,
      runAsAdmin: false,
    } as Command;
    const state = buildInitialState(command, "edit", tIdentity, "linux", [
      "bash",
    ]);
    expect(state.target).toEqual({ kind: "local" });
  });
});

describe("syncScriptDefaultsToRows", () => {
  it("updates row defaultValue from ${name:default} in script", () => {
    const rows = [makeRow({ name: "HOST", defaultValue: "" })];
    const result = syncScriptDefaultsToRows("ssh ${HOST:localhost}", rows);
    expect(result[0].defaultValue).toBe("localhost");
  });

  it("does not change promptAtRuntime when inline default is non-empty", () => {
    const rowTrue = makeRow({ name: "HOST", defaultValue: "", promptAtRuntime: true });
    const rowFalse = makeRow({ name: "HOST", defaultValue: "", promptAtRuntime: false });
    expect(syncScriptDefaultsToRows("ssh ${HOST:localhost}", [rowTrue])[0].promptAtRuntime).toBe(true);
    expect(syncScriptDefaultsToRows("ssh ${HOST:localhost}", [rowFalse])[0].promptAtRuntime).toBe(false);
  });

  it("sets promptAtRuntime=true when inline default is empty string", () => {
    const rows = [makeRow({ name: "HOST", defaultValue: "old", promptAtRuntime: false })];
    const result = syncScriptDefaultsToRows("ssh ${HOST:}", rows);
    expect(result[0].promptAtRuntime).toBe(true);
  });

  it("forces promptAtRuntime=true on empty inline default EVEN WHEN the row default is already empty (Bug 1)", () => {
    // Regression: the previous early-return on `inlineDefault === row.defaultValue`
    // skipped the promptAtRuntime correction. The rule "empty default ⇒ prompt
    // always" must hold regardless of whether defaultValue itself changed.
    const rows = [makeRow({ name: "HOST", defaultValue: "", promptAtRuntime: false })];
    const result = syncScriptDefaultsToRows("ssh ${HOST:}", rows);
    expect(result[0].defaultValue).toBe("");
    expect(result[0].promptAtRuntime).toBe(true);
  });

  it("leaves row unchanged when script has ${name} without inline default", () => {
    const rows = [makeRow({ name: "HOST", defaultValue: "old" })];
    const result = syncScriptDefaultsToRows("ssh ${HOST}", rows);
    expect(result[0].defaultValue).toBe("old");
  });

  it("leaves row unchanged when name does not appear in script", () => {
    const rows = [makeRow({ name: "HOST", defaultValue: "old" })];
    const result = syncScriptDefaultsToRows("echo hello", rows);
    expect(result[0].defaultValue).toBe("old");
  });

  it("returns the same row reference when nothing changes", () => {
    const rows = [makeRow({ name: "HOST", defaultValue: "localhost" })];
    const result = syncScriptDefaultsToRows("ssh ${HOST:localhost}", rows);
    expect(result[0]).toBe(rows[0]);
  });

  // Reference-equality regression: the previous implementation always
  // allocated a new array via `.map`, busting every downstream useMemo
  // keyed on `form.variables` on EVERY keystroke. On Linux this
  // saturated the GTK/IBus input queue and froze keyboard input.
  it("returns the SAME array reference when no rows need updating", () => {
    const rows = [
      makeRow({ name: "HOST", defaultValue: "localhost" }),
      makeRow({ name: "PORT", defaultValue: "22" }),
    ];
    const result = syncScriptDefaultsToRows("ssh ${HOST:localhost} ${PORT:22}", rows);
    expect(result).toBe(rows);
  });

  it("returns the SAME array reference when the script has no inline defaults", () => {
    const rows = [makeRow({ name: "HOST", defaultValue: "old" })];
    const result = syncScriptDefaultsToRows("echo no variables here", rows);
    expect(result).toBe(rows);
  });

  it("returns the SAME array reference when the script references variables without inline defaults", () => {
    const rows = [makeRow({ name: "HOST", defaultValue: "old" })];
    const result = syncScriptDefaultsToRows("ssh ${HOST}", rows);
    expect(result).toBe(rows);
  });
});

describe("syncVariableDefaultToScript", () => {
  it("replaces ${name} with ${name:default} when default is non-empty", () => {
    expect(syncVariableDefaultToScript("ssh ${HOST}", "HOST", "localhost")).toBe(
      "ssh ${HOST:localhost}",
    );
  });

  it("updates ${name:old} to ${name:new}", () => {
    expect(syncVariableDefaultToScript("ssh ${HOST:old}", "HOST", "new")).toBe(
      "ssh ${HOST:new}",
    );
  });

  it("strips the inline default when new default is empty", () => {
    expect(syncVariableDefaultToScript("ssh ${HOST:localhost}", "HOST", "")).toBe(
      "ssh ${HOST}",
    );
  });

  it("does not touch references to other variables", () => {
    expect(
      syncVariableDefaultToScript("${A:x} ${B:y}", "A", "z"),
    ).toBe("${A:z} ${B:y}");
  });

  // Reference-equality regression: the previous implementation always
  // ran a regex replace, returning a fresh string even when nothing
  // matched. Returning the same string reference lets React's setState
  // short-circuit on the script field, which matters because this
  // helper fires on every keystroke in the row's defaultValue input.
  it("returns the SAME string reference when the script doesn't reference the variable", () => {
    const script = "echo hello world";
    expect(syncVariableDefaultToScript(script, "HOST", "anything")).toBe(script);
  });

  it("returns the SAME string reference when the replacement would be a no-op", () => {
    const script = "ssh ${HOST:localhost}";
    expect(syncVariableDefaultToScript(script, "HOST", "localhost")).toBe(script);
  });
});
