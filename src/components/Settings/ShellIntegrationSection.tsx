import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Message } from "@arco-design/web-react";
import { ToggleSwitch } from "../ToggleSwitch";
import {
  getShellIntegrationStatus,
  setShellIntegration,
} from "../../services/shellIntegrationService";

/**
 * Settings → System → Explorer integration. Lets the user add a "ProcMix"
 * submenu to the OS file-manager right-click menu listing their favorite
 * commands / workflows (v0.12.0).
 *
 * `enabled` is the OS-registration source of truth (Windows `HKCU\Software\
 * Classes` keys / Linux `.desktop` file), read live on mount — never SQLite —
 * so it stays correct even if the user removed the registration by hand.
 * `supported` is false on platforms without a backend (macOS / other); the
 * toggle is hidden then and only an explanatory caption is shown.
 */
export function ShellIntegrationSection(): ReactElement {
  const { t } = useTranslation();

  const [supported, setSupported] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await getShellIntegrationStatus();
        if (cancelled) return;
        setSupported(status.supported);
        setEnabled(status.enabled);
      } catch {
        if (cancelled) return;
        Message.error(t("settings.shellIntegration.loadError"));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  // Apply a change to the OS registration. On failure we reload the live status
  // so the UI never drifts from the actual OS state.
  const apply = useCallback(
    async (next: boolean): Promise<void> => {
      setBusy(true);
      try {
        await setShellIntegration(next);
        setEnabled(next);
      } catch {
        Message.error(t("settings.shellIntegration.saveError"));
        try {
          const status = await getShellIntegrationStatus();
          setSupported(status.supported);
          setEnabled(status.enabled);
        } catch {
          // Keep the current UI state; the error toast already informed the user.
        }
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  return (
    <section className="view-section">
      <h2 className="view-section__title">
        {t("settings.shellIntegration.title")}
      </h2>
      <div className="empty-state settings-info">
        <div className="settings-info__lead">
          {t("settings.shellIntegration.description")}
        </div>

        {supported ? (
          <>
            <div className="settings-group settings-group--center settings-group--spaced-top">
              <ToggleSwitch
                checked={enabled}
                disabled={!loaded || busy}
                onChange={(next) => void apply(next)}
                ariaLabel={t("settings.shellIntegration.toggleLabel")}
              />
              <span className="settings-inline-label">
                {t("settings.shellIntegration.toggleLabel")}
              </span>
            </div>
            <div className="settings-caption settings-caption--spaced">
              {t("settings.shellIntegration.pathHint")}
            </div>
          </>
        ) : (
          <div className="settings-caption settings-caption--spaced">
            {t("settings.shellIntegration.unsupported")}
          </div>
        )}
      </div>
    </section>
  );
}
