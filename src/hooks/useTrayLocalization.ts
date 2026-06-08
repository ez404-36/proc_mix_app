import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { buildTrayLabels, updateTrayMenu } from "../utils/tray";

export function useTrayLocalization(): void {
  const { t, i18n } = useTranslation();
  const language = i18n.language;

  useEffect(() => {
    const labels = buildTrayLabels(t);
    updateTrayMenu(labels).catch((err: unknown) => {
      // Tray may not exist in dev environments (e.g., headless); log only.
      console.warn("Failed to update tray menu", err);
    });
  }, [language, t]);
}
