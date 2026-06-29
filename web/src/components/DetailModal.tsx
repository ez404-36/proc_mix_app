// Read-only detail modal shell (F4/F5 detail).
//
// Shared chrome for the command/workflow detail modals: portals to
// document.body, closes on backdrop click and Esc, traps initial focus on the
// primary action, and renders the standard `command-form` modal frame. View +
// run only — there is no Edit/Delete here (the web UI never mutates entities).

import { useEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { CancelIcon } from "@app/components/icons/CancelIcon";
import { RunIcon } from "@app/components/icons/RunIcon";

interface DetailModalProps {
  title: string;
  ariaLabel: string;
  /** Meta chips row (badges/tags) under the title. */
  meta?: ReactNode;
  description?: string;
  children: ReactNode;
  runLabel: string;
  onRun: () => void;
  onClose: () => void;
}

export function DetailModal({
  title,
  ariaLabel,
  meta,
  description,
  children,
  runLabel,
  onRun,
  onClose,
}: DetailModalProps): React.JSX.Element {
  const { t } = useTranslation();
  const runRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    runRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleBackdropClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) onClose();
  };

  const modal = (
    <div className="command-form__backdrop" onClick={handleBackdropClick}>
      <div
        className="command-form command-form--view command-view"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
      >
        <div className="workflow-view__header">
          <div className="workflow-view__heading">
            <h2 className="command-form__title">{title}</h2>
          </div>
          {meta ? <div className="list-tile__meta">{meta}</div> : null}
        </div>

        {description ? (
          <p className="workflow-view__description">{description}</p>
        ) : null}

        <div className="command-view__body">{children}</div>

        <div className="command-form__actions">
          <button
            type="button"
            className="btn command-form__action command-form__action--cancel"
            onClick={onClose}
          >
            <span className="command-form__action-icon--cancel">
              <CancelIcon />
            </span>
            {t("common.close")}
          </button>
          <button
            ref={runRef}
            type="button"
            className="btn command-form__action command-form__action--run"
            onClick={onRun}
          >
            <span className="command-form__action-icon--run">
              <RunIcon />
            </span>
            {runLabel}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
