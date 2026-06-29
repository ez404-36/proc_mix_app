// i18n bootstrap for the web UI.
//
// Reuses the SAME translation bundles as the desktop app (via the `@app` alias)
// so strings stay in sync — there is no separate web locale. The startup
// language is NOT detected from the browser: it is set from `/api/bootstrap`
// (the desktop app's language snapshot, B7/O3) by `applyBootstrapLanguage`
// after the SPA loads. Until then we initialise with the fallback so the very
// first paint has strings.

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@app/locales/en/translation.json";
import ru from "@app/locales/ru/translation.json";

export const SUPPORTED_LANGUAGES = ["en", "ru"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = "en";

export function isSupportedLanguage(lang: string): lang is Language {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(lang);
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ru: { translation: ru },
  },
  lng: DEFAULT_LANGUAGE,
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: SUPPORTED_LANGUAGES as readonly string[] as string[],
  nonExplicitSupportedLngs: true,
  interpolation: { escapeValue: false },
});

/**
 * Apply the startup language reported by the server's `/api/bootstrap`. The web
 * UI language MIRRORS the desktop app's language at server-start time (O3);
 * there is no in-browser language switch. A missing / unsupported value leaves
 * the fallback in place.
 */
export function applyBootstrapLanguage(language: string | null | undefined): void {
  if (language && isSupportedLanguage(language)) {
    void i18n.changeLanguage(language);
    document.documentElement.setAttribute("lang", language);
  }
}

export default i18n;
