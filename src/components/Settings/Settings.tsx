import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { AppearanceSection } from "./AppearanceSection";
import { TraySection } from "./TraySection";
import { AutostartSection } from "./AutostartSection";
import { AdminPasswordSection } from "./AdminPasswordSection";
import { DataSection } from "./DataSection";
import { UpdatesSection } from "./UpdatesSection";
import { AboutSection } from "./AboutSection";

type SettingsTab = "appearance" | "system" | "security" | "about";

const TABS: { key: SettingsTab; labelKey: string }[] = [
  { key: "appearance", labelKey: "settings.tabs.appearance" },
  { key: "system", labelKey: "settings.tabs.system" },
  { key: "security", labelKey: "settings.tabs.security" },
  { key: "about", labelKey: "settings.tabs.about" },
];

export function Settings(): ReactElement {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<SettingsTab>("appearance");

  return (
    <div>
      <header className="view-header">
        <div>
          <h1 className="view-title">{t("settings.title")}</h1>
          <p className="view-subtitle">{t("settings.subtitle")}</p>
        </div>
      </header>

      <div className="library-tabs-row">
        <div className="library-tabs" role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.key}
              className={`library-tab${activeTab === tab.key ? " is-active" : ""}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "appearance" && <AppearanceSection />}
      {activeTab === "system" && (
        <>
          <TraySection />
          <AutostartSection />
        </>
      )}
      {activeTab === "security" && (
        <>
          <AdminPasswordSection />
          <DataSection />
        </>
      )}
      {activeTab === "about" && (
        <>
          <UpdatesSection />
          <AboutSection />
        </>
      )}
    </div>
  );
}
