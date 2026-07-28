import type { MouseEvent as ReactMouseEvent, ReactElement } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { CancelIcon } from "../icons";
import { ToggleSwitch } from "../ToggleSwitch";
import { HttpServerQrCode } from "./HttpServerQrCode";

interface HttpServerQrModalProps {
  /** The URL to encode. `null` keeps the modal unmounted. */
  url: string | null;
  onClose: () => void;
  /**
   * When provided, renders the "Include token in QR" toggle INSIDE the modal
   * (so it can be flipped without closing the modal to reach the panel body
   * behind it) plus its security warning while on. Omitted entirely — no
   * toggle, no warning — for the address-only QR, which has no token to
   * include. `checked` is the controlled current state; `onChange` reports
   * the requested next state to the caller, which owns it (and swaps `url`
   * between the address-only and address+token variants accordingly).
   */
  includeToken?: {
    checked: boolean;
    onChange: (next: boolean) => void;
  };
}

/**
 * Standalone modal that shows one QR code at a comfortably scannable size,
 * with a hint that it can be scanned with a phone/tablet camera. Mirrors
 * {@link ConfirmDialog}'s portal/modal mechanics (`createPortal` to
 * `document.body`, `.command-form__backdrop` that closes on outside click,
 * the `command-form` theme classes) — Escape intentionally does NOT close it,
 * matching every other modal in the app; it closes only via the explicit
 * close button or a backdrop click.
 */
export function HttpServerQrModal({
  url,
  onClose,
  includeToken,
}: HttpServerQrModalProps): ReactElement | null {
  const { t } = useTranslation();
  if (url === null) return null;

  const handleBackdropClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) onClose();
  };

  const modal = (
    <div className="command-form__backdrop" onClick={handleBackdropClick}>
      <div
        className="command-form command-form--qr"
        role="dialog"
        aria-modal="true"
        aria-label={t("httpServer.qr.title")}
      >
        <div className="http-server-panel__qr-modal-header">
          <h2 className="command-form__title">{t("httpServer.qr.title")}</h2>
          <button
            type="button"
            className="btn btn--icon http-server-panel__close"
            onClick={onClose}
            aria-label={t("common.close")}
            title={t("common.close")}
          >
            <CancelIcon />
          </button>
        </div>
        <p className="http-server-panel__qr-modal-hint">
          {t("httpServer.qr.scanHint")}
        </p>
        {includeToken ? (
          <div className="http-server-panel__toggle http-server-panel__qr-modal-toggle">
            <ToggleSwitch
              checked={includeToken.checked}
              onChange={includeToken.onChange}
              ariaLabel={t("httpServer.qr.includeToken")}
            />
            <span className="http-server-panel__toggle-label">
              {t("httpServer.qr.includeToken")}
            </span>
          </div>
        ) : null}
        {includeToken?.checked ? (
          <p className="http-server-panel__warning" role="note">
            {t("httpServer.qr.includeTokenWarning")}
          </p>
        ) : null}
        <div className="http-server-panel__qr-modal-body">
          <HttpServerQrCode url={url} size={220} />
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
