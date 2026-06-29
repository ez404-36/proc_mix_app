// App shell (placeholder for F4–F11).
//
// Provides the navigation between the three sections (Home / Library / History),
// the theme toggle (F11 — no language switch by design, O3), and logout. The
// section bodies, console (F8/F9), and run flow (F6) are filled in by the later
// steps; here they render as empty-state placeholders so the scaffold runs.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
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

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <nav className="app-sidebar__nav" aria-label={t("web.nav.label", "Sections")}>
          <button
            type="button"
            className={navClass(section === "home")}
            onClick={() => setSection("home")}
          >
            {t("nav.home", "Home")}
          </button>
          <button
            type="button"
            className={navClass(section === "library")}
            onClick={() => setSection("library")}
          >
            {t("nav.library", "Library")}
          </button>
          <button
            type="button"
            className={navClass(section === "history")}
            onClick={() => setSection("history")}
          >
            {t("nav.history", "History")}
          </button>
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
          <button type="button" className="btn btn--ghost" onClick={logout}>
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
      <Console />
    </div>
  );
}

function navClass(active: boolean): string {
  return active ? "app-sidebar__btn is-active" : "app-sidebar__btn";
}
