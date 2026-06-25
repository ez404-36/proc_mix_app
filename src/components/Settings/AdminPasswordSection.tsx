import { type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ClearIcon, EditIcon } from "../icons";
import { useAdminPasswordSection } from "./useAdminPasswordSection";

export function AdminPasswordSection(): ReactElement {
  const { t } = useTranslation();
  const {
    isWindows,
    adminPasswordStored,
    handleSetAdminPassword,
    handleClearAdminPassword,
  } = useAdminPasswordSection();

  return (
    <section className="view-section">
      <h2 className="view-section__title">
        {t("settings.admin.title", {
          defaultValue: "Administrator privileges",
        })}
      </h2>
      {isWindows ? (
        /*
         * Windows path: UAC handles elevation at the OS level. No
         * password is stored or queried by our app — surfacing
         * Set/Clear buttons would be misleading.
         */
        <div className="empty-state settings-info">
          <div className="settings-info__body">
            {t("settings.admin.windowsHint", {
              defaultValue:
                "Not used on Windows — UAC handles elevation when a command is marked Run as administrator.",
            })}
          </div>
        </div>
      ) : (
        <div className="empty-state settings-info">
          <div className="settings-info__lead">
            {adminPasswordStored
              ? t("settings.admin.statusSaved", {
                  defaultValue:
                    "Sudo password is saved in your OS keychain.",
                })
              : t("settings.admin.statusEmpty", {
                  defaultValue: "No sudo password is saved yet.",
                })}
          </div>
          <div className="settings-group settings-group--tight">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void handleSetAdminPassword()}
            >
              <EditIcon />
              {adminPasswordStored
                ? t("settings.admin.changeBtn", {
                    defaultValue: "Change password…",
                  })
                : t("settings.admin.setBtn", {
                    defaultValue: "Set password…",
                  })}
            </button>
            {adminPasswordStored ? (
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => void handleClearAdminPassword()}
              >
                <ClearIcon />
                {t("settings.admin.clearBtn", {
                  defaultValue: "Clear saved password",
                })}
              </button>
            ) : null}
          </div>
          <div className="settings-caption settings-caption--spaced">
            {t("settings.admin.subhint", {
              defaultValue:
                "Stored securely in your OS keychain. Never written to disk by ProcMix.",
            })}
          </div>
        </div>
      )}
    </section>
  );
}
