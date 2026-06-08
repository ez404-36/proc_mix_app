import { useEffect, useRef } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  /** Confirm button label. Defaults to `common.confirm`. */
  confirmLabel?: string;
  /** Cancel button label. Defaults to `common.cancel`. */
  cancelLabel?: string;
  /** Render the confirm button as destructive (`btn--danger`). */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * App-styled confirmation dialog. Mirrors `WorkflowMetaModal`'s portal/modal
 * mechanics (`createPortal` to `document.body`, `.command-form__backdrop`
 * backdrop that cancels on outside click, Esc cancels, the `command-form`
 * theme classes) so destructive confirmations look like the rest of the app
 * rather than the browser-native `window.confirm` dialog.
 *
 * Keyboard: Enter confirms, Esc cancels, backdrop click cancels. Initial
 * focus lands on the Cancel button — the safe default for a destructive
 * action, so an accidental Enter does not immediately confirm.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): ReactElement | null {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (open) {
      cancelRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      onConfirm();
    }
  };

  const handleBackdropClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) onCancel();
  };

  const confirmClass = danger ? "btn btn--danger" : "btn btn--primary";

  const modal = (
    <div
      className="command-form__backdrop"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      <div
        className="command-form command-form--confirm"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <h2 className="command-form__title">{title}</h2>
        <p className="command-form__message">{message}</p>

        <div className="command-form__actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn btn--ghost"
            onClick={onCancel}
          >
            {cancelLabel ?? t("common.cancel")}
          </button>
          <button type="button" className={confirmClass} onClick={onConfirm}>
            {confirmLabel ?? t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
