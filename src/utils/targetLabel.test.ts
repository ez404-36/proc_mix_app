import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import {
  formatTargetBadge,
  isRemoteTarget,
  resolveTarget,
} from "./targetLabel";

// Minimal i18n stub: returns the defaultValue with {{alias}} interpolated, so
// the assertions don't depend on the real translation catalogue.
const tStub = ((_key: string, opts?: Record<string, unknown>): string => {
  const def = String(opts?.defaultValue ?? "");
  const alias = opts?.alias;
  return alias !== undefined ? def.replace("{{alias}}", String(alias)) : def;
}) as unknown as TFunction;

describe("resolveTarget", () => {
  it("treats undefined as local", () => {
    expect(resolveTarget(undefined)).toEqual({ kind: "local" });
  });

  it("returns a concrete target unchanged", () => {
    expect(resolveTarget({ kind: "remote", alias: "x" })).toEqual({
      kind: "remote",
      alias: "x",
    });
  });
});

describe("isRemoteTarget", () => {
  it("is false for undefined and local", () => {
    expect(isRemoteTarget(undefined)).toBe(false);
    expect(isRemoteTarget({ kind: "local" })).toBe(false);
  });

  it("is true for remote and remotePrompt", () => {
    expect(isRemoteTarget({ kind: "remote", alias: "h" })).toBe(true);
    expect(isRemoteTarget({ kind: "remotePrompt" })).toBe(true);
  });
});

describe("formatTargetBadge", () => {
  it("returns an empty string for local / undefined", () => {
    expect(formatTargetBadge(undefined, tStub)).toBe("");
    expect(formatTargetBadge({ kind: "local" }, tStub)).toBe("");
  });

  it("includes the alias for a remote target", () => {
    expect(formatTargetBadge({ kind: "remote", alias: "prod" }, tStub)).toBe(
      "Remote: prod",
    );
  });

  it("labels a remotePrompt target", () => {
    expect(formatTargetBadge({ kind: "remotePrompt" }, tStub)).toBe(
      "Remote (ask at run time)",
    );
  });
});
