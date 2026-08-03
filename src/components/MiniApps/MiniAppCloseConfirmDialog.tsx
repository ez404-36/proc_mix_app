import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactElement } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../ToggleSwitch/ToggleSwitch";

interface MiniAppCloseConfirmDialogProps {
  open: boolean;
  /** Number of processes currently in flight, shown in the message. */
  processCount: number;
  /**
   * Called with the user's choice: `killChildren` mirrors the toggle's final
   * position (defaults to `true` — kill on close). Confirming ALWAYS closes
   * the window; the toggle only decides whether the active processes are
   * cancelled first.
   */
  onConfirm: (killChildren: boolean) => void;
  onCancel: () => void;
}

/**
 * Shown when the user tries to close a mini-app's standalone window while it
 * still has active processes (widget-triggered executions tracked by
 * `MiniAppActiveProcesses`). Offers a toggle — "Kill all child processes",
 * defaulting to ON — so the user can instead let them keep running
 * unsupervised (no console will observe them once the window is gone; this
 * is a deliberate escape hatch, not the recommended path).
 *
 * Mirrors `ConfirmDialog`'s portal/backdrop mechanics (backdrop click
 * cancels, initial focus on Cancel) but replaces the plain message with a
 * message + toggle row, since this is a choice, not a single yes/no.
 */
export function MiniAppCloseConfirmDialog({
  open,
  processCount,
  onConfirm,
  onCancel,
}: MiniAppCloseConfirmDialogProps): ReactElement | null {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  // Defaults to true ("kill on close") per the feature's default — reset
  // every time the dialog opens so a prior session's choice never leaks in.
  const [killChildren, setKillChildren] = useState(true);

  useEffect(() => {
    if (open) {
      setKillChildren(true);
      cancelRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  const handleBackdropClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) onCancel();
  };

  const modal = (
    <div className="command-form__backdrop" onClick={handleBackdropClick}>
      <div
        className="command-form command-form--confirm"
        role="dialog"
        aria-modal="true"
        aria-label={t("miniapps.runner.closeConfirm.title")}
      >
        <h2 className="command-form__title">
          {t("miniapps.runner.closeConfirm.title")}
        </h2>
        <p className="command-form__message">
          {t("miniapps.runner.closeConfirm.message", { count: processCount })}
        </p>

        <div className="settings-group settings-group--center settings-group--spaced-top">
          <ToggleSwitch
            checked={killChildren}
            onChange={setKillChildren}
            ariaLabel={t("miniapps.runner.closeConfirm.killToggle")}
          />
          <span className="settings-inline-label">
            {t("miniapps.runner.closeConfirm.killToggle")}
          </span>
        </div>

        <div className="command-form__actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn btn--ghost"
            onClick={onCancel}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => onConfirm(killChildren)}
          >
            {t("miniapps.runner.closeConfirm.confirm")}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
