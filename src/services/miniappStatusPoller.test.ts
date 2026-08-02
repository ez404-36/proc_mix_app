import { describe, expect, it } from "vitest";

import type { StatusMapping } from "../types";
import {
  applyStatusMapping,
  backoffIntervalMs,
  MAX_BACKOFF_MS,
  STATUS_PROBE_FAILED_KEY,
  STATUS_UNMATCHED_KEY,
} from "./miniappStatusPoller";
import type { StatusProbeResult } from "./miniappStatusPoller";

/** Build a succeeded probe with the given extracted values. */
function succeeded(overrides: Partial<StatusProbeResult> = {}): StatusProbeResult {
  return {
    status: "succeeded",
    exitCode: 0,
    fields: {},
    returnValue: null,
    stdoutTail: null,
    ...overrides,
  };
}

const RAW_MAPPING: StatusMapping = { mode: "raw" };

describe("applyStatusMapping — error / status gating", () => {
  it("returns a TRANSLATION KEY, never a pre-formatted English string", () => {
    const result = applyStatusMapping(
      succeeded({ status: "failed", exitCode: 2 }),
      RAW_MAPPING,
    );
    expect(result).toEqual({
      state: "error",
      messageKey: STATUS_PROBE_FAILED_KEY,
      params: { status: "failed" },
      detail: "failed",
    });
    // Regression guard for S8: the old implementation returned a raw English
    // literal. Nothing user-facing may be produced by this module.
    expect(result).not.toHaveProperty("message");
  });

  it("carries the raw backend status only as a debugging `detail`", () => {
    const result = applyStatusMapping(
      succeeded({ status: "cancelled", exitCode: null }),
      RAW_MAPPING,
    );
    expect(result.state).toBe("error");
    if (result.state === "error") {
      expect(result.messageKey).toBe(STATUS_PROBE_FAILED_KEY);
      expect(result.detail).toBe("cancelled");
    }
  });
});

describe("backoffIntervalMs — failure backoff schedule", () => {
  it("returns the configured interval while there are no failures", () => {
    expect(backoffIntervalMs(5000, 0)).toBe(5000);
  });

  it("doubles on each consecutive failure", () => {
    expect(backoffIntervalMs(5000, 1)).toBe(10000);
    expect(backoffIntervalMs(5000, 2)).toBe(20000);
    expect(backoffIntervalMs(5000, 3)).toBe(40000);
  });

  it("resets to the configured interval on success (failures back to 0)", () => {
    expect(backoffIntervalMs(5000, 4)).toBe(80000);
    expect(backoffIntervalMs(5000, 0)).toBe(5000);
  });

  it("clamps at the maximum backoff", () => {
    expect(backoffIntervalMs(5000, 20)).toBe(MAX_BACKOFF_MS);
    expect(backoffIntervalMs(60000, 99)).toBe(MAX_BACKOFF_MS);
  });

  it("applies the 1s floor to the base interval before backing off", () => {
    expect(backoffIntervalMs(10, 0)).toBe(1000);
    expect(backoffIntervalMs(10, 2)).toBe(4000);
  });

  it("treats a negative failure count as no failures", () => {
    expect(backoffIntervalMs(5000, -1)).toBe(5000);
  });
});

describe("applyStatusMapping — value extraction priority", () => {
  it("reads returnValue by default in raw mode", () => {
    const result = applyStatusMapping(
      succeeded({ returnValue: "connected" }),
      RAW_MAPPING,
    );
    expect(result).toEqual({
      state: "ok",
      label: "connected",
      rawValue: "connected",
    });
  });

  it("reads fields[field] when mapping.field is set", () => {
    const result = applyStatusMapping(
      succeeded({ fields: { sessionState: "running" }, returnValue: "ignored" }),
      { mode: "raw", field: "sessionState" },
    );
    expect(result).toEqual({
      state: "ok",
      label: "running",
      rawValue: "running",
    });
  });

  it("falls back to returnValue when mapping.field is absent from fields", () => {
    const result = applyStatusMapping(
      succeeded({
        fields: { other: "x" },
        returnValue: "fallback",
      }),
      { mode: "raw", field: "missing" },
    );
    expect(result.state).toBe("ok");
    if (result.state === "ok") {
      expect(result.label).toBe("fallback");
      expect(result.rawValue).toBe("fallback");
    }
  });

  it("falls back to stdoutTail when neither field nor returnValue exist", () => {
    const result = applyStatusMapping(
      succeeded({ stdoutTail: "  connected\n" }),
      RAW_MAPPING,
    );
    expect(result).toEqual({
      state: "ok",
      label: "connected",
      rawValue: "  connected\n",
    });
  });

  it("falls back to stdoutTail when field is set but missing and returnValue is null", () => {
    const result = applyStatusMapping(
      succeeded({ stdoutTail: "disconnected" }),
      { mode: "raw", field: "missing" },
    );
    expect(result.state).toBe("ok");
    if (result.state === "ok") expect(result.label).toBe("disconnected");
  });

  it("yields an empty label when nothing was extracted", () => {
    const result = applyStatusMapping(succeeded(), RAW_MAPPING);
    expect(result).toEqual({ state: "ok", label: "", rawValue: null });
  });
});

describe("applyStatusMapping — value stringification", () => {
  it("stringifies a numeric returnValue", () => {
    const result = applyStatusMapping(
      succeeded({ returnValue: 42 }),
      RAW_MAPPING,
    );
    expect(result.state).toBe("ok");
    if (result.state === "ok") {
      expect(result.label).toBe("42");
      expect(result.rawValue).toBe(42);
    }
  });

  it("stringifies a boolean returnValue", () => {
    const result = applyStatusMapping(
      succeeded({ returnValue: true }),
      RAW_MAPPING,
    );
    expect(result.state).toBe("ok");
    if (result.state === "ok") expect(result.label).toBe("true");
  });

  it("JSON-encodes an object returnValue", () => {
    const result = applyStatusMapping(
      succeeded({ returnValue: { a: 1, b: "x" } }),
      RAW_MAPPING,
    );
    expect(result.state).toBe("ok");
    if (result.state === "ok") expect(result.label).toBe('{"a":1,"b":"x"}');
  });

  it("stringifies a numeric field value", () => {
    const result = applyStatusMapping(
      succeeded({ fields: { count: 7 } }),
      { mode: "raw", field: "count" },
    );
    expect(result.state).toBe("ok");
    if (result.state === "ok") expect(result.label).toBe("7");
  });
});

describe("applyStatusMapping — mapped mode", () => {
  const MAPPED: StatusMapping = {
    mode: "mapped",
    field: "state",
    rules: [
      { match: "connected", label: "Connected", color: "#22c55e" },
      { match: "disconnected", label: "Disconnected" },
    ],
  };

  it("returns the matching rule's label and color", () => {
    const result = applyStatusMapping(
      succeeded({ fields: { state: "connected" } }),
      MAPPED,
    );
    expect(result).toEqual({
      state: "ok",
      label: "Connected",
      color: "#22c55e",
      rawValue: "connected",
    });
  });

  it("returns the matching rule's label without color when omitted", () => {
    const result = applyStatusMapping(
      succeeded({ fields: { state: "disconnected" } }),
      MAPPED,
    );
    expect(result).toEqual({
      state: "ok",
      label: "Disconnected",
      rawValue: "disconnected",
    });
  });

  it("falls back to `unmatched` (short raw value shown as-is) when no rule matches", () => {
    const result = applyStatusMapping(
      succeeded({ fields: { state: "connecting" } }),
      MAPPED,
    );
    expect(result).toEqual({
      state: "unmatched",
      label: "connecting",
      rawValue: "connecting",
      rawString: "connecting",
    });
  });

  it("treats an empty rules array as 'no match' → unmatched fallback", () => {
    const result = applyStatusMapping(
      succeeded({ returnValue: "idle" }),
      { mode: "mapped" },
    );
    expect(result.state).toBe("unmatched");
    if (result.state === "unmatched") expect(result.label).toBe("idle");
  });

  it("uses the FIRST matching rule when duplicates exist", () => {
    const result = applyStatusMapping(
      succeeded({ returnValue: "x" }),
      {
        mode: "mapped",
        rules: [
          { match: "x", label: "First", color: "#111" },
          { match: "x", label: "Second", color: "#222" },
        ],
      },
    );
    expect(result.state).toBe("ok");
    if (result.state === "ok") {
      expect(result.label).toBe("First");
      expect(result.color).toBe("#111");
    }
  });

  it("trims surrounding whitespace before matching", () => {
    const result = applyStatusMapping(
      succeeded({ stdoutTail: "  connected  " }),
      {
        mode: "mapped",
        rules: [{ match: "connected", label: "Connected" }],
      },
    );
    expect(result.state).toBe("ok");
    if (result.state === "ok") expect(result.label).toBe("Connected");
  });
});

describe("applyStatusMapping — matchMode strategies", () => {
  const OPENVPN3_OUTPUT = [
    "1: /net/openvpn/v3/sessions/abc123",
    "    Config name: office-vpn",
    "    Created: 2026-08-01 10:00:00",
    "    Status: Connection, Client connected",
    "    Interface: tun0",
  ].join("\n");

  it("matchMode absent behaves exactly like exact equality (regression)", () => {
    const result = applyStatusMapping(succeeded({ returnValue: "connected" }), {
      mode: "mapped",
      rules: [{ match: "connected", label: "Connected" }],
    });
    expect(result).toEqual({
      state: "ok",
      label: "Connected",
      rawValue: "connected",
    });
  });

  it("matchMode: exact behaves exactly like the default (regression)", () => {
    const result = applyStatusMapping(succeeded({ returnValue: "connected" }), {
      mode: "mapped",
      rules: [{ match: "connected", matchMode: "exact", label: "Connected" }],
    });
    expect(result).toEqual({
      state: "ok",
      label: "Connected",
      rawValue: "connected",
    });
    // An exact rule does NOT match the openvpn3 multi-line block (the whole
    // reason `contains`/`regex` modes exist). The multi-line raw value must
    // NOT be dumped verbatim as the label — it collapses to the generic
    // "unmatched" message key instead, with the full text kept in `rawString`
    // for a tooltip.
    const noMatch = applyStatusMapping(
      succeeded({ stdoutTail: OPENVPN3_OUTPUT }),
      {
        mode: "mapped",
        rules: [
          { match: "Client connected", matchMode: "exact", label: "Connected" },
        ],
      },
    );
    expect(noMatch.state).toBe("unmatched");
    if (noMatch.state === "unmatched") {
      expect(noMatch.label).toBe("");
      expect(noMatch.messageKey).toBe(STATUS_UNMATCHED_KEY);
      expect(noMatch.rawString).toBe(OPENVPN3_OUTPUT);
    }
  });

  it("matchMode: contains matches a substring within a larger raw string", () => {
    const result = applyStatusMapping(
      succeeded({ stdoutTail: OPENVPN3_OUTPUT }),
      {
        mode: "mapped",
        rules: [
          {
            match: "Client connected",
            matchMode: "contains",
            label: "Connected",
            color: "#22c55e",
          },
        ],
      },
    );
    expect(result).toEqual({
      state: "ok",
      label: "Connected",
      color: "#22c55e",
      rawValue: OPENVPN3_OUTPUT,
    });
  });

  it("matchMode: regex matches a pattern against multi-line text", () => {
    const result = applyStatusMapping(
      succeeded({ stdoutTail: OPENVPN3_OUTPUT }),
      {
        mode: "mapped",
        rules: [
          {
            match: "Status:.*Client (connected|disconnected)",
            matchMode: "regex",
            label: "Connected",
          },
        ],
      },
    );
    expect(result.state).toBe("ok");
    if (result.state === "ok") expect(result.label).toBe("Connected");
  });

  it("an invalid regex pattern does not throw and simply doesn't match", () => {
    expect(() =>
      applyStatusMapping(succeeded({ returnValue: "connected" }), {
        mode: "mapped",
        rules: [
          { match: "(unterminated", matchMode: "regex", label: "Broken" },
        ],
      }),
    ).not.toThrow();
    const result = applyStatusMapping(succeeded({ returnValue: "connected" }), {
      mode: "mapped",
      rules: [{ match: "(unterminated", matchMode: "regex", label: "Broken" }],
    });
    expect(result.state).toBe("unmatched");
    if (result.state === "unmatched") expect(result.label).toBe("connected");
  });

  it("contains/regex modes respect rule order (first matching rule wins)", () => {
    const result = applyStatusMapping(
      succeeded({ stdoutTail: OPENVPN3_OUTPUT }),
      {
        mode: "mapped",
        rules: [
          { match: "Client connected", matchMode: "contains", label: "First" },
          { match: "Interface", matchMode: "contains", label: "Second" },
        ],
      },
    );
    expect(result.state).toBe("ok");
    if (result.state === "ok") expect(result.label).toBe("First");
  });
});

describe("applyStatusMapping — unmatched fallback hardening", () => {
  it("shows a short, single-line unmatched raw value as-is", () => {
    const result = applyStatusMapping(
      succeeded({ returnValue: "connecting" }),
      { mode: "mapped", rules: [{ match: "connected", label: "Connected" }] },
    );
    expect(result).toEqual({
      state: "unmatched",
      label: "connecting",
      rawValue: "connecting",
      rawString: "connecting",
    });
  });

  it("does NOT show a multi-line unmatched raw value verbatim as the label", () => {
    const multiline = "line one\nline two\nline three";
    const result = applyStatusMapping(succeeded({ returnValue: multiline }), {
      mode: "mapped",
      rules: [{ match: "connected", label: "Connected" }],
    });
    expect(result.state).toBe("unmatched");
    if (result.state === "unmatched") {
      expect(result.label).toBe("");
      expect(result.messageKey).toBe(STATUS_UNMATCHED_KEY);
      // The full raw value is still available for a debugging tooltip.
      expect(result.rawString).toBe(multiline);
    }
  });

  it("collapses a very long single-line unmatched value too, not just multi-line ones", () => {
    const longLine = "x".repeat(120);
    const result = applyStatusMapping(succeeded({ returnValue: longLine }), {
      mode: "mapped",
      rules: [{ match: "connected", label: "Connected" }],
    });
    expect(result.state).toBe("unmatched");
    if (result.state === "unmatched") {
      expect(result.label).toBe("");
      expect(result.messageKey).toBe(STATUS_UNMATCHED_KEY);
      expect(result.rawString).toBe(longLine);
    }
  });

  it("a value exactly at the display-length threshold is still shown as-is", () => {
    const exact = "a".repeat(60);
    const result = applyStatusMapping(succeeded({ returnValue: exact }), {
      mode: "mapped",
      rules: [{ match: "connected", label: "Connected" }],
    });
    expect(result).toEqual({
      state: "unmatched",
      label: exact,
      rawValue: exact,
      rawString: exact,
    });
  });

  it("a value one character over the threshold collapses to the generic label", () => {
    const overLimit = "a".repeat(61);
    const result = applyStatusMapping(succeeded({ returnValue: overLimit }), {
      mode: "mapped",
      rules: [{ match: "connected", label: "Connected" }],
    });
    expect(result.state).toBe("unmatched");
    if (result.state === "unmatched") {
      expect(result.label).toBe("");
      expect(result.messageKey).toBe(STATUS_UNMATCHED_KEY);
    }
  });

  it("does not affect a rule that DOES match (regression)", () => {
    const result = applyStatusMapping(
      succeeded({ returnValue: "connected" }),
      { mode: "mapped", rules: [{ match: "connected", label: "Connected" }] },
    );
    expect(result).toEqual({
      state: "ok",
      label: "Connected",
      rawValue: "connected",
    });
  });
});
