// Theme toggle (F11) — mirrors the DESKTOP sidebar switcher: a single
// `btn--ghost` button reading "Theme: <label>" that cycles light → dark →
// system on click (not three separate buttons). Labels reuse the desktop i18n
// keys so RU reads "Тема: Тёмная" etc. No language switch (O3).

import { useTranslation } from "react-i18next";
import { useTheme } from "../hooks/useTheme";
import type { Theme } from "../stores/uiStore";

const THEME_CYCLE: Theme[] = ["light", "dark", "system"];

function themeLabelKey(theme: Theme): string {
  switch (theme) {
    case "light":
      return "settings.appearance.themeLight";
    case "dark":
      return "settings.appearance.themeDark";
    case "system":
      return "settings.appearance.themeSystem";
  }
}

/** A small per-theme glyph for the compact (icon-only) variant. */
function themeGlyph(theme: Theme): string {
  switch (theme) {
    case "light":
      return "☀";
    case "dark":
      return "☾";
    case "system":
      return "◐";
  }
}

interface ThemeToggleProps {
  /**
   * Compact icon-only button (a sun/moon/auto glyph) for the mobile top bar.
   * Default false → the full "Theme: <label>" sidebar button.
   */
  compact?: boolean;
}

export function ThemeToggle({ compact = false }: ThemeToggleProps): React.JSX.Element {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();

  const cycle = (): void => {
    const idx = THEME_CYCLE.indexOf(theme);
    const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
    if (next) setTheme(next);
  };

  const label = t(themeLabelKey(theme));
  const fullLabel = t("nav.themeLabel", "Theme: {{label}}", { label });

  if (compact) {
    return (
      <button
        type="button"
        className="btn btn--ghost app-topbar__btn"
        onClick={cycle}
        aria-label={fullLabel}
        title={fullLabel}
      >
        <span aria-hidden="true">{themeGlyph(theme)}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className="btn btn--ghost app-sidebar__theme"
      onClick={cycle}
      title={t("nav.cycleThemeTitle", "Switch theme")}
    >
      {fullLabel}
    </button>
  );
}
