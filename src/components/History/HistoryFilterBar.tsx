// Filter controls for the History view. Type multi-select, command
// name search (debounced), date range. State lives in the history
// store — this component is a thin controller binding inputs to it.

import { useEffect, useRef, useState, type ChangeEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useHistoryStore } from "../../stores/historyStore";
import type { HistoryEventKind } from "../../types";
import { DatePicker } from "../DatePicker/DatePicker";

/**
 * Chips in the type filter. Each entry represents one visible chip and maps
 * to one or more `HistoryEventKind` values that share the same human label.
 * This prevents duplicate chip labels (e.g. three separate "Запуск" chips).
 */
const KIND_GROUPS: ReadonlyArray<{
  labelKey: `history.kindLabels.${HistoryEventKind}`;
  kinds: ReadonlyArray<HistoryEventKind>;
}> = [
  { labelKey: "history.kindLabels.commandCreated",  kinds: ["commandCreated", "workflowCreated"] },
  { labelKey: "history.kindLabels.commandEdited",   kinds: ["commandEdited", "workflowEdited"] },
  { labelKey: "history.kindLabels.commandDeleted",  kinds: ["commandDeleted", "workflowDeleted"] },
  { labelKey: "history.kindLabels.commandRun",      kinds: ["commandRun", "workflowRun", "scheduledRun"] },
  { labelKey: "history.kindLabels.commandRestored", kinds: ["commandRestored"] },
  { labelKey: "history.kindLabels.commandReverted", kinds: ["commandReverted"] },
];

/**
 * Throttle / debounce trailing — invokes the callback `delayMs` after
 * the LAST call. Used on the text search so we don't hit IPC on every
 * keystroke. We re-implement instead of pulling in lodash to keep the
 * dependency footprint flat.
 */
function useDebouncedCallback<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  delayMs: number,
): (...args: TArgs) => void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);
  return (...args: TArgs) => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      fnRef.current(...args);
    }, delayMs);
  };
}

export function HistoryFilterBar(): ReactElement {
  const { t } = useTranslation();
  const filter = useHistoryStore((s) => s.filter);
  const setFilter = useHistoryStore((s) => s.setFilter);
  const resetFilter = useHistoryStore((s) => s.resetFilter);

  // Local mirror so the text input is controlled without forcing a
  // store update + IPC round-trip per keystroke. The debounced setter
  // syncs to the store after the user stops typing.
  const [nameInput, setNameInput] = useState<string>(filter.nameQuery);
  useEffect(() => {
    // Re-sync when the store changes externally (e.g. resetFilter).
    setNameInput(filter.nameQuery);
  }, [filter.nameQuery]);

  const debouncedSetName = useDebouncedCallback((value: string) => {
    setFilter({ nameQuery: value });
  }, 250);

  const handleNameChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const value = e.target.value;
    setNameInput(value);
    debouncedSetName(value);
  };

  // Date inputs use the native `<input type="date">`. The value is a
  // YYYY-MM-DD string; we expand to a full ISO timestamp before
  // shipping to the store so the SQL `created_at >= ?` and `<= ?`
  // comparisons make sense against ISO timestamps stored with
  // millisecond precision. The `T23:59:59.999Z` pad on `dateTo`
  // makes "today" inclusive — matching the user's mental model.
  const dateFromValue = filter.dateFrom?.slice(0, 10) ?? "";
  const dateToValue = filter.dateTo?.slice(0, 10) ?? "";

  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const dateToMax = dateToValue ? new Date(`${dateToValue}T23:59:59`) : today;
  const dateToMin = dateFromValue ? new Date(`${dateFromValue}T00:00:00`) : undefined;

  return (
    <div className="history-filter-bar">
      <div className="history-filter-bar__kinds" role="group" aria-label={t("history.filterByType")}>
        <label
          className={
            "history-filter-bar__chip" +
            (filter.failedOnly ? " history-filter-bar__chip--active" : "")
          }
        >
          <input
            type="checkbox"
            checked={filter.failedOnly}
            onChange={() => setFilter({ failedOnly: !filter.failedOnly })}
          />
          {t("history.filterFailedOnly")}
        </label>
        {KIND_GROUPS.map((group) => {
          const checked = group.kinds.some((k) => filter.kinds.includes(k));
          const handleChange = (): void => {
            const next = checked
              ? filter.kinds.filter((k) => !group.kinds.includes(k))
              : [...filter.kinds, ...group.kinds.filter((k) => !filter.kinds.includes(k))];
            setFilter({ kinds: next });
          };
          return (
            <label
              key={group.labelKey}
              className={
                "history-filter-bar__chip" +
                (checked ? " history-filter-bar__chip--active" : "")
              }
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={handleChange}
              />
              {t(group.labelKey)}
            </label>
          );
        })}
      </div>

      <input
        type="search"
        className="input"
        placeholder={t("history.filterNameQueryPlaceholder")}
        value={nameInput}
        onChange={handleNameChange}
        aria-label={t("history.filterByName")}
      />

      <div className="history-filter-bar__dates">
        <label className="history-filter-bar__date">
          <span>{t("history.filterByDateFrom")}</span>
          <DatePicker
            value={dateFromValue}
            onChange={(v) => setFilter({ dateFrom: v ? `${v}T00:00:00.000Z` : undefined })}
            placeholder={t("history.filterByDateFrom")}
            maxDate={dateToMax}
          />
        </label>
        <label className="history-filter-bar__date">
          <span>{t("history.filterByDateTo")}</span>
          <DatePicker
            value={dateToValue}
            onChange={(v) => setFilter({ dateTo: v ? `${v}T23:59:59.999Z` : undefined })}
            placeholder={t("history.filterByDateTo")}
            maxDate={today}
            minDate={dateToMin}
          />
        </label>
      </div>

      <button
        type="button"
        className="btn btn--ghost"
        onClick={() => resetFilter()}
      >
        {t("history.resetFilters")}
      </button>
    </div>
  );
}
