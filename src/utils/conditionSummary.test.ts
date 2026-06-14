import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { WorkflowCondition } from "../types";
import { conditionSummary } from "./conditionSummary";

// Minimal stand-in for the i18next `t`: returns the EN short words for the
// two text-op keys this util reads, and the key itself otherwise.
const t = ((key: string): string => {
  const map: Record<string, string> = {
    "editor.conditionSummary.contains": "contains",
    "editor.conditionSummary.regex": "matches",
  };
  return map[key] ?? key;
}) as unknown as TFunction;

function cond(
  subject: WorkflowCondition["subject"],
  op: WorkflowCondition["op"],
  value: string,
): WorkflowCondition {
  return { subject, op, value };
}

describe("conditionSummary", () => {
  it("renders comparison ops as symbols with the value", () => {
    expect(conditionSummary(cond({ kind: "stdout" }, "gt", "80"), t)).toBe(
      "> 80",
    );
    expect(conditionSummary(cond({ kind: "stdout" }, "lt", "5"), t)).toBe("< 5");
    expect(conditionSummary(cond({ kind: "exitCode" }, "eq", "0"), t)).toBe(
      "= 0",
    );
    expect(conditionSummary(cond({ kind: "exitCode" }, "ne", "0"), t)).toBe(
      "≠ 0",
    );
  });

  it("renders contains with a localized word and a quoted value", () => {
    expect(
      conditionSummary(cond({ kind: "stdout" }, "contains", "example"), t),
    ).toBe('contains "example"');
  });

  it("renders regex with a localized word and a slashed pattern", () => {
    expect(
      conditionSummary(cond({ kind: "stdout" }, "regex", "\\d+ failed"), t),
    ).toBe("matches /\\d+ failed/");
  });

  it("prefixes a named variable subject", () => {
    expect(
      conditionSummary(
        cond({ kind: "variable", name: "count" }, "gt", "80"),
        t,
      ),
    ).toBe("count > 80");
  });

  it("omits the prefix for exitCode / stdout / unnamed variable", () => {
    expect(conditionSummary(cond({ kind: "exitCode" }, "gt", "1"), t)).toBe(
      "> 1",
    );
    expect(
      conditionSummary(cond({ kind: "variable", name: "" }, "gt", "1"), t),
    ).toBe("> 1");
  });
});
