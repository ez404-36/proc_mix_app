import type { TFunction } from "i18next";
import type { MiniApp } from "../types";
import { getMiniAppDescription, getMiniAppName } from "./miniappLabels";

/**
 * Whether a mini-app matches the free-text query. Case-insensitive
 * name/description/tag match, mirroring `matchesWorkflowQuery`. A seed
 * mini-app's DISPLAYED (translated) labels are matched, so searching for
 * what is on screen works in either language; the literal fields are
 * matched too, because that is what a user-created mini-app carries.
 */
export function matchesMiniAppQuery(
  ma: MiniApp,
  query: string,
  t: TFunction,
): boolean {
  if (query.length === 0) return true;
  const q = query.toLowerCase();
  if (getMiniAppName(ma, t).toLowerCase().includes(q)) return true;
  const description = getMiniAppDescription(ma, t);
  if (description && description.toLowerCase().includes(q)) return true;
  if (ma.tags.some((tag) => tag.toLowerCase().includes(q))) return true;
  return false;
}
