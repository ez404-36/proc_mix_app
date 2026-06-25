import { type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { AppearanceSection } from "./AppearanceSection";
import { ShortcutsSection } from "./ShortcutsSection";
import { TraySection } from "./TraySection";
import { AdminPasswordSection } from "./AdminPasswordSection";
import { DataSection } from "./DataSection";
import { UpdatesSection } from "./UpdatesSection";
import { AboutSection } from "./AboutSection";

export function Settings(): ReactElement {
  const { t } = useTranslation();

  return (
    <div>
      <header className="view-header">
        <div>
          <h1 className="view-title">{t("settings.title")}</h1>
          <p className="view-subtitle">{t("settings.subtitle")}</p>
        </div>
      </header>

      <AppearanceSection />
      <ShortcutsSection />
      <TraySection />
      <AdminPasswordSection />
      <DataSection />
      <UpdatesSection />
      <AboutSection />
    </div>
  );
}
