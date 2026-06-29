// Theme toggle (F11). Light / dark / system, using the shared `theme-option`
// button classes (matching the desktop AppearanceSection). No language switch:
// the web UI locale mirrors the app language at server-start time (O3).

import { useTranslation } from "react-i18next";
import { useTheme } from "../hooks/useTheme";
import type { Theme } from "../stores/uiStore";

const OPTIONS: Theme[] = ["light", "dark", "system"];

export function ThemeToggle(): React.JSX.Element {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();

  return (
    <div
      className="theme-toggle"
      role="group"
      aria-label={t("settings.theme.label", "Theme")}
    >
      {OPTIONS.map((opt) => (
        <button
          key={opt}
          type="button"
          className={
            theme === opt ? "theme-option is-active" : "theme-option"
          }
          aria-pressed={theme === opt}
          onClick={() => setTheme(opt)}
        >
          {t(`settings.theme.${opt}`, fallbackLabel(opt))}
        </button>
      ))}
    </div>
  );
}

function fallbackLabel(theme: Theme): string {
  switch (theme) {
    case "light":
      return "Light";
    case "dark":
      return "Dark";
    case "system":
      return "System";
  }
}
