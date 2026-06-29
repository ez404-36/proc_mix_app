import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Message } from "@arco-design/web-react";
import { ToggleSwitch } from "../ToggleSwitch";
import {
  getAutostartStatus,
  setAutostart,
} from "../../services/autostartService";

/**
 * Settings → Autostart. Lets the user launch ProcMix at system login, with an
 * optional "start minimized to tray" sub-flag.
 *
 * The mode is presented as segmented `theme-option` buttons (consistent with the
 * Appearance section's theme/language pickers). `enabled` is the OS-registration
 * source of truth, read live on mount; the sub-flag is a persisted ProcMix
 * preference shown only when autostart is on.
 */
export function AutostartSection(): ReactElement {
  const { t } = useTranslation();

  const [enabled, setEnabled] = useState(false);
  const [startMinimized, setStartMinimized] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await getAutostartStatus();
        if (cancelled) return;
        setEnabled(status.enabled);
        setStartMinimized(status.startMinimized);
      } catch {
        if (cancelled) return;
        Message.error(t("settings.autostart.loadError"));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  // Apply a change to both the OS registration and the persisted sub-flag. On
  // failure we reload the live status so the UI never drifts from the OS.
  const apply = useCallback(
    async (nextEnabled: boolean, nextMinimized: boolean): Promise<void> => {
      setBusy(true);
      try {
        await setAutostart(nextEnabled, nextMinimized);
        setEnabled(nextEnabled);
        setStartMinimized(nextMinimized);
      } catch {
        Message.error(t("settings.autostart.saveError"));
        try {
          const status = await getAutostartStatus();
          setEnabled(status.enabled);
          setStartMinimized(status.startMinimized);
        } catch {
          // Keep the current UI state if even the reload fails; the error
          // toast above already informed the user.
        }
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  return (
    <section className="view-section">
      <h2 className="view-section__title">{t("settings.autostart.title")}</h2>
      <div className="empty-state settings-info">
        <div className="settings-info__lead">
          {t("settings.autostart.description")}
        </div>

        <div className="settings-group">
          <button
            type="button"
            className={`theme-option${!enabled ? " is-active" : ""}`}
            disabled={!loaded || busy}
            onClick={() => void apply(false, startMinimized)}
          >
            {t("settings.autostart.modeOff")}
          </button>
          <button
            type="button"
            className={`theme-option${enabled ? " is-active" : ""}`}
            disabled={!loaded || busy}
            onClick={() => void apply(true, startMinimized)}
          >
            {t("settings.autostart.modeOn")}
          </button>
        </div>

        {enabled ? (
          <div className="settings-group settings-group--center settings-group--spaced-top">
            <ToggleSwitch
              checked={startMinimized}
              disabled={busy}
              onChange={(next) => void apply(true, next)}
              ariaLabel={t("settings.autostart.startMinimized")}
            />
            <span className="settings-inline-label">
              {t("settings.autostart.startMinimized")}
            </span>
          </div>
        ) : null}

        <div className="settings-caption settings-caption--spaced">
          {t("settings.autostart.subhint")}
        </div>
      </div>
    </section>
  );
}
