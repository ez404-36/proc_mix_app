import { useEffect } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ConfigProvider } from "@arco-design/web-react";
import enUS from "@arco-design/web-react/es/locale/en-US";
import ruRU from "@arco-design/web-react/es/locale/ru-RU";
import type { Locale } from "@arco-design/web-react/es/locale/interface";
import { useUIStore } from "./stores/uiStore";
import { useExecutionStore } from "./stores/executionStore";
import { useTheme } from "./hooks/useTheme";
import { useAppVersion } from "./hooks/useAppVersion";
import type { Theme, View } from "./types";
import type { Language } from "./i18n";
import { AdminPasswordPrompt } from "./components/AdminPasswordPrompt";
import { VariablePrompt } from "./components/VariablePrompt";
import { WorkingDirPrompt } from "./components/WorkingDirPrompt/WorkingDirPrompt";
import { RemoteHostPrompt } from "./components/RemoteHostPrompt/RemoteHostPrompt";
import { SshPasswordPrompt } from "./components/SshPasswordPrompt/SshPasswordPrompt";
import { Home } from "./components/Home";
import { Library } from "./components/Library";
import { SchedulerTab, ScheduleEditor } from "./components/Scheduler";
import { Editor } from "./components/Editor";
import { CommandEditor } from "./components/CommandEditor";
import { History } from "./components/History";
import { Recorder } from "./components/Recorder";
import { Settings } from "./components/Settings";
import { CommandPalette } from "./components/CommandPalette";
import { EnvManager } from "./components/EnvManager";
import { OutputPanel } from "./components/OutputPanel";
import { ContextMenuProvider } from "./components/ContextMenu";
import { UpdateDialog } from "./components/UpdateDialog";
import { useUpdateStore } from "./stores/updateStore";
import { useExecutionBridge } from "./hooks/useExecutionBridge";
import { useWorkflowBridge } from "./hooks/useWorkflowBridge";
import { useGlobalShortcut } from "./hooks/useGlobalShortcut";
import { useI18nBridge } from "./hooks/useI18nBridge";
import { useSeedBootstrap } from "./hooks/useSeedBootstrap";
import { useTrayLocalization } from "./hooks/useTrayLocalization";
import logoUrl from "./assets/logo.svg";

interface NavItem {
  view: View;
  labelKey:
    | "nav.home"
    | "nav.library"
    | "nav.scheduler"
    | "nav.history"
    | "nav.recorder"
    | "nav.settings"
    | "nav.env";
  icon: string;
}

// The "editor" view is intentionally absent: the workflow editor is opened
// only via "+ New workflow" / "Edit" / the workflow view modal — never from a
// top-level menu item. It remains a valid `View` reachable through those
// flows (see `renderView`), it just has no sidebar button.
//
// The "recorder" (Process Capture) item is shown on every platform as a
// STUB: real capture is Windows-only (ETW), so on macOS/Linux the view
// renders a "not yet available on this OS" notice instead of the controls
// (see `Recorder.tsx` + `docs/process-capture.md`). We surface it rather
// than hide it so the feature is discoverable.
const NAV_ITEMS: NavItem[] = [
  { view: "home", labelKey: "nav.home", icon: "⌂" },
  { view: "library", labelKey: "nav.library", icon: "▤" },
  { view: "scheduler", labelKey: "nav.scheduler", icon: "⏲" },
  { view: "history", labelKey: "nav.history", icon: "⏱" },
  { view: "recorder", labelKey: "nav.recorder", icon: "⏺" },
  { view: "env", labelKey: "nav.env", icon: "⊞" },
  { view: "settings", labelKey: "nav.settings", icon: "⚙" },
];

const THEME_CYCLE: Theme[] = ["light", "dark", "system"];

// ru-RU shipped by @arco-design/web-react omits the Form and ColorPicker
// entries that are required by the Locale interface. Fall back to en-US for
// those keys so unaffected components still render in Russian while the
// missing pieces remain in English until the upstream locale catches up.
const ARCO_LOCALE_MAP: Record<Language, Locale> = {
  en: enUS,
  ru: { ...enUS, ...ruRU },
};

function renderView(view: View): ReactElement {
  switch (view) {
    case "home":
      return <Home />;
    case "library":
      return <Library />;
    case "scheduler":
      return <SchedulerTab />;
    case "scheduler-editor":
      return <ScheduleEditor />;
    case "editor":
      return <Editor />;
    case "command-editor":
      return <CommandEditor />;
    case "history":
      return <History />;
    case "recorder":
      return <Recorder />;
    case "env":
      return <EnvManager />;
    case "settings":
      return <Settings />;
  }
}

function App(): ReactElement {
  const { t } = useTranslation();
  const currentView = useUIStore((s) => s.currentView);
  // Route sidebar navigation through `requestNavigation` (not `setView`)
  // so leaving a dirty command editor triggers the unsaved-changes guard
  // instead of silently discarding edits.
  const requestNavigation = useUIStore((s) => s.requestNavigation);
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const togglePalette = useUIStore((s) => s.togglePalette);
  const language = useUIStore((s) => s.language);
  const setPanelOpen = useExecutionStore((s) => s.setPanelOpen);
  const appVersion = useAppVersion();
  const { theme, setTheme } = useTheme();

  const updateInfo = useUpdateStore((s) => s.info);
  const updateDismissed = useUpdateStore((s) => s.dismissed);
  const updateModalOpen = useUpdateStore((s) => s.isModalOpen);
  const openUpdateModal = useUpdateStore((s) => s.openModal);
  const closeUpdateModal = useUpdateStore((s) => s.closeModal);
  const checkForUpdate = useUpdateStore((s) => s.checkForUpdate);

  useExecutionBridge();
  useWorkflowBridge();
  useGlobalShortcut();
  useI18nBridge();
  useSeedBootstrap();
  useTrayLocalization();

  useEffect(() => {
    const timer = setTimeout(() => void checkForUpdate(), 5000);
    return () => clearTimeout(timer);
  }, [checkForUpdate]);

  // Global Ctrl/Cmd+K handler.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const isPaletteShortcut =
        (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === "k";
      if (isPaletteShortcut) {
        e.preventDefault();
        togglePalette();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [togglePalette]);

  const handleCycleTheme = (): void => {
    const idx = THEME_CYCLE.indexOf(theme);
    const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
    if (next) setTheme(next);
  };

  const themeLabel = ((): string => {
    switch (theme) {
      case "light":
        return t("settings.appearance.themeLight");
      case "dark":
        return t("settings.appearance.themeDark");
      case "system":
        return t("settings.appearance.themeSystem");
    }
  })();

  return (
    <ConfigProvider locale={ARCO_LOCALE_MAP[language]}>
      <ContextMenuProvider>
        <div className="app-shell">
          <aside
            className={`app-sidebar${
              sidebarCollapsed ? " app-sidebar--collapsed" : ""
            }`}
          >
            <div className="app-sidebar__brand">
              <img
                className="app-sidebar__brand-logo"
                src={logoUrl}
                alt=""
                aria-hidden="true"
                width={24}
                height={24}
              />
              {!sidebarCollapsed && (
                <span className="app-sidebar__brand-text">
                  {t("common.appName")}
                </span>
              )}
              <button
                type="button"
                className="app-sidebar__collapse-toggle"
                onClick={toggleSidebar}
                aria-expanded={!sidebarCollapsed}
                aria-label={t(
                  sidebarCollapsed ? "nav.expand" : "nav.collapse",
                )}
                title={t(sidebarCollapsed ? "nav.expand" : "nav.collapse")}
              >
                <span aria-hidden="true">{sidebarCollapsed ? "»" : "«"}</span>
              </button>
            </div>
            <nav className="app-sidebar__nav">
              {NAV_ITEMS.map((item) => (
                <button
                  key={item.view}
                  type="button"
                  className={`app-sidebar__nav-button${
                    currentView === item.view ? " is-active" : ""
                  }`}
                  onClick={() => requestNavigation(item.view)}
                  title={sidebarCollapsed ? t(item.labelKey) : undefined}
                >
                  <span aria-hidden="true">{item.icon}</span>
                  {!sidebarCollapsed && <span>{t(item.labelKey)}</span>}
                </button>
              ))}
            </nav>
            <div className="app-sidebar__tools">
              <button
                type="button"
                className="app-sidebar__nav-button"
                onClick={() => setPanelOpen(true)}
                title={
                  sidebarCollapsed
                    ? t("nav.openConsole")
                    : t("nav.openConsoleTitle")
                }
              >
                <span aria-hidden="true">▣</span>
                {!sidebarCollapsed && <span>{t("nav.openConsole")}</span>}
              </button>
            </div>
            <div className="app-sidebar__footer">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={handleCycleTheme}
                title={t("nav.cycleThemeTitle")}
                aria-label={
                  sidebarCollapsed
                    ? t("nav.themeLabel", { label: themeLabel })
                    : undefined
                }
              >
                {sidebarCollapsed
                  ? "◐"
                  : t("nav.themeLabel", { label: themeLabel })}
              </button>
              {!sidebarCollapsed && (
                <div className="app-sidebar__hint">
                  <span className="app-sidebar__hint-keys">
                    <span className="kbd">Ctrl/Cmd</span>+<span className="kbd">K</span>
                  </span>
                  <span className="app-sidebar__hint-label">
                    {t("nav.paletteHint")}
                  </span>
                </div>
              )}
              {!sidebarCollapsed && (
                <div className="app-sidebar__meta">
                  <span className="app-sidebar__meta-row">
                    <span className="app-sidebar__meta-label">
                      {t("nav.versionLabel")}
                    </span>
                    <span className="app-sidebar__meta-value">
                      {appVersion ? `v${appVersion}` : "—"}
                    </span>
                  </span>
                </div>
              )}
              {!sidebarCollapsed && updateInfo && !updateDismissed && (
                <button
                  type="button"
                  className="app-sidebar__update"
                  onClick={openUpdateModal}
                >
                  {t("nav.updateAvailable")}
                </button>
              )}
            </div>
          </aside>
          <main className="app-main">{renderView(currentView)}</main>
        </div>
        <CommandPalette />
        <OutputPanel />
        {/* App-global singleton — see AdminPasswordPrompt.tsx. Must be
            mounted exactly once so the imperative `promptForAdminPassword`
            helper (used by triggerCommandRun's sentinel-retry flow)
            has a handler registered. */}
        <AdminPasswordPrompt />
        {/* App-global singleton — see VariablePrompt.tsx. Mounted exactly
            once so the runtime helper `promptForVariables` (used by the
            executor wrapper in runCommand.ts) has a handler registered. */}
        <VariablePrompt />
        {/* App-global singleton — see WorkingDirPrompt.tsx. Mounted exactly
            once so `promptForWorkingDir` (used by commandRunner.ts) has a
            handler registered. */}
        <WorkingDirPrompt />
        {/* App-global singleton — see RemoteHostPrompt.tsx. Mounted exactly
            once so `promptForRemoteHost` (used by commandRunner.ts for the
            "ask at run time" target) has a handler registered. */}
        <RemoteHostPrompt />
        {/* App-global singleton — see SshPasswordPrompt.tsx. Mounted once so
            `promptForSshPassword` (used by commandRunner.ts for a remote
            command with `promptSshPassword`) has a handler registered. */}
        <SshPasswordPrompt />
        <UpdateDialog
          open={updateModalOpen}
          onClose={closeUpdateModal}
        />
      </ContextMenuProvider>
    </ConfigProvider>
  );
}

export default App;
