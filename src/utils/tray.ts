import { invoke } from "@tauri-apps/api/core";
import type { TFunction } from "i18next";

export interface TrayLabels {
  show: string;
  hide: string;
  quit: string;
  tooltip: string;
  favorites: string;
  favoritesEmpty: string;
  favoritesMore: string;
  notifyTitle: string;
  notifySuccess: string;
  notifyError: string;
  notifyMissingVariable: string;
  notifyNotFound: string;
}

/**
 * Build the localized tray labels. In a DEV build (`import.meta.env.DEV`),
 * the product name "ProcMix" is suffixed with " (dev)" across every label
 * and the tooltip — so a developer running the dev build can tell its tray
 * icon / menu apart from an installed release (e.g. "Выйти из ProcMix"
 * becomes "Выйти из ProcMix (dev)"). The replacement is locale-agnostic:
 * every translation embeds the literal "ProcMix" token, so a single
 * substitution covers all languages.
 *
 * The favorites-submenu labels and notification bodies are passed too so the
 * backend tray (which builds the menu and raises the quick-launch outcome
 * notification) renders them in the user's language. The notification bodies
 * keep their `{{name}}` placeholder — the backend substitutes the entity name
 * at fire time.
 */
export function buildTrayLabels(t: TFunction): TrayLabels {
  return withDevSuffix({
    show: t("tray.show"),
    hide: t("tray.hide"),
    quit: t("tray.quit"),
    tooltip: t("tray.tooltip"),
    favorites: t("tray.favorites"),
    favoritesEmpty: t("tray.favoritesEmpty"),
    favoritesMore: t("tray.favoritesMore"),
    notifyTitle: t("tray.notifyTitle"),
    // Keep `{{name}}` literal — the backend interpolates the entity name.
    notifySuccess: t("tray.notifySuccess", { name: "{{name}}" }),
    notifyError: t("tray.notifyError", { name: "{{name}}" }),
    notifyMissingVariable: t("tray.notifyMissingVariable", { name: "{{name}}" }),
    notifyNotFound: t("tray.notifyNotFound"),
  });
}

/** The product name as it appears in tray labels. */
const PRODUCT_NAME = "ProcMix";

/**
 * Append " (dev)" to the product name in every label when running a dev
 * build. A no-op in production. Replaces the FIRST "ProcMix" occurrence
 * per label (each label contains it at most once).
 */
function withDevSuffix(labels: TrayLabels): TrayLabels {
  if (!import.meta.env.DEV) return labels;
  const tag = (s: string): string =>
    s.replace(PRODUCT_NAME, `${PRODUCT_NAME} (dev)`);
  // Tag every string label. Only those containing "ProcMix" (show / hide /
  // quit / tooltip / notifyTitle) change; the rest pass through unchanged so
  // the object stays complete.
  return {
    show: tag(labels.show),
    hide: tag(labels.hide),
    quit: tag(labels.quit),
    tooltip: tag(labels.tooltip),
    favorites: tag(labels.favorites),
    favoritesEmpty: tag(labels.favoritesEmpty),
    favoritesMore: tag(labels.favoritesMore),
    notifyTitle: tag(labels.notifyTitle),
    notifySuccess: tag(labels.notifySuccess),
    notifyError: tag(labels.notifyError),
    notifyMissingVariable: tag(labels.notifyMissingVariable),
    notifyNotFound: tag(labels.notifyNotFound),
  };
}

export async function updateTrayMenu(labels: TrayLabels): Promise<void> {
  await invoke("update_tray_menu", { labels });
}
