import { describe, expect, it } from "vitest";

import type { Platform } from "../types/platform";
import { buildSeedsForPlatform } from "./seeds";

describe("buildSeedsForPlatform", () => {
  it.each<[Platform, string, NonNullable<import("../types").Command["shell"]>]>([
    ["linux", "ls -la ~", "bash"],
    ["macos", "ls -la ~", "zsh"],
    ["windows", "Get-ChildItem -Force ~", "powershell"],
  ])(
    "picks the %s script/shell variant for the first seed",
    (platform, script, shell) => {
      const seeds = buildSeedsForPlatform(platform);
      expect(seeds).toHaveLength(3);
      expect(seeds[0]?.script).toBe(script);
      expect(seeds[0]?.shell).toBe(shell);
    },
  );

  it("carries name/description keys, tags, favorite and runAsAdmin through", () => {
    const [first] = buildSeedsForPlatform("linux");
    expect(first?.nameKey).toBe("seeds.listHomeDir.name");
    expect(first?.descriptionKey).toBe("seeds.listHomeDir.description");
    expect(first?.tags).toEqual(["files", "demo"]);
    expect(first?.favorite).toBe(true);
    expect(first?.runAsAdmin).toBe(false);
    expect(first?.runCount).toBe(0);
    expect(first?.createdAt).toBe(first?.updatedAt);
  });

  it("produces fresh unique ids on every call", () => {
    const first = buildSeedsForPlatform("linux");
    const second = buildSeedsForPlatform("linux");
    const ids = [...first, ...second].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("falls back to a Math.random id when crypto.randomUUID is unavailable", () => {
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: undefined,
      configurable: true,
    });
    try {
      const seeds = buildSeedsForPlatform("linux");
      for (const seed of seeds) {
        expect(seed.id).toMatch(/^cmd-/);
      }
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        value: original,
        configurable: true,
      });
    }
  });
});
