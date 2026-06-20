import { invoke } from "@tauri-apps/api/core";
import type { TFunction } from "i18next";

export interface TrayLabels {
  show: string;
  hide: string;
  quit: string;
  tooltip: string;
}

/**
 * Build the localized tray labels. In a DEV build (`import.meta.env.DEV`),
 * the product name "ProcMix" is suffixed with " (dev)" across every label
 * and the tooltip — so a developer running the dev build can tell its tray
 * icon / menu apart from an installed release (e.g. "Выйти из ProcMix"
 * becomes "Выйти из ProcMix (dev)"). The replacement is locale-agnostic:
 * every translation embeds the literal "ProcMix" token, so a single
 * substitution covers all languages.
 */
export function buildTrayLabels(t: TFunction): TrayLabels {
  return withDevSuffix({
    show: t("tray.show"),
    hide: t("tray.hide"),
    quit: t("tray.quit"),
    tooltip: t("tray.tooltip"),
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
  return {
    show: tag(labels.show),
    hide: tag(labels.hide),
    quit: tag(labels.quit),
    tooltip: tag(labels.tooltip),
  };
}

export async function updateTrayMenu(labels: TrayLabels): Promise<void> {
  await invoke("update_tray_menu", { labels });
}
