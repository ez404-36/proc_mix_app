import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvRow, VariableRow } from "../types/commandForm";
import {
  envRowsToRecord,
  makeRowId,
  parseScriptDefaults,
  parseTimeoutSeconds,
  rowsToVariableSpecs,
  syncScriptDefaultsToRows,
  syncVariableDefaultToScript,
} from "./commandFormState";

function varRow(overrides: Partial<VariableRow> = {}): VariableRow {
  return {
    rowId: "r1",
    name: "TARGET",
    defaultValue: "",
    description: "",
    sensitive: false,
    promptAtRuntime: false,
    nameTouched: false,
    ...overrides,
  };
}

function envRow(key: string, value: string, rowId = key): EnvRow {
  return { rowId, key, value };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("makeRowId", () => {
  it("uses crypto.randomUUID when available", () => {
    const spy = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue("11111111-1111-1111-1111-111111111111");
    expect(makeRowId()).toBe("11111111-1111-1111-1111-111111111111");
    expect(spy).toHaveBeenCalled();
  });

  it("falls back to a timestamp-random id when randomUUID is unavailable", () => {
    const original = globalThis.crypto;
    // Replace crypto with an object lacking randomUUID to hit the fallback.
    vi.stubGlobal("crypto", {} as Crypto);
    try {
      const id = makeRowId();
      expect(id).toMatch(/^var-\d+-[a-z0-9]+$/);
    } finally {
      vi.stubGlobal("crypto", original);
    }
  });
});

describe("parseTimeoutSeconds", () => {
  it("returns undefined for empty, non-numeric, non-positive, or non-integer input", () => {
    expect(parseTimeoutSeconds("")).toBeUndefined();
    expect(parseTimeoutSeconds("  ")).toBeUndefined();
    expect(parseTimeoutSeconds("abc")).toBeUndefined();
    expect(parseTimeoutSeconds("0")).toBeUndefined();
    expect(parseTimeoutSeconds("-5")).toBeUndefined();
    expect(parseTimeoutSeconds("1.5")).toBeUndefined();
  });

  it("returns the integer for a valid positive whole number", () => {
    expect(parseTimeoutSeconds(" 30 ")).toBe(30);
  });
});

describe("envRowsToRecord", () => {
  it("returns undefined when every row is empty-keyed", () => {
    expect(envRowsToRecord([envRow("", "x"), envRow("  ", "y")])).toBeUndefined();
  });

  it("builds a record from non-empty rows, trimming keys, last-wins on dupes", () => {
    expect(
      envRowsToRecord([
        envRow(" FOO ", "1", "a"),
        envRow("BAR", "2", "b"),
        envRow("FOO", "3", "c"),
      ]),
    ).toEqual({ FOO: "3", BAR: "2" });
  });
});

describe("parseScriptDefaults", () => {
  it("collects only references that carry a colon-default", () => {
    const map = parseScriptDefaults("${A:one} ${B} ${C:}");
    expect(map.get("A")).toBe("one");
    expect(map.get("C")).toBe("");
    expect(map.has("B")).toBe(false);
  });
});

describe("syncScriptDefaultsToRows", () => {
  it("returns the same array reference when the script has no inline defaults", () => {
    const rows = [varRow({ name: "A" })];
    expect(syncScriptDefaultsToRows("${A}", rows)).toBe(rows);
  });

  it("updates a row default and forces prompt for an empty inline default", () => {
    const rows = [varRow({ name: "A", promptAtRuntime: false })];
    const next = syncScriptDefaultsToRows("${A:}", rows);
    expect(next[0].defaultValue).toBe("");
    expect(next[0].promptAtRuntime).toBe(true);
  });

  it("applies a non-empty inline default without touching an explicit prompt choice", () => {
    const rows = [varRow({ name: "A", defaultValue: "", promptAtRuntime: true })];
    const next = syncScriptDefaultsToRows("${A:hello}", rows);
    expect(next[0].defaultValue).toBe("hello");
    expect(next[0].promptAtRuntime).toBe(true);
  });

  it("returns the original array when nothing actually changed", () => {
    const rows = [varRow({ name: "A", defaultValue: "hello", promptAtRuntime: false })];
    expect(syncScriptDefaultsToRows("${A:hello}", rows)).toBe(rows);
  });

  it("leaves rows whose name is not referenced untouched", () => {
    const rows = [varRow({ name: "OTHER", defaultValue: "keep" })];
    expect(syncScriptDefaultsToRows("${A:hello}", rows)).toBe(rows);
  });
});

describe("syncVariableDefaultToScript", () => {
  it("returns the exact same string when the variable is not referenced", () => {
    const script = "echo done";
    expect(syncVariableDefaultToScript(script, "A", "x")).toBe(script);
  });

  it("rewrites references to carry a new non-empty default", () => {
    expect(syncVariableDefaultToScript("${A} ${A:old}", "A", "new")).toBe(
      "${A:new} ${A:new}",
    );
  });

  it("strips the default when the new value is empty", () => {
    expect(syncVariableDefaultToScript("${A:old}", "A", "")).toBe("${A}");
  });

  it("returns the original script when no replacement changes anything", () => {
    const script = "${A:same}";
    expect(syncVariableDefaultToScript(script, "A", "same")).toBe(script);
  });

  it("does not touch a different variable that shares a prefix substring", () => {
    // The script references AB, not A; the includes() fast path still runs
    // because "${A" is a substring, but the replace callback leaves AB alone.
    expect(syncVariableDefaultToScript("${AB:x}", "A", "new")).toBe("${AB:x}");
  });
});

describe("rowsToVariableSpecs", () => {
  it("persists an explicit default when the user is not prompted", () => {
    const [spec] = rowsToVariableSpecs([
      varRow({ name: "A", defaultValue: "", promptAtRuntime: false }),
    ]);
    expect(spec).toEqual({ name: "A", sensitive: false, defaultValue: "" });
  });

  it("encodes a prompted spec with an empty default as no default", () => {
    const [spec] = rowsToVariableSpecs([
      varRow({ name: "A", defaultValue: "", promptAtRuntime: true }),
    ]);
    expect(spec.defaultValue).toBeUndefined();
    expect(spec.promptAtRuntime).toBeUndefined();
  });

  it("persists promptAtRuntime only when there is a default AND a prompt", () => {
    const [spec] = rowsToVariableSpecs([
      varRow({ name: "A", defaultValue: "pre", promptAtRuntime: true }),
    ]);
    expect(spec.defaultValue).toBe("pre");
    expect(spec.promptAtRuntime).toBe(true);
  });

  it("includes a trimmed non-empty description", () => {
    const [spec] = rowsToVariableSpecs([
      varRow({ name: "A", description: "  a note  " }),
    ]);
    expect(spec.description).toBe("  a note  ");
  });
});
