// App shell. Desktop: a fixed left sidebar + content. Mobile (≤640px, var. A):
// a compact top bar (logo + console/theme/logout) and a bottom tab-bar for the
// three sections, with the content full-width. The desktop sidebar and the
// mobile chrome are both rendered; CSS (web.css) shows the right one per
// breakpoint, so there is a single source of truth for state/handlers.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import logoUrl from "@app/assets/logo.svg";
import { LogoutIcon } from "@app/components/icons/LogoutIcon";
import { useAuthStore } from "../stores/authStore";
import { useRunStore } from "../stores/runStore";
import { ThemeToggle } from "../components/ThemeToggle";
import { Console } from "../components/Console";
import { Home } from "./Home";
import { Library } from "./Library";
import { History } from "./History";
import { stopAllPolling } from "../api/runPoller";

type Section = "home" | "library" | "history";

export function Shell(): React.JSX.Element {
  const { t } = useTranslation();
  const clearAuth = useAuthStore((s) => s.clear);
  const [section, setSection] = useState<Section>("home");

  const { panelOpen, runCount, activeRunCount, togglePanel } = useRunStore(
    useShallow((s) => ({
      panelOpen: s.panelOpen,
      runCount: s.runs.length,
      activeRunCount: s.runs.filter(
        (r) => r.status === "running" || r.status === "pending",
      ).length,
      togglePanel: s.setPanelOpen,
    })),
  );

  // Logout: stop every active run poll first so no orphaned timer keeps hitting
  // the API after the token is gone, then clear the session.
  const logout = (): void => {
    stopAllPolling();
    clearAuth();
  };

  // The console toggle's indicator: a running count while the panel is closed
  // (output is accumulating unseen), else a plain run count when any exist.
  const indicator =
    !panelOpen && activeRunCount > 0
      ? activeRunCount
      : runCount > 0
        ? runCount
        : null;

  const sections: ReadonlyArray<{ key: Section; label: string; glyph: string }> = [
    { key: "home", label: t("nav.home", "Home"), glyph: "⌂" },
    { key: "library", label: t("nav.library", "Library"), glyph: "▤" },
    { key: "history", label: t("nav.history", "History"), glyph: "↻" },
  ];

  return (
    <div className="app-shell">
      {/* Mobile top bar — brand + console / theme / logout. Hidden on desktop. */}
      <header className="app-topbar">
        <div className="app-topbar__brand">
          <img className="app-topbar__logo" src={logoUrl} alt="" aria-hidden="true" />
          <span className="app-topbar__title">ProcMix</span>
        </div>
        <div className="app-topbar__actions">
          <button
            type="button"
            className={`app-topbar__btn${panelOpen ? " is-active" : ""}`}
            onClick={() => togglePanel(!panelOpen)}
            aria-pressed={panelOpen}
            aria-label={t("web.console.title", "Console")}
            title={t("web.console.title", "Console")}
          >
            <span aria-hidden="true">▤</span>
            {indicator !== null ? (
              <span className="list-group__count" aria-hidden="true">
                {indicator}
              </span>
            ) : null}
          </button>
          <ThemeToggle compact />
          <button
            type="button"
            className="btn btn--danger app-topbar__logout"
            onClick={logout}
            aria-label={t("web.nav.logout", "Log out")}
            title={t("web.nav.logout", "Log out")}
          >
            <LogoutIcon />
          </button>
        </div>
      </header>

      <aside className="app-sidebar">
        <nav className="app-sidebar__nav" aria-label={t("web.nav.label", "Sections")}>
          {sections.map((s) => (
            <button
              key={s.key}
              type="button"
              className={navClass(section === s.key)}
              onClick={() => setSection(s.key)}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className="app-sidebar__footer">
          <button
            type="button"
            className={`app-sidebar__btn${panelOpen ? " is-active" : ""}`}
            onClick={() => togglePanel(!panelOpen)}
            aria-pressed={panelOpen}
            title={t("web.console.toggle", "Console")}
          >
            <span aria-hidden="true">▤ </span>
            {t("web.console.title", "Console")}
            {indicator !== null ? (
              <span className="list-group__count" aria-hidden="true">
                {indicator}
              </span>
            ) : null}
          </button>
          <ThemeToggle />
          <hr className="app-sidebar__divider" />
          <button
            type="button"
            className="btn btn--danger app-sidebar__logout"
            onClick={logout}
          >
            <LogoutIcon />
            {t("web.nav.logout", "Log out")}
          </button>
        </div>
      </aside>

      <main className="app-main">
        {section === "home" ? (
          <Home />
        ) : section === "library" ? (
          <Library />
        ) : (
          <History />
        )}
      </main>

      {/* Mobile bottom tab-bar — the three sections. Hidden on desktop. */}
      <nav className="app-tabbar" aria-label={t("web.nav.label", "Sections")}>
        {sections.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`app-tabbar__btn${section === s.key ? " is-active" : ""}`}
            aria-current={section === s.key ? "page" : undefined}
            onClick={() => setSection(s.key)}
          >
            <span className="app-tabbar__glyph" aria-hidden="true">
              {s.glyph}
            </span>
            <span className="app-tabbar__label">{s.label}</span>
          </button>
        ))}
      </nav>

      <Console />
    </div>
  );
}

function navClass(active: boolean): string {
  return active ? "app-sidebar__btn is-active" : "app-sidebar__btn";
}
