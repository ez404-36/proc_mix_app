import { invoke } from "@tauri-apps/api/core";
import type { TFunction } from "i18next";

export interface TrayLabels {
  show: string;
  hide: string;
  quit: string;
  tooltip: string;
}

export function buildTrayLabels(t: TFunction): TrayLabels {
  return {
    show: t("tray.show"),
    hide: t("tray.hide"),
    quit: t("tray.quit"),
    tooltip: t("tray.tooltip"),
  };
}

export async function updateTrayMenu(labels: TrayLabels): Promise<void> {
  await invoke("update_tray_menu", { labels });
}
