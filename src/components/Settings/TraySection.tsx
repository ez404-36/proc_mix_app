import { type ReactElement } from "react";
import { useTranslation } from "react-i18next";

export function TraySection(): ReactElement {
  const { t } = useTranslation();

  return (
    <section className="view-section">
      <h2 className="view-section__title">{t("settings.tray.title")}</h2>
      <div className="empty-state settings-info">
        <div className="settings-info__line">{t("settings.tray.primary")}</div>
        <div className="settings-caption">
          {t("settings.tray.secondary")}
        </div>
      </div>
    </section>
  );
}
