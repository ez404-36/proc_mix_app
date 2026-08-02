import type { TFunction } from "i18next";
import type { MiniApp } from "../types";

/**
 * Resolve the human-readable name of a mini-app.
 *
 * Built-in/seed mini-apps carry a `nameKey` pointing at an i18next entry —
 * those are translated via `t(nameKey)`. User-created mini-apps store their
 * literal `name` and are returned as-is. If a translation lookup falls
 * through (i18next returns the key itself when no resource is found), we
 * fall back to the literal `name` so the UI never displays a raw key.
 *
 * Mirrors `utils/commandLabels.getCommandName` verbatim — the two feature
 * areas share the seed-i18n contract.
 */
export function getMiniAppName(ma: MiniApp, t: TFunction): string {
  if (ma.nameKey) {
    const translated = t(ma.nameKey);
    if (translated !== ma.nameKey) return translated;
  }
  return ma.name;
}

/**
 * Resolve the human-readable description of a mini-app. Same resolution
 * rules as {@link getMiniAppName}. Returns `undefined` when the mini-app has
 * no description at all.
 */
export function getMiniAppDescription(
  ma: MiniApp,
  t: TFunction,
): string | undefined {
  if (ma.descriptionKey) {
    const translated = t(ma.descriptionKey);
    if (translated !== ma.descriptionKey) return translated;
  }
  return ma.description;
}
