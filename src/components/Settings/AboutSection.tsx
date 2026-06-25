import { type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useAppVersion } from "../../hooks/useAppVersion";

export function AboutSection(): ReactElement {
  const { t } = useTranslation();
  const appVersion = useAppVersion();

  return (
    <section className="view-section">
      <h2 className="view-section__title">{t("settings.about.title")}</h2>
      <div className="empty-state settings-info">
        <div className="settings-info__line">
          <strong>{t("common.appName")}</strong>{" "}
          {appVersion ? `v${appVersion}` : "—"}
        </div>
        <div className="settings-info__lead">
          {t("settings.about.description")}
        </div>
        <div className="settings-caption">
          {t("settings.about.license")}
        </div>
        <div className="settings-caption">
          {t("settings.about.copyright")}
        </div>
      </div>
    </section>
  );
}
