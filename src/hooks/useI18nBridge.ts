import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../stores/uiStore";

export function useI18nBridge(): void {
  const language = useUIStore((s) => s.language);
  const { i18n } = useTranslation();

  useEffect(() => {
    if (i18n.language !== language) {
      void i18n.changeLanguage(language);
    }
    document.documentElement.setAttribute("lang", language);
  }, [language, i18n]);
}
