// Root of the web UI.
//
// Bootstraps the locale from `/api/bootstrap` (B7), wires the theme controller
// (F10), and gates the app behind the login screen (F3). The full shell —
// Home / Library / History views, console, and theme toggle — is built out in
// F4–F11; this scaffold renders the login gate and a placeholder shell so the
// build is runnable end to end.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchBootstrap } from "./api/client";
import { applyBootstrapLanguage } from "./i18n";
import { useTheme } from "./hooks/useTheme";
import { useAuthStore } from "./stores/authStore";
import { Login } from "./views/Login";
import { Shell } from "./views/Shell";

export function App(): React.JSX.Element {
  // Applies `data-theme` to <html> and keeps it in sync with system changes.
  useTheme();
  const { t } = useTranslation();
  const token = useAuthStore((s) => s.token);
  const [bootstrapped, setBootstrapped] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchBootstrap()
      .then((b) => {
        if (!cancelled) applyBootstrapLanguage(b.language);
      })
      .catch(() => {
        /* bootstrap is best-effort; the SPA falls back to its default locale */
      })
      .finally(() => {
        if (!cancelled) setBootstrapped(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!bootstrapped) {
    return (
      <div className="empty-state" role="status">
        {t("common.loading", "Loading…")}
      </div>
    );
  }

  return token ? <Shell /> : <Login />;
}
