import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Message } from "@arco-design/web-react";
import { ToggleSwitch } from "../ToggleSwitch";
import {
  getWindowBehavior,
  setWindowBehavior,
} from "../../services/windowBehaviorService";

/**
 * Settings → Tray. Explains the tray behaviour and lets the user choose what
 * closing the main window does: hide to the tray (default) or quit ProcMix.
 *
 * The `closeToTray` flag is persisted in SQLite and mirrored into a backend
 * runtime cache, so toggling it takes effect on the very next window close
 * without a restart.
 */
export function TraySection(): ReactElement {
  const { t } = useTranslation();

  const [closeToTray, setCloseToTray] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await getWindowBehavior();
        if (cancelled) return;
        setCloseToTray(cfg.closeToTray);
      } catch {
        if (cancelled) return;
        Message.error(t("settings.tray.loadError"));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  // Persist a change, reloading the live value on failure so the UI never
  // drifts from what the backend actually holds.
  const apply = useCallback(
    async (next: boolean): Promise<void> => {
      setBusy(true);
      try {
        await setWindowBehavior(next);
        setCloseToTray(next);
      } catch {
        Message.error(t("settings.tray.saveError"));
        try {
          const cfg = await getWindowBehavior();
          setCloseToTray(cfg.closeToTray);
        } catch {
          // Keep current UI state; the error toast already informed the user.
        }
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  return (
    <section className="view-section">
      <h2 className="view-section__title">{t("settings.tray.title")}</h2>
      <div className="empty-state settings-info">
        <div className="settings-info__line">{t("settings.tray.primary")}</div>
        <div className="settings-caption">{t("settings.tray.secondary")}</div>

        <div className="settings-group settings-group--center settings-group--spaced-top">
          <ToggleSwitch
            checked={closeToTray}
            disabled={!loaded || busy}
            onChange={(next) => void apply(next)}
            ariaLabel={t("settings.tray.closeToTrayLabel")}
          />
          <span className="settings-inline-label">
            {t("settings.tray.closeToTrayLabel")}
          </span>
        </div>
        <div className="settings-caption settings-caption--spaced">
          {closeToTray
            ? t("settings.tray.closeToTrayOnHint")
            : t("settings.tray.closeToTrayOffHint")}
        </div>
      </div>
    </section>
  );
}
