import { describe, expect, it } from "vitest";

import type { StatusResult } from "../services/miniappStatusPoller";
import { resolveToggleOnState } from "./miniappToggleState";

function ok(label: string, rawValue: unknown = label): StatusResult {
  return { state: "ok", label, rawValue };
}

const ERROR_RESULT: StatusResult = {
  state: "error",
  messageKey: "miniapps.runner.status.probeError",
};

describe("resolveToggleOnState — onValue configured", () => {
  it("is ON when the mapped LABEL matches onValue", () => {
    expect(resolveToggleOnState(ok("Connected", "up"), "Connected")).toEqual({
      isOn: true,
      matched: true,
    });
  });

  it("is ON when the RAW value matches onValue", () => {
    expect(resolveToggleOnState(ok("Connected", "up"), "up")).toEqual({
      isOn: true,
      matched: true,
    });
  });

  it("is OFF when a SUCCESSFUL probe reports a different value", () => {
    // The S3 regression: a `disconnected` probe still exits 0. It must NOT
    // render as ON, or clicking would fire the OFF action against an
    // already-off service.
    expect(resolveToggleOnState(ok("Disconnected"), "Connected")).toEqual({
      isOn: false,
      matched: true,
    });
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    expect(resolveToggleOnState(ok("  CONNECTED  "), "connected").isOn).toBe(
      true,
    );
    expect(resolveToggleOnState(ok("connected"), "  Connected ").isOn).toBe(
      true,
    );
  });

  it("compares a numeric raw value by its string form", () => {
    expect(resolveToggleOnState(ok("1", 1), "1").isOn).toBe(true);
    expect(resolveToggleOnState(ok("0", 0), "1").isOn).toBe(false);
  });

  it("compares a boolean raw value by its string form", () => {
    expect(resolveToggleOnState(ok("true", true), "true").isOn).toBe(true);
  });

  it("does not match a non-primitive raw value against onValue", () => {
    const result = resolveToggleOnState(
      { state: "ok", label: "obj", rawValue: { a: 1 } },
      "[object Object]",
    );
    expect(result).toEqual({ isOn: false, matched: true });
  });

  it("is OFF for a failed probe (an unreachable service is not ON)", () => {
    expect(resolveToggleOnState(ERROR_RESULT, "Connected")).toEqual({
      isOn: false,
      matched: true,
    });
  });

  it("is OFF while loading and while idle", () => {
    expect(
      resolveToggleOnState({ state: "loading" }, "Connected").isOn,
    ).toBe(false);
    expect(resolveToggleOnState({ state: "idle" }, "Connected").isOn).toBe(
      false,
    );
  });

  it("is OFF with no status result at all", () => {
    expect(resolveToggleOnState(undefined, "Connected")).toEqual({
      isOn: false,
      matched: true,
    });
  });

  it("treats a whitespace-only onValue as NOT configured", () => {
    expect(resolveToggleOnState(ok("Disconnected"), "   ")).toEqual({
      isOn: true,
      matched: false,
    });
  });
});

describe("resolveToggleOnState — no onValue (legacy heuristic)", () => {
  it("falls back to 'the probe succeeded' and reports it as unverified", () => {
    expect(resolveToggleOnState(ok("Disconnected"), undefined)).toEqual({
      isOn: true,
      matched: false,
    });
  });

  it("is OFF and unverified for a failed probe", () => {
    expect(resolveToggleOnState(ERROR_RESULT, undefined)).toEqual({
      isOn: false,
      matched: false,
    });
  });

  it("is OFF and unverified with no status result", () => {
    expect(resolveToggleOnState(undefined, undefined)).toEqual({
      isOn: false,
      matched: false,
    });
  });
});
