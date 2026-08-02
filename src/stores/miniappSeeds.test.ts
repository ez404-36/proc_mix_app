import { describe, expect, it } from "vitest";

import type { Platform } from "../types/platform";
import { buildMiniAppSeedsForPlatform } from "./miniappSeeds";

const PLATFORMS: Platform[] = ["linux", "macos", "windows"];

describe("buildMiniAppSeedsForPlatform", () => {
  it("ships at least one seed on EVERY platform", () => {
    for (const platform of PLATFORMS) {
      expect(buildMiniAppSeedsForPlatform(platform).length).toBeGreaterThan(0);
    }
  });

  it("ships the cross-platform System Info panel everywhere, unrestricted", () => {
    for (const platform of PLATFORMS) {
      const seeds = buildMiniAppSeedsForPlatform(platform);
      const systemInfo = seeds.find(
        (s) => s.nameKey === "miniapps.seeds.systemInfo.name",
      );
      expect(systemInfo).toBeDefined();
      // No `os` restriction — it must never be filtered out by platform.
      expect(systemInfo?.os).toBeUndefined();
      expect(systemInfo?.descriptionKey).toBe(
        "miniapps.seeds.systemInfo.description",
      );
    }
  });

  it("gives every System Info widget a platform-appropriate script", () => {
    for (const platform of PLATFORMS) {
      const systemInfo = buildMiniAppSeedsForPlatform(platform).find(
        (s) => s.nameKey === "miniapps.seeds.systemInfo.name",
      );
      for (const widget of systemInfo?.widgets ?? []) {
        if (widget.kind === "status") {
          expect(widget.source.kind).toBe("inline");
          if (widget.source.kind === "inline") {
            expect(widget.source.script.length).toBeGreaterThan(0);
          }
        }
        if (widget.kind === "button") {
          expect(widget.action.kind).toBe("inline");
          if (widget.action.kind === "inline") {
            expect(widget.action.script.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("ships the Linux-only openvpn3 panel only on Linux", () => {
    const isOpenvpn = (nameKey: string | undefined): boolean =>
      nameKey === "miniapps.seeds.openvpn3.name";
    expect(
      buildMiniAppSeedsForPlatform("linux").some((s) => isOpenvpn(s.nameKey)),
    ).toBe(true);
    expect(
      buildMiniAppSeedsForPlatform("macos").some((s) => isOpenvpn(s.nameKey)),
    ).toBe(false);
    expect(
      buildMiniAppSeedsForPlatform("windows").some((s) => isOpenvpn(s.nameKey)),
    ).toBe(false);
  });

  it("never gives an artifact a self-referencing value (the R2 regression)", () => {
    for (const platform of PLATFORMS) {
      for (const seed of buildMiniAppSeedsForPlatform(platform)) {
        for (const widget of seed.widgets) {
          if (widget.kind !== "artifact") continue;
          // `value: "${configPath}"` on an artifact NAMED `configPath` is a
          // self-reference that renders the literal template into the script.
          expect(widget.value).not.toContain(`\${${widget.name}}`);
        }
      }
    }
  });

  it("gives every artifact a valid, referenceable name", () => {
    for (const platform of PLATFORMS) {
      for (const seed of buildMiniAppSeedsForPlatform(platform)) {
        for (const widget of seed.widgets) {
          if (widget.kind !== "artifact") continue;
          expect(widget.name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
        }
      }
    }
  });

  it("declares an i18n key pair on every seed", () => {
    for (const platform of PLATFORMS) {
      for (const seed of buildMiniAppSeedsForPlatform(platform)) {
        expect(seed.nameKey).toBeDefined();
        expect(seed.descriptionKey).toBeDefined();
        // The literal fallbacks stay populated for the pre-i18n-load paint.
        expect(seed.name.length).toBeGreaterThan(0);
        expect(seed.description?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it("mints fresh widget ids on every call", () => {
    const a = buildMiniAppSeedsForPlatform("linux");
    const b = buildMiniAppSeedsForPlatform("linux");
    const idsA = a.flatMap((s) => s.widgets.map((w) => w.id));
    const idsB = b.flatMap((s) => s.widgets.map((w) => w.id));
    expect(idsA).toHaveLength(new Set(idsA).size);
    expect(idsA.some((id) => idsB.includes(id))).toBe(false);
  });
});
