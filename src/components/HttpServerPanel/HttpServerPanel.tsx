import { useCallback, useState } from "react";
import type {
  ChangeEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Message } from "@arco-design/web-react";
import { useShallow } from "zustand/react/shallow";
import { useHttpServerStore } from "../../stores/httpServerStore";
import type { HttpServerConfig } from "../../types/httpServer";
import { HelpTooltip } from "../HelpTooltip";
import { NumberStepper } from "../NumberStepper/NumberStepper";
import { ToggleSwitch } from "../ToggleSwitch";
import { ServerIcon } from "../icons";

/** Lowest port the backend accepts (mirrors `storage::http_server::MIN_PORT`). */
const MIN_PORT = 1024;
const MAX_PORT = 65535;

/**
 * Format a request-log timestamp (RFC 3339) as a local `HH:MM:SS` for the log
 * line. Falls back to the raw string if it doesn't parse (so a malformed `ts`
 * is shown rather than silently dropped).
 */
function formatLogTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/**
 * Map a backend error message to a localized, user-facing string. The backend
 * returns stable code prefixes (`PORT_IN_USE:` / `INVALID_PORT:`); anything
 * else falls back to the raw message.
 */
function localizeServerError(
  message: string,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (message.startsWith("PORT_IN_USE")) return t("httpServer.errors.portInUse");
  if (message.startsWith("INVALID_PORT")) {
    return t("httpServer.errors.invalidPort", { min: MIN_PORT, max: MAX_PORT });
  }
  return message;
}

/**
 * Header mini-panel for the built-in HTTP API server: a status indicator that
 * opens a portal panel with the server toggle, port, LAN toggle (with a
 * warning), console-log toggle, the Bearer-token block, and a live request log.
 *
 * Its own BEM family (`http-server-panel__*`) — it does NOT reuse the modal
 * `.command-form` classes. The panel portals to `document.body` like the
 * command palette. Per project rule, Escape never closes it; it closes only via
 * the explicit close button or a backdrop click.
 */
export function HttpServerPanel(): ReactElement {
  const { t } = useTranslation();
  const {
    status,
    config,
    hasToken,
    log,
    error,
    start,
    stop,
    saveConfig,
    regenerateToken,
    clearToken,
    clearLog,
  } = useHttpServerStore(
    useShallow((s) => ({
      status: s.status,
      config: s.config,
      hasToken: s.hasToken,
      log: s.log,
      error: s.error,
      start: s.start,
      stop: s.stop,
      saveConfig: s.saveConfig,
      regenerateToken: s.regenerateToken,
      clearToken: s.clearToken,
      clearLog: s.clearLog,
    })),
  );

  const [open, setOpen] = useState(false);
  // The freshly-generated token, shown once after a regenerate so the user can
  // copy it. Cleared when the panel closes.
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const closePanel = useCallback((): void => {
    setOpen(false);
    setRevealedToken(null);
  }, []);

  const handleBackdropClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) closePanel();
  };

  /** Persist a config change, surfacing a localized error toast on failure. */
  const persist = useCallback(
    async (next: HttpServerConfig): Promise<void> => {
      setBusy(true);
      try {
        await saveConfig(next);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Message.error(localizeServerError(message, t));
      } finally {
        setBusy(false);
      }
    },
    [saveConfig, t],
  );

  const handleToggleServer = async (): Promise<void> => {
    setBusy(true);
    try {
      if (status.running) {
        await stop();
      } else {
        await start();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Message.error(localizeServerError(message, t));
    } finally {
      setBusy(false);
    }
  };

  // `NumberStepper` already clamps to `[MIN_PORT, MAX_PORT]` and never emits
  // NaN, so we only persist when the chosen port actually differs from the
  // saved one.
  const handlePortChange = (port: number): void => {
    if (port !== config.port) {
      void persist({ ...config, port });
    }
  };

  const handleToggleLan = (e: ChangeEvent<HTMLInputElement>): void => {
    void persist({ ...config, bindLan: e.target.checked });
  };

  const handleToggleLogToConsole = (e: ChangeEvent<HTMLInputElement>): void => {
    void persist({ ...config, logToConsole: e.target.checked });
  };

  const handleRegenerateToken = async (): Promise<void> => {
    setBusy(true);
    try {
      const token = await regenerateToken();
      setRevealedToken(token);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Message.error(message);
    } finally {
      setBusy(false);
    }
  };

  const handleClearToken = async (): Promise<void> => {
    setBusy(true);
    try {
      await clearToken();
      setRevealedToken(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Message.error(message);
    } finally {
      setBusy(false);
    }
  };

  const handleCopyToken = async (): Promise<void> => {
    if (revealedToken === null) return;
    try {
      await navigator.clipboard.writeText(revealedToken);
      Message.success(t("httpServer.token.copied"));
    } catch {
      Message.error(t("httpServer.token.copyFailed"));
    }
  };

  const handleClearLog = async (): Promise<void> => {
    try {
      await clearLog();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      Message.error(message);
    }
  };

  /** Copy an arbitrary URL to the clipboard with a success/failure toast. */
  const handleCopyUrl = async (url: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      Message.success(t("httpServer.address.copied"));
    } catch {
      Message.error(t("httpServer.token.copyFailed"));
    }
  };

  const indicatorState = status.running ? "is-running" : "is-stopped";
  const statusLabel = status.running
    ? t("httpServer.status.running", { port: status.port })
    : t("httpServer.status.stopped");

  // Reachable URLs to surface while running: the friendly `procmix.local` name
  // (mDNS) and the raw LAN IP fallback. Both come from the live status; either
  // may be absent (no mDNS responder / no LAN address).
  const mdnsUrl =
    status.running && status.mdnsHost !== undefined
      ? `http://${status.mdnsHost}:${status.port}`
      : null;
  const lanUrl =
    status.running && status.lanAddress !== undefined
      ? `http://${status.lanAddress}:${status.port}`
      : null;

  // The request log rendered as plain text for a read-only textarea, so the
  // user can select and copy lines. Newest first; one request per line:
  //   "<HH:MM:SS> <ip> <status> <method> <path> (<entity>) [req] -> [resp]"
  // Request/response summaries come pre-redacted from the backend (sensitive
  // variable values are already masked to ***), so they are safe to show.
  const logText = log
    .slice()
    .reverse()
    .map((entry) => {
      const time = formatLogTime(entry.ts);
      const entity =
        entry.entityName !== undefined ? ` (${entry.entityName})` : "";
      const req =
        entry.requestSummary !== undefined ? ` ${entry.requestSummary}` : "";
      const resp =
        entry.responseSummary !== undefined ? ` -> ${entry.responseSummary}` : "";
      return `${time} ${entry.remoteAddr} ${entry.status} ${entry.method} ${entry.path}${entity}${req}${resp}`;
    })
    .join("\n");

  const panel = (
    <div
      className="http-server-panel__backdrop"
      onClick={handleBackdropClick}
    >
      <div
        className="http-server-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("httpServer.title")}
      >
        <header className="http-server-panel__header">
          <div className="http-server-panel__header-title">
            <h2 className="http-server-panel__title">{t("httpServer.title")}</h2>
            <HelpTooltip
              id="http-server-manual"
              buttonLabel={t("httpServer.manual.label")}
              body={t("httpServer.manual.body", {
                host:
                  status.mdnsHost ??
                  status.lanAddress ??
                  (status.bindLan ? "<this-machine-ip>" : "127.0.0.1"),
                port: status.port,
              })}
            />
          </div>
          <div className="http-server-panel__header-actions">
            {/* Live status (indicator + label) sits left of the run switch. */}
            <div className="http-server-panel__header-status">
              <span
                className={`http-server-panel__indicator ${indicatorState}`}
                aria-hidden="true"
              />
              <span className="http-server-panel__status-text">
                {statusLabel}
              </span>
            </div>
            {/* Run / stop the server via an iOS-style switch. */}
            <ToggleSwitch
              checked={status.running}
              onChange={() => void handleToggleServer()}
              disabled={busy}
              ariaLabel={
                status.running
                  ? t("httpServer.actions.stop")
                  : t("httpServer.actions.start")
              }
            />
            <button
              type="button"
              className="btn btn--icon"
              onClick={closePanel}
              aria-label={t("common.close")}
              title={t("common.close")}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        </header>

        <div className="http-server-panel__body">
          {/* Left column: addresses, settings, token (status + run toggle
              live in the header). */}
          <div className="http-server-panel__col">
          {/* Reachable addresses (LAN). Only while running. */}
          {status.running && (mdnsUrl !== null || lanUrl !== null) ? (
            <section className="http-server-panel__section http-server-panel__addresses">
              <h3 className="http-server-panel__section-title">
                {t("httpServer.address.title")}
              </h3>
              {mdnsUrl !== null ? (
                <div className="http-server-panel__address-row">
                  <code className="http-server-panel__address-value">{mdnsUrl}</code>
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon"
                    onClick={() => void handleCopyUrl(mdnsUrl)}
                    aria-label={t("httpServer.address.copy")}
                    title={t("httpServer.address.copy")}
                  >
                    {t("httpServer.address.copy")}
                  </button>
                </div>
              ) : null}
              {lanUrl !== null ? (
                <div className="http-server-panel__address-row">
                  <code className="http-server-panel__address-value">{lanUrl}</code>
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon"
                    onClick={() => void handleCopyUrl(lanUrl)}
                    aria-label={t("httpServer.address.copy")}
                    title={t("httpServer.address.copy")}
                  >
                    {t("httpServer.address.copy")}
                  </button>
                </div>
              ) : null}
              <p className="form-hint">{t("httpServer.address.hint")}</p>
            </section>
          ) : null}

          {error !== null ? (
            <p className="http-server-panel__error" role="alert">
              {localizeServerError(error, t)}
            </p>
          ) : null}

          {/* Settings */}
          <section className="http-server-panel__section">
            <h3 className="http-server-panel__section-title">
              {t("httpServer.settings.title")}
            </h3>

            <div className="form-field http-server-panel__field">
              <span className="http-server-panel__field-label">
                {t("httpServer.settings.port")}
              </span>
              <NumberStepper
                value={config.port}
                min={MIN_PORT}
                max={MAX_PORT}
                ariaLabel={t("httpServer.settings.port")}
                decrementLabel={t("httpServer.settings.portStepDown")}
                incrementLabel={t("httpServer.settings.portStepUp")}
                onChange={handlePortChange}
              />
            </div>

            <label className="http-server-panel__toggle">
              <input
                type="checkbox"
                checked={config.bindLan}
                onChange={handleToggleLan}
                disabled={busy}
              />
              <span className="http-server-panel__toggle-label">
                {t("httpServer.settings.bindLan")}
              </span>
            </label>
            {config.bindLan ? (
              <p className="http-server-panel__warning" role="note">
                {t("httpServer.settings.bindLanWarning")}
              </p>
            ) : (
              <p className="form-hint">{t("httpServer.settings.bindLocalHint")}</p>
            )}

            <label className="http-server-panel__toggle">
              <input
                type="checkbox"
                checked={config.logToConsole}
                onChange={handleToggleLogToConsole}
                disabled={busy}
              />
              <span className="http-server-panel__toggle-label">
                {t("httpServer.settings.logToConsole")}
              </span>
            </label>
          </section>

          {/* Token */}
          <section className="http-server-panel__section">
            <h3 className="http-server-panel__section-title">
              {t("httpServer.token.title")}
            </h3>
            <p className="form-hint">{t("httpServer.token.hint")}</p>

            {revealedToken !== null ? (
              <div className="http-server-panel__token-reveal">
                <code className="http-server-panel__token-value">{revealedToken}</code>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => void handleCopyToken()}
                >
                  {t("httpServer.token.copy")}
                </button>
              </div>
            ) : (
              <p className="http-server-panel__token-status">
                {hasToken
                  ? t("httpServer.token.present")
                  : t("httpServer.token.absent")}
              </p>
            )}

            <div className="http-server-panel__token-actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void handleRegenerateToken()}
                disabled={busy}
              >
                {hasToken
                  ? t("httpServer.token.regenerate")
                  : t("httpServer.token.generate")}
              </button>
              {hasToken ? (
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => void handleClearToken()}
                  disabled={busy}
                >
                  {t("httpServer.token.clear")}
                </button>
              ) : null}
            </div>
          </section>

          </div>

          {/* Right column: the live request log, scrolling on its own. */}
          <section className="http-server-panel__col http-server-panel__col--logs http-server-panel__section">
            <div className="http-server-panel__log-header">
              <h3 className="http-server-panel__section-title">
                {t("httpServer.log.title")}
              </h3>
              {log.length > 0 ? (
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => void handleClearLog()}
                >
                  {t("httpServer.log.clear")}
                </button>
              ) : null}
            </div>
            {log.length === 0 ? (
              <p className="form-hint">{t("httpServer.log.empty")}</p>
            ) : (
              <textarea
                className="http-server-panel__log"
                value={logText}
                readOnly
                spellCheck={false}
                wrap="soft"
                aria-label={t("httpServer.log.title")}
              />
            )}
          </section>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <button
        type="button"
        className={`http-server-indicator ${indicatorState}`}
        onClick={() => setOpen(true)}
        title={statusLabel}
        aria-label={statusLabel}
      >
        <span className="http-server-indicator__icon" aria-hidden="true">
          <ServerIcon />
        </span>
        <span className="http-server-indicator__label">
          {t("httpServer.indicator.label")}
        </span>
        <span className="http-server-indicator__dot" aria-hidden="true" />
      </button>
      {open ? createPortal(panel, document.body) : null}
    </>
  );
}
