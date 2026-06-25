import { useCallback, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateStore, type CheckResult } from "../../stores/updateStore";

export function UpdatesSection(): ReactElement {
  const { t } = useTranslation();

  // --------------------------------------------------------------
  // Update check (manual trigger from Settings).
  // --------------------------------------------------------------
  const checkForUpdate = useUpdateStore((s) => s.checkForUpdate);
  const openUpdateModal = useUpdateStore((s) => s.openModal);
  const updatePhase = useUpdateStore((s) => s.phase);
  const [updateCheckResult, setUpdateCheckResult] = useState<CheckResult | null>(null);

  const handleCheckForUpdate = useCallback(async (): Promise<void> => {
    setUpdateCheckResult(null);
    const result = await checkForUpdate();
    setUpdateCheckResult(result);
    if (result.status === "available") {
      openUpdateModal();
    }
  }, [checkForUpdate, openUpdateModal]);

  return (
    <section className="view-section">
      <h2 className="view-section__title">
        {t("settings.updates.title")}
      </h2>
      <div className="empty-state settings-info">
        <div className="settings-group settings-group--tight">
          <button
            type="button"
            className="btn btn--primary"
            disabled={updatePhase !== "idle"}
            onClick={() => void handleCheckForUpdate()}
          >
            {updatePhase === "checking"
              ? t("settings.updates.checking")
              : t("settings.updates.checkBtn")}
          </button>
        </div>
        {updateCheckResult?.status === "up-to-date" && (
          <div className="data-status data-status--success" role="status">
            {t("settings.updates.upToDate")}
          </div>
        )}
        {updateCheckResult?.status === "error" && (
          <div className="data-status data-status--error" role="status">
            {t("settings.updates.checkError")}: {updateCheckResult.message}
          </div>
        )}
      </div>
    </section>
  );
}
