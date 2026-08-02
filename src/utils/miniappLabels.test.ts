import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";

import type { MiniApp } from "../types";
import { getMiniAppDescription, getMiniAppName } from "./miniappLabels";

function ma(overrides: Partial<MiniApp> = {}): MiniApp {
  return {
    id: "ma-1",
    name: "Literal Name",
    widgets: [],
    tags: [],
    favorite: false,
    createdAt: "2026-07-31T00:00:00Z",
    updatedAt: "2026-07-31T00:00:00Z",
    runCount: 0,
    panelSize: { w: 400, h: 320 },
    ...overrides,
  };
}

/** Resolves every key to a translated string. */
const hitT = ((key: string) => `translated:${key}`) as unknown as TFunction;
/** i18next's miss behaviour: returns the key itself. */
const missT = ((key: string) => key) as unknown as TFunction;

describe("getMiniAppName", () => {
  it("returns the translated name when nameKey resolves", () => {
    expect(getMiniAppName(ma({ nameKey: "ma.name" }), hitT)).toBe(
      "translated:ma.name",
    );
  });

  it("falls back to the literal name when the key does not resolve", () => {
    expect(getMiniAppName(ma({ nameKey: "ma.name" }), missT)).toBe(
      "Literal Name",
    );
  });

  it("returns the literal name when there is no nameKey", () => {
    expect(getMiniAppName(ma(), hitT)).toBe("Literal Name");
  });
});

describe("getMiniAppDescription", () => {
  it("returns the translated description when descriptionKey resolves", () => {
    expect(
      getMiniAppDescription(ma({ descriptionKey: "ma.desc" }), hitT),
    ).toBe("translated:ma.desc");
  });

  it("falls back to the literal description on a miss", () => {
    expect(
      getMiniAppDescription(
        ma({ description: "Literal Desc", descriptionKey: "ma.desc" }),
        missT,
      ),
    ).toBe("Literal Desc");
  });

  it("returns undefined when there is no description at all", () => {
    expect(getMiniAppDescription(ma(), hitT)).toBeUndefined();
  });
});
