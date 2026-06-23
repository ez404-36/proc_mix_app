import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactElement } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { NumberStepper } from "../NumberStepper";
import type { HistoryClearRange } from "../../utils/historyClearRange";

interface HistoryClearDialogProps {
  open: boolean;
  onConfirm: (range: HistoryClearRange) => void;
  onCancel: () => void;
}

/** The selectable preset ranges, in display order. `olderThanDays` carries
 *  its own day count from the stepper. */
type RangeKind = HistoryClearRange["kind"];

const RANGE_ORDER: ReadonlyArray<RangeKind> = [
  "lastHour",
  "today",
  "lastWeek",
  "olderThanDays",
  "all",
];

const RANGE_LABEL_KEY: Record<RangeKind, string> = {
  lastHour: "history.clearRange.lastHour",
  today: "history.clearRange.today",
  lastWeek: "history.clearRange.lastWeek",
  olderThanDays: "history.clearRange.olderThanDays",
  all: "history.clearRange.all",
};

const DEFAULT_DAYS = 30;

/**
 * Range-aware "Clear history" dialog. Lets the user choose which slice of the
 * journal to drop (last hour / today / last week / older than N days / all
 * time). The "older than N days" option reveals a `NumberStepper` for the day
 * count, matching the app's numeric-input convention. Portal/modal mechanics
 * mirror `ConfirmDialog` (backdrop cancels, Esc cancels, `command-form`
 * theme); the confirm button is always destructive.
 */
export function HistoryClearDialog({
  open,
  onConfirm,
  onCancel,
}: HistoryClearDialogProps): ReactElement | null {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [selected, setSelected] = useState<RangeKind>("lastHour");
  const [days, setDays] = useState<number>(DEFAULT_DAYS);

  // Reset to the safe default selection every time the dialog opens, and move
  // focus to Cancel so an accidental Enter does not wipe history.
  useEffect(() => {
    if (open) {
      setSelected("lastHour");
      setDays(DEFAULT_DAYS);
      cancelRef.current?.focus();
    }
  }, [open]);

  if (!open) return null;

  const buildRange = (): HistoryClearRange =>
    selected === "olderThanDays"
      ? { kind: "olderThanDays", days }
      : { kind: selected };

  const handleConfirm = (): void => {
    onConfirm(buildRange());
  };

  const handleBackdropClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) onCancel();
  };

  const modal = (
    <div className="command-form__backdrop" onClick={handleBackdropClick}>
      <div
        className="command-form command-form--confirm"
        role="dialog"
        aria-modal="true"
        aria-label={t("history.clearConfirmTitle")}
      >
        <h2 className="command-form__title">
          {t("history.clearConfirmTitle")}
        </h2>
        <p className="command-form__message">{t("history.clearRange.prompt")}</p>

        <div className="history-clear__options" role="radiogroup">
          {RANGE_ORDER.map((kind) => (
            <label key={kind} className="history-clear__option">
              <input
                type="radio"
                name="history-clear-range"
                value={kind}
                checked={selected === kind}
                onChange={() => setSelected(kind)}
              />
              <span>{t(RANGE_LABEL_KEY[kind])}</span>
            </label>
          ))}
        </div>

        {selected === "olderThanDays" && (
          <div className="form-field history-clear__days">
            <label className="form-field__label">
              {t("history.clearRange.daysLabel")}
            </label>
            <NumberStepper
              value={days}
              min={1}
              max={3650}
              onChange={setDays}
              ariaLabel={t("history.clearRange.daysLabel")}
              decrementLabel={t("common.decrement", {
                defaultValue: "Decrease",
              })}
              incrementLabel={t("common.increment", {
                defaultValue: "Increase",
              })}
            />
          </div>
        )}

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
            onClick={handleConfirm}
          >
            {t("common.clear")}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
