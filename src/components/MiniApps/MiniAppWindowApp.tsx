import { useEffect, useRef, useState, type ReactElement } from "react";
import { ConfigProvider } from "@arco-design/web-react";
import enUS from "@arco-design/web-react/es/locale/en-US";
import ruRU from "@arco-design/web-react/es/locale/ru-RU";
import type { Locale } from "@arco-design/web-react/es/locale/interface";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTheme } from "../../hooks/useTheme";
import { useExecutionBridge } from "../../hooks/useExecutionBridge";
import { useI18nBridge } from "../../hooks/useI18nBridge";
import type { Language } from "../../i18n";
import { useCommandStore } from "../../stores/commandStore";
import { useExecutionStore } from "../../stores/executionStore";
import { useMiniAppStore } from "../../stores/miniappStore";
import { useUIStore } from "../../stores/uiStore";
import { getMiniAppWindowId } from "../../services/miniappWindow";
import { cancelExecution } from "../../utils/executor";
import { AdminPasswordPrompt } from "../AdminPasswordPrompt";
import { ContextMenuProvider } from "../ContextMenu";
import { RemoteHostPrompt } from "../RemoteHostPrompt/RemoteHostPrompt";
import { SshPasswordPrompt } from "../SshPasswordPrompt/SshPasswordPrompt";
import { VariablePrompt } from "../VariablePrompt";
import { WorkingDirPrompt } from "../WorkingDirPrompt/WorkingDirPrompt";
import { MiniAppCloseConfirmDialog } from "./MiniAppCloseConfirmDialog";
import { MiniAppRunner } from "./MiniAppRunner";

// ru-RU shipped by @arco-design/web-react omits the Form/ColorPicker entries
// the Locale interface requires; fall back to en-US for those keys (mirrors
// the main `App` and `QuickPromptApp`).
const ARCO_LOCALE_MAP: Record<Language, Locale> = {
  en: enUS,
  ru: { ...enUS, ...ruRU },
};

/**
 * Root of a standalone Mini-App runner window (`miniapp-<id>`).
 *
 * A SEPARATE Tauri webview per running mini-app (`miniapp-runner.html` /
 * `miniapp-runner-main.tsx`), opened on demand from the Library's "Run"
 * action or the tray's "Mini-Apps" submenu — mirrors the quick-prompt
 * window's isolation (own Vite entry, own capability file) but, unlike that
 * single-instance dialog, any number of these windows can be open
 * simultaneously, one per mini-app id.
 *
 * Each window is its OWN JS runtime with its OWN copy of every Zustand
 * store — `execution-event`/`workflow-event` Tauri events reach every open
 * webview by default, so `useExecutionBridge` here builds up this window's
 * `executionStore` independently, exactly like the main window's does. On
 * mount this:
 *   1. Resolves ITS OWN mini-app id from the window's own label
 *      (`get_miniapp_window_id`) — never a URL query param.
 *   2. Hydrates `miniappStore` + `commandStore` (widget actions may
 *      reference library commands) from SQLite.
 *   3. Wires the execution bridge — gated to this window's OWN mini-app id
 *      (see `useExecutionBridge`) — so widget runs stream output/PIDs into
 *      THIS window's `executionStore` only, consumed by `MiniAppRunnerTabs`
 *      (Console/Processes tabs) inside `MiniAppRunner`.
 *   4. Installs the `onCloseRequested` guard: if the mini-app has active
 *      processes when the user tries to close (native × / minimize is
 *      unaffected — only closing is intercepted), a confirmation dialog asks
 *      whether to kill them first (default: yes).
 */
export function MiniAppWindowApp(): ReactElement {
  const { t } = useTranslation();
  const language = useUIStore((s) => s.language);
  useTheme();
  useI18nBridge();

  const [miniappId, setMiniappId] = useState<string | null>(null);
  // Gate the execution-event bridge to THIS mini-app's own tagged runs (see
  // `useExecutionBridge`'s doc comment) so a widget run's output never leaks
  // into the main window or a DIFFERENT mini-app's own window. `null` before
  // `miniappId` resolves is harmless — nothing has run yet.
  useExecutionBridge(miniappId);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  // Guards the SECOND, post-confirmation `close()` call so it isn't
  // intercepted by the very same guard again (an infinite loop otherwise —
  // `onCloseRequested` fires for every close attempt, including ones this
  // component issues itself once the user has already decided).
  const bypassGuardRef = useRef(false);

  // Resolve which mini-app this window shows, then hydrate the stores it
  // needs. Runs once; StrictMode's double-invoke is harmless — both
  // `hydrateFromDb` calls are idempotent (see their own store docs).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const id = await getMiniAppWindowId();
        if (cancelled) return;
        setMiniappId(id);
      } catch (err: unknown) {
        if (cancelled) return;
        setResolveError(err instanceof Error ? err.message : String(err));
      }
      void useMiniAppStore.getState().hydrateFromDb();
      void useCommandStore.getState().hydrateFromDb();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Install the close guard once. Reads the LATEST execution snapshot at
  // close time (not a stale closure) via `getState()`, so a process started
  // after mount is still caught.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await getCurrentWindow().onCloseRequested((event) => {
        if (bypassGuardRef.current) return;
        const hasActive = Object.values(
          useExecutionStore.getState().executions,
        ).some((e) => e.status === "running" || e.status === "pending");
        if (!hasActive) return;
        event.preventDefault();
        setCloseConfirmOpen(true);
      });
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  const executions = useExecutionStore((s) => s.executions);
  const activeProcessCount = Object.values(executions).filter(
    (e) => e.status === "running" || e.status === "pending",
  ).length;

  const handleCloseConfirm = (killChildren: boolean): void => {
    setCloseConfirmOpen(false);
    if (killChildren) {
      const running = Object.values(
        useExecutionStore.getState().executions,
      ).filter((e) => e.status === "running" || e.status === "pending");
      for (const exec of running) {
        void cancelExecution(exec.id).catch((err: unknown) => {
          console.error(
            "failed to cancel mini-app process on window close",
            exec.id,
            err,
          );
        });
      }
    }
    bypassGuardRef.current = true;
    void getCurrentWindow().close();
  };

  const handleCloseCancel = (): void => {
    setCloseConfirmOpen(false);
  };

  return (
    <ConfigProvider locale={ARCO_LOCALE_MAP[language]}>
      {/* `MiniAppRunnerTabs`' Console tab (rendered inside `MiniAppRunner`)
          attaches a right-click copy menu via `useContextMenu` — this window
          has no `.app-shell` chrome to inherit a provider from, so it needs
          its own, mirroring the main `App`'s `<ContextMenuProvider>`. */}
      <ContextMenuProvider>
        <div className="miniapp-window">
          {resolveError !== null ? (
            <div className="empty-state">
              {t("miniapps.runner.windowResolveFailed", {
                defaultValue: resolveError,
                message: resolveError,
              })}
            </div>
          ) : miniappId === null ? (
            <div className="empty-state">{t("common.loading")}</div>
          ) : (
            <MiniAppRunner miniappId={miniappId} standalone />
          )}

          <MiniAppCloseConfirmDialog
            open={closeConfirmOpen}
            processCount={activeProcessCount}
            onConfirm={handleCloseConfirm}
            onCancel={handleCloseCancel}
          />

          {/* Widget actions can prompt for command variables / admin password /
              remote host / SSH password, exactly like a library run — these
              singletons must be mounted so the imperative helpers
              `commandRunner.ts` calls have a registered handler, mirroring
              the main `App`. */}
          <AdminPasswordPrompt />
          <VariablePrompt />
          <WorkingDirPrompt />
          <RemoteHostPrompt />
          <SshPasswordPrompt />
        </div>
      </ContextMenuProvider>
    </ConfigProvider>
  );
}
