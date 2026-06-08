import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import en from "../locales/en/translation.json";
import ru from "../locales/ru/translation.json";

export const SUPPORTED_LANGUAGES = ["en", "ru"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = "en";

export const LANGUAGE_NATIVE_NAMES: Record<Language, string> = {
  en: "English",
  ru: "Русский",
};

export function isSupportedLanguage(lang: string): lang is Language {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(lang);
}

export function detectInitialLanguage(): Language {
  if (typeof navigator === "undefined") return DEFAULT_LANGUAGE;
  const raw = navigator.language?.toLowerCase() ?? "";
  const short = raw.split("-")[0] ?? "";
  return isSupportedLanguage(short) ? short : DEFAULT_LANGUAGE;
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ru: { translation: ru },
    },
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: SUPPORTED_LANGUAGES as readonly string[] as string[],
    nonExplicitSupportedLngs: true,
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator", "htmlTag"],
      lookupLocalStorage: "procmix-language",
      caches: [],
    },
  });

export default i18n;
