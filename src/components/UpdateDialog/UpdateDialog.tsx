import { useEffect, useRef } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useUpdateStore } from "../../stores/updateStore";
import { useAppVersion } from "../../hooks/useAppVersion";

const RELEASES_URL = "https://github.com/ez404-36/proc_mix_app/releases";

interface UpdateDialogProps {
  open: boolean;
  onClose: () => void;
}

export function UpdateDialog({
  open,
  onClose,
}: UpdateDialogProps): ReactElement | null {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const appVersion = useAppVersion();

  const info = useUpdateStore((s) => s.info);
  const phase = useUpdateStore((s) => s.phase);
  const downloadProgress = useUpdateStore((s) => s.downloadProgress);
  const error = useUpdateStore((s) => s.error);
  const installUpdate = useUpdateStore((s) => s.installUpdate);

  const isBusy = phase === "checking" || phase === "downloading" || phase === "installing";

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  if (!open || !info) return null;

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape" && !isBusy) {
      e.preventDefault();
      onClose();
    }
  };

  const handleBackdropClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget && !isBusy) onClose();
  };

  const handleOpenReleases = (): void => {
    void openUrl(RELEASES_URL);
  };

  const progressPercent = Math.round(downloadProgress * 100);

  const modal = (
    <div
      className="command-form__backdrop"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      <div
        className="command-form command-form--update"
        role="dialog"
        aria-modal="true"
        aria-label={t("update.title")}
      >
        <h2 className="command-form__title">{t("update.title")}</h2>

        <div className="update-dialog__version">
          {appVersion ? `v${appVersion}` : "—"} → v{info.version}
        </div>

        {info.body && (
          <div className="update-dialog__notes">
            <h3 className="update-dialog__notes-heading">
              {t("update.releaseNotes")}
            </h3>
            <pre className="update-dialog__notes-body">{info.body}</pre>
          </div>
        )}

        <button
          type="button"
          className="update-dialog__link"
          onClick={handleOpenReleases}
        >
          {t("update.allChanges")}
        </button>

        {(phase === "downloading" || phase === "installing") && (
          <div className="update-dialog__progress">
            <div className="update-dialog__progress-bar">
              <div
                className="update-dialog__progress-fill"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <span className="update-dialog__progress-label">
              {phase === "installing"
                ? t("update.installing")
                : t("update.downloading", { percent: progressPercent })}
            </span>
          </div>
        )}

        {error && (
          <p className="update-dialog__error">{t("update.error")}: {error}</p>
        )}

        <div className="command-form__actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn btn--ghost"
            onClick={onClose}
            disabled={isBusy}
          >
            {t("update.later")}
          </button>
          <button
            type="button"
            className="btn btn--run"
            onClick={() => void installUpdate()}
            disabled={isBusy}
          >
            {phase === "checking"
              ? t("update.checking")
              : phase === "downloading"
                ? t("update.downloading", { percent: progressPercent })
                : phase === "installing"
                  ? t("update.installing")
                  : error
                    ? t("update.retry")
                    : t("update.updateNow")}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
