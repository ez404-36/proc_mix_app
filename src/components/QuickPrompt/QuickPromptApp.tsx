import { useEffect, useRef, type ReactElement } from "react";
import { ConfigProvider } from "@arco-design/web-react";
import enUS from "@arco-design/web-react/es/locale/en-US";
import ruRU from "@arco-design/web-react/es/locale/ru-RU";
import type { Locale } from "@arco-design/web-react/es/locale/interface";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useUIStore } from "../../stores/uiStore";
import { useTheme } from "../../hooks/useTheme";
import type { Language } from "../../i18n";
import { VariablePrompt } from "../VariablePrompt";
import { AdminPasswordPrompt } from "../AdminPasswordPrompt";
import { getQuickPromptRequest } from "../../services/quickPromptService";
import { runQuickPromptFlow } from "./quickPromptFlow";

// ru-RU shipped by @arco-design/web-react omits the Form/ColorPicker entries
// the Locale interface requires; fall back to en-US for those keys (mirrors
// the main `App`).
const ARCO_LOCALE_MAP: Record<Language, Locale> = {
  en: enUS,
  ru: { ...enUS, ...ruRU },
};

/**
 * Root of the standalone "quick-launch prompt" window (v0.12.0).
 *
 * A SEPARATE Tauri webview (`prompt.html` / `prompt-main.tsx`), opened on
 * demand by the tray / file-manager quick-launch when a favorite command needs
 * interactive input — so the main ProcMix window never has to be shown. It
 * mounts ONLY the variable and admin-password prompt singletons.
 *
 * On mount it fetches the pending request from the backend and drives the
 * prompt flow (variables → admin password → submit), then closes itself. If
 * nothing is pending (e.g. the window outlived its request) it closes
 * immediately.
 */
export function QuickPromptApp(): ReactElement {
  const language = useUIStore((s) => s.language);
  // Keep the window's theme in sync (the pre-paint bootstrap set the initial).
  useTheme();

  // Guard against React 18/19 StrictMode double-invoking the effect: the flow
  // must run exactly once (a second run would race the backend take()).
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    void (async () => {
      const closeSelf = (): void => {
        // Best-effort: closing a window that is already gone is harmless.
        void getCurrentWindow().close();
      };
      try {
        const request = await getQuickPromptRequest();
        // No pending request — nothing to ask; the `finally` closes the window.
        if (request !== null) {
          // The prompt singletons register their handlers on mount; this runs
          // in a microtask after mount, so they are ready.
          await runQuickPromptFlow(request);
        }
      } catch {
        // A backend failure (state gone, run error) still closes the dialog —
        // the outcome is surfaced by the backend's notification / History.
      } finally {
        // Single close path for every outcome (submitted / cancelled / no
        // request / error) so the window is never closed twice.
        closeSelf();
      }
    })();
  }, []);

  return (
    <ConfigProvider locale={ARCO_LOCALE_MAP[language]}>
      <div className="quick-prompt-window">
        {/* The two prompt singletons the flow drives via their imperative
            registries. Mounted exactly once, like in the main App. */}
        <VariablePrompt />
        <AdminPasswordPrompt />
      </div>
    </ConfigProvider>
  );
}
