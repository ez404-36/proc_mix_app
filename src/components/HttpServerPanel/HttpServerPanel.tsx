import { useCallback, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Message } from "@arco-design/web-react";
import { useShallow } from "zustand/react/shallow";
import { useHttpServerStore } from "../../stores/httpServerStore";
import type { HttpServerConfig } from "../../types/httpServer";
import { HelpTooltip } from "../HelpTooltip";
import { ToggleSwitch } from "../ToggleSwitch";
import { CancelIcon, CheckIcon, EditIcon, ServerIcon } from "../icons";

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
  // Port is read-only until the user clicks the pencil. While editing,
  // `portDraft` holds the raw input string so any value can be typed (no hard
  // clamp); "Apply" is gated on the draft parsing to a port in range.
  const [portEditing, setPortEditing] = useState(false);
  const [portDraft, setPortDraft] = useState("");

  const closePanel = useCallback((): void => {
    setOpen(false);
    setRevealedToken(null);
    setPortEditing(false);
  }, []);



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

  // Enter edit mode: seed the draft from the saved port.
  const startEditingPort = (): void => {
    setPortDraft(String(config.port));
    setPortEditing(true);
  };

  const cancelEditingPort = (): void => {
    setPortEditing(false);
  };

  // The draft parses to an integer port within the allowed range. Drives both
  // the "Apply" enabled state and the invalid-input styling.
  const parsedPort = Number.parseInt(portDraft, 10);
  const portDraftValid =
    /^\d+$/.test(portDraft.trim()) &&
    parsedPort >= MIN_PORT &&
    parsedPort <= MAX_PORT;

  // Apply the edited port. Only persists when it actually changed; either way
  // it leaves edit mode.
  const applyPort = (): void => {
    if (!portDraftValid) return;
    setPortEditing(false);
    if (parsedPort !== config.port) {
      void persist({ ...config, port: parsedPort });
    }
  };

  const handleToggleAutostart = (next: boolean): void => {
    void persist({ ...config, enabled: next });
  };

  const handleToggleLan = (next: boolean): void => {
    void persist({ ...config, bindLan: next });
  };

  const handleToggleLogToConsole = (next: boolean): void => {
    void persist({ ...config, logToConsole: next });
  };

  const handleToggleServeWebUi = (next: boolean): void => {
    void persist({ ...config, serveWebUi: next });
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
  // Settings (port + toggles) are locked while the server runs, so changes can't
  // trigger on-the-fly restarts. Applied as a per-control `disabled` (NOT a
  // `<fieldset disabled>`) so the read-only help tooltips stay usable.
  const settingsLocked = status.running;
  const statusLabel = status.running
    ? t("httpServer.status.running", { port: status.port })
    : t("httpServer.status.stopped");

  // Reachable addresses, as a single ordered list — shown whether the server is
  // running or stopped (so you can see/copy the addresses before starting). The
  // local loopback is always present; the friendly `procmix.local` mDNS name and
  // the raw LAN IP come from the status whenever a LAN IPv4 is detected (the
  // backend reports them even while stopped). When the web UI is enabled the
  // rows point at `/` (the SPA entry); otherwise they are the bare REST base.
  const webPath = config.serveWebUi ? "/" : "";
  const addressRows: ReadonlyArray<{ url: string; hintKey?: string }> = [
    // Local address — always available (the port is known from config).
    { url: `http://127.0.0.1:${status.port}${webPath}` },
    ...(status.mdnsHost !== undefined
      ? [
          {
            url: `http://${status.mdnsHost}:${status.port}${webPath}`,
            hintKey: "httpServer.address.mdnsHint",
          },
        ]
      : []),
    ...(status.lanAddress !== undefined
      ? [{ url: `http://${status.lanAddress}:${status.port}${webPath}` }]
      : []),
  ];

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

  // The modal closes ONLY via the explicit × button (closePanel) — not on a
  // backdrop click, so drag-selecting text inside the modal (e.g. the port
  // input) can't accidentally dismiss it.
  const panel = (
    <div className="http-server-panel__backdrop">
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
              className="btn btn--icon http-server-panel__close"
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
          {/* Reachable addresses. Only while running. The LAN names (mDNS +
              raw IP) and — when the web UI is enabled — the loopback browser URL
              all live in one section. The `procmix.local` caveat is a per-row
              tooltip rather than a section-wide hint. */}
          {addressRows.length > 0 ? (
            <section className="http-server-panel__section http-server-panel__addresses">
              <h3 className="http-server-panel__section-title">
                {t("httpServer.address.title")}
              </h3>
              {addressRows.map((row) => (
                <div key={row.url} className="http-server-panel__address-row">
                  <code className="http-server-panel__address-value">{row.url}</code>
                  {/* Fixed-width hint slot rendered on EVERY row (empty when the
                      row has no tooltip) so the value fields stay equal width and
                      the Copy buttons line up vertically across all rows. */}
                  <span className="http-server-panel__address-hint">
                    {row.hintKey ? (
                      <HelpTooltip
                        id={`http-server-addr-${row.url}`}
                        buttonLabel={t("httpServer.address.hintLabel")}
                        body={t(row.hintKey)}
                      />
                    ) : null}
                  </span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon"
                    onClick={() => void handleCopyUrl(row.url)}
                    aria-label={t("httpServer.address.copy")}
                    title={t("httpServer.address.copy")}
                  >
                    {t("httpServer.address.copy")}
                  </button>
                </div>
              ))}
            </section>
          ) : null}

          {error !== null ? (
            <p className="http-server-panel__error" role="alert">
              {localizeServerError(error, t)}
            </p>
          ) : null}

          {/* Settings — a bordered fieldset with a cut-out legend, matching the
              schedule form's section blocks. The whole block is DISABLED while
              the server runs: `<fieldset disabled>` natively disables every
              control inside (port input + buttons + all ToggleSwitches, which
              render native <button>s), so settings can only change while the
              server is stopped. This avoids on-the-fly restarts (and the
              port-conflict-drops-the-server edge case). */}
          <fieldset
            className={`http-server-panel__section http-server-panel__fieldset${
              settingsLocked ? " is-locked" : ""
            }`}
          >
            <legend className="http-server-panel__legend">
              {t("httpServer.settings.title")}
              {settingsLocked ? (
                <span className="http-server-panel__legend-note">
                  {" "}
                  {t("httpServer.settings.lockedSuffix")}
                </span>
              ) : null}
            </legend>

            <div className="form-field http-server-panel__field">
              <label className="form-field__label" htmlFor="http-server-port">
                {t("httpServer.settings.port")}
              </label>
              {portEditing ? (
                <div className="http-server-panel__port-edit">
                  <input
                    id="http-server-port"
                    type="number"
                    inputMode="numeric"
                    className={`input http-server-panel__port-input${
                      portDraftValid ? "" : " input--error"
                    }`}
                    value={portDraft}
                    autoFocus
                    aria-label={t("httpServer.settings.port")}
                    aria-invalid={!portDraftValid}
                    onChange={(e) => setPortDraft(e.target.value)}
                    onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        applyPort();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelEditingPort();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon"
                    onClick={applyPort}
                    disabled={!portDraftValid || busy}
                    aria-label={t("common.apply")}
                    title={t("common.apply")}
                  >
                    <CheckIcon />
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon"
                    onClick={cancelEditingPort}
                    aria-label={t("common.cancel")}
                    title={t("common.cancel")}
                  >
                    <CancelIcon />
                  </button>
                </div>
              ) : (
                <div className="http-server-panel__port-edit">
                  {/* Read mode: a non-editable input so the value reads as a
                      field (matching the edit input), with the pencil to edit. */}
                  <input
                    id="http-server-port"
                    type="text"
                    className="input http-server-panel__port-input"
                    value={config.port}
                    readOnly
                    aria-label={t("httpServer.settings.port")}
                  />
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon"
                    onClick={startEditingPort}
                    disabled={busy || settingsLocked}
                    aria-label={t("common.edit")}
                    title={t("common.edit")}
                  >
                    <EditIcon />
                  </button>
                </div>
              )}
              {portEditing && !portDraftValid ? (
                <p className="form-hint http-server-panel__port-hint">
                  {t("httpServer.errors.invalidPort", {
                    min: MIN_PORT,
                    max: MAX_PORT,
                  })}
                </p>
              ) : null}
            </div>

            <div className="http-server-panel__toggle">
              <ToggleSwitch
                checked={config.enabled}
                onChange={handleToggleAutostart}
                disabled={busy || settingsLocked}
                ariaLabel={t("httpServer.settings.autostart")}
              />
              <span className="http-server-panel__toggle-label">
                {t("httpServer.settings.autostart")}
              </span>
            </div>

            <div className="http-server-panel__toggle">
              <ToggleSwitch
                checked={config.bindLan}
                onChange={handleToggleLan}
                disabled={busy || settingsLocked}
                ariaLabel={t("httpServer.settings.bindLan")}
              />
              <span className="http-server-panel__toggle-label">
                {t("httpServer.settings.bindLan")}
              </span>
            </div>
            {config.bindLan ? (
              <p className="http-server-panel__warning" role="note">
                {t("httpServer.settings.bindLanWarning")}
              </p>
            ) : (
              <p className="form-hint">{t("httpServer.settings.bindLocalHint")}</p>
            )}

            <div className="http-server-panel__toggle">
              <ToggleSwitch
                checked={config.logToConsole}
                onChange={handleToggleLogToConsole}
                disabled={busy || settingsLocked}
                ariaLabel={t("httpServer.settings.logToConsole")}
              />
              <span className="http-server-panel__toggle-label">
                {t("httpServer.settings.logToConsole")}
              </span>
            </div>

            <div className="http-server-panel__toggle">
              <ToggleSwitch
                checked={config.serveWebUi}
                onChange={handleToggleServeWebUi}
                disabled={busy || settingsLocked}
                ariaLabel={t("httpServer.settings.serveWebUi")}
              />
              <span className="http-server-panel__toggle-label">
                {t("httpServer.settings.serveWebUi")}
              </span>
              <HelpTooltip
                id="http-server-serve-web-ui"
                buttonLabel={t("httpServer.settings.serveWebUiHintLabel")}
                body={t("httpServer.settings.serveWebUiHint")}
              />
            </div>
          </fieldset>

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

  // The indicator is a clickable row that ALSO contains the run/stop
  // ToggleSwitch (itself a <button>). A native <button> here would nest a
  // <button> inside a <button> — invalid HTML. So the row is a
  // `role="button"` div with keyboard activation (Enter/Space), and the inner
  // switch stays a real <button>; the toggle wrapper stops click/keydown from
  // bubbling so interacting with the switch never opens the panel.
  const openPanel = (): void => setOpen(true);
  const handleIndicatorKeyDown = (
    e: ReactKeyboardEvent<HTMLDivElement>,
  ): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openPanel();
    }
  };

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className={`http-server-indicator ${indicatorState}`}
        onClick={openPanel}
        onKeyDown={handleIndicatorKeyDown}
        title={statusLabel}
        aria-label={statusLabel}
      >
        <span className="http-server-indicator__icon" aria-hidden="true">
          <ServerIcon />
        </span>
        <span className="http-server-indicator__label">
          {t("httpServer.indicator.label")}
        </span>
        {/* Run / stop the server inline without opening the panel; the wrapper
            stops click/keydown from bubbling to the panel-opening row. */}
        <span
          className="http-server-indicator__toggle"
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
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
        </span>
      </div>
      {open ? createPortal(panel, document.body) : null}
    </>
  );
}
