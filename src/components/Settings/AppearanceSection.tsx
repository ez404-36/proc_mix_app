import { type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useTheme } from "../../hooks/useTheme";
import { useUIStore } from "../../stores/uiStore";
import type { Theme } from "../../types";
import {
  LANGUAGE_NATIVE_NAMES,
  SUPPORTED_LANGUAGES,
  type Language,
} from "../../i18n";

type ThemeKey =
  | "settings.appearance.themeLight"
  | "settings.appearance.themeDark"
  | "settings.appearance.themeSystem";

const THEME_OPTIONS: { value: Theme; labelKey: ThemeKey }[] = [
  { value: "light", labelKey: "settings.appearance.themeLight" },
  { value: "dark", labelKey: "settings.appearance.themeDark" },
  { value: "system", labelKey: "settings.appearance.themeSystem" },
];

export function AppearanceSection(): ReactElement {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const language = useUIStore((s) => s.language);
  const setLanguage = useUIStore((s) => s.setLanguage);

  return (
    <section className="view-section">
      <div className="settings-group settings-group--center">
        <span className="settings-inline-label">
          {t("settings.appearance.themeLabel")}:
        </span>
        {THEME_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`theme-option${theme === opt.value ? " is-active" : ""}`}
            onClick={() => setTheme(opt.value)}
          >
            {t(opt.labelKey)}
          </button>
        ))}
      </div>

      <div className="settings-group settings-group--center settings-group--spaced-top">
        <span className="settings-inline-label">
          {t("settings.appearance.languageLabel")}:
        </span>
        {SUPPORTED_LANGUAGES.map((lang: Language) => (
          <button
            key={lang}
            type="button"
            className={`theme-option${language === lang ? " is-active" : ""}`}
            onClick={() => setLanguage(lang)}
          >
            {LANGUAGE_NATIVE_NAMES[lang]}
          </button>
        ))}
      </div>
    </section>
  );
}
