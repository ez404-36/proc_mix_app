// Display-label helpers for API entities.
//
// Built-in commands carry i18n keys (`nameKey` / `descriptionKey`); user
// entities carry literal `name` / `description`. Resolve the key when present
// (falling back to the literal), matching the desktop app's commandLabels.

import type { TFunction } from "i18next";
import type { ApiEntitySummary } from "../api/types";

export function entityName(e: ApiEntitySummary, t: TFunction): string {
  if (e.nameKey) return t(e.nameKey, e.name);
  return e.name;
}

export function entityDescription(
  e: ApiEntitySummary,
  t: TFunction,
): string | undefined {
  if (e.descriptionKey) return t(e.descriptionKey, e.description ?? "");
  return e.description;
}
