import { type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_TOGGLE_SHORTCUT, useUIStore } from "../../stores/uiStore";
import { ShortcutRow } from "./ShortcutRow";

export function ShortcutsSection(): ReactElement {
  const { t } = useTranslation();
  const toggleShortcut = useUIStore((s) => s.toggleShortcut);
  const setToggleShortcut = useUIStore((s) => s.setToggleShortcut);

  return (
    <section className="view-section">
      <h2 className="view-section__title">{t("settings.shortcuts.title")}</h2>
      <div className="shortcut-list">
        <ShortcutRow
          label={t("settings.shortcuts.toggleLabel")}
          description={t("settings.shortcuts.toggleDescription")}
          accelerator={toggleShortcut}
          defaultAccelerator={DEFAULT_TOGGLE_SHORTCUT}
          onChange={setToggleShortcut}
        />
        <div className="shortcut-list__hint">
          {t("settings.shortcuts.paletteHintPrefix")}{" "}
          <span className="kbd">Ctrl/Cmd</span>
          <span className="shortcut-list__plus">+</span>
          <span className="kbd">K</span>{" "}
          {t("settings.shortcuts.paletteHintSuffix")}
        </div>
      </div>
    </section>
  );
}
