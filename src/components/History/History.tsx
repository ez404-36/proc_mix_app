// Top-level "History" view: filter bar, paginated list of events,
// "Clear history" action. Filters and pagination are pushed to the
// Rust layer through `useHistoryStore.load()` so the on-disk row
// count, not the React state size, is the constraint.
//
// Lifecycle:
//   - Mount → trigger a `load` once. The store handles `setFilter`,
//     `setPage`, etc. and refetches on every change.
//   - We DO NOT subscribe to `commandStore` mutations — the History
//     view is a snapshot of the journal, not a live mirror of the
//     current command set. Refresh happens on the next user action
//     (undo, restore, filter change).

import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { HISTORY_PAGE_SIZE, useHistoryStore } from "../../stores/historyStore";
import type { HistoryClearRange } from "../../utils/historyClearRange";
import { ConfirmDialog } from "../ConfirmDialog";
import { HistoryClearDialog } from "./HistoryClearDialog";
import { HistoryFilterBar } from "./HistoryFilterBar";
import { HistoryRow } from "./HistoryRow";

export function History(): ReactElement {
  const { t } = useTranslation();
  const items = useHistoryStore((s) => s.items);
  const total = useHistoryStore((s) => s.total);
  const page = useHistoryStore((s) => s.page);
  const loading = useHistoryStore((s) => s.loading);
  const error = useHistoryStore((s) => s.error);
  const load = useHistoryStore((s) => s.load);
  const setPage = useHistoryStore((s) => s.setPage);
  const clearAll = useHistoryStore((s) => s.clearAll);
  const filter = useHistoryStore((s) => s.filter);
  const selectedIds = useHistoryStore((s) => s.selectedIds);
  const toggleSelected = useHistoryStore((s) => s.toggleSelected);
  const deleteSelected = useHistoryStore((s) => s.deleteSelected);

  // Filter panel is hidden by default; the user reveals it by clicking
  // the "Filters" toggle in the header. We preserve filter VALUES in
  // the store across show/hide so re-opening shows what was last set.
  // The badge on the toggle reflects how many filter dimensions are
  // active — so a hidden panel with an active filter isn't an
  // invisible state.
  const [filtersOpen, setFiltersOpen] = useState<boolean>(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState<boolean>(false);
  const [deleteSelectedConfirmOpen, setDeleteSelectedConfirmOpen] =
    useState<boolean>(false);

  // Trigger an initial load on mount. We deliberately use `load`
  // (which reads the current filter + page from store state) instead
  // of resetting them — the user might navigate away from History and
  // come back, and we want to preserve their filter selection.
  useEffect(() => {
    void load();
    // We re-run when the user changes the language so any localized
    // sort order or formatter we add later picks it up. The load()
    // closure is stable (Zustand action identity).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE)),
    [total],
  );

  // Count of active filter dimensions. Drives:
  //   - the "no results" vs "no events yet" empty-state distinction:
  //     the former is recoverable (clear filters), the latter is just
  //     an empty history.
  //   - the badge on the "Filters" toggle so users know a hidden
  //     panel still has filters applied. We count dimensions, not
  //     items inside a dimension, so "3 kinds selected" still reads as
  //     one active filter.
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filter.kinds.length > 0) count += 1;
    if (filter.nameQuery.trim() !== "") count += 1;
    if (filter.dateFrom !== undefined) count += 1;
    if (filter.dateTo !== undefined) count += 1;
    return count;
  }, [filter]);
  const filterActive = activeFilterCount > 0;

  const handleClearConfirmed = (range: HistoryClearRange): void => {
    setClearConfirmOpen(false);
    void clearAll(range);
  };

  const selectedCount = selectedIds.length;
  const handleDeleteSelectedConfirmed = (): void => {
    setDeleteSelectedConfirmOpen(false);
    void deleteSelected();
  };

  return (
    <div>
      <header className="view-header">
        <div>
          <h1 className="view-title">{t("history.title")}</h1>
          <p className="view-subtitle">{t("history.subtitle")}</p>
        </div>
        <div className="view-header__actions">
          {selectedCount > 0 && (
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => setDeleteSelectedConfirmOpen(true)}
            >
              {t("history.deleteSelected", { count: selectedCount })}
            </button>
          )}
          <button
            type="button"
            className={
              "btn btn--ghost" + (filterActive ? " btn--has-badge" : "")
            }
            onClick={() => setFiltersOpen((open) => !open)}
            aria-expanded={filtersOpen}
            aria-controls="history-filter-panel"
          >
            {filtersOpen
              ? t("history.hideFilters")
              : t("history.showFilters")}
            {filterActive && (
              <span className="btn__badge" aria-hidden="true">
                {activeFilterCount}
              </span>
            )}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setClearConfirmOpen(true)}
            disabled={total === 0}
          >
            {t("history.clearAll")}
          </button>
        </div>
      </header>

      {filtersOpen && (
        <div id="history-filter-panel">
          <HistoryFilterBar />
        </div>
      )}

      {error !== undefined && (
        <div className="empty-state" role="alert">
          {error}
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="empty-state">{t("history.loading")}</div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          {filterActive ? t("history.noResults") : t("history.noEvents")}
        </div>
      ) : (
        <ul className="history-list">
          {items.map((evt) => (
            <HistoryRow
              key={evt.id}
              event={evt}
              selected={selectedIds.includes(evt.id)}
              onToggleSelect={toggleSelected}
            />
          ))}
        </ul>
      )}

      {totalPages > 1 && (
        <nav
          className="history-pagination"
          aria-label={t("history.title")}
        >
          <button
            type="button"
            className="btn btn--ghost"
            disabled={page <= 1 || loading}
            onClick={() => setPage(page - 1)}
          >
            ‹
          </button>
          <span className="history-pagination__label">
            {t("history.pageLabel", { page, pages: totalPages })}
          </span>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={page >= totalPages || loading}
            onClick={() => setPage(page + 1)}
          >
            ›
          </button>
        </nav>
      )}

      <HistoryClearDialog
        open={clearConfirmOpen}
        onConfirm={handleClearConfirmed}
        onCancel={() => setClearConfirmOpen(false)}
      />

      <ConfirmDialog
        open={deleteSelectedConfirmOpen}
        title={t("history.deleteSelectedConfirmTitle")}
        message={t("history.deleteSelectedConfirm", { count: selectedCount })}
        confirmLabel={t("common.delete")}
        danger
        onConfirm={handleDeleteSelectedConfirmed}
        onCancel={() => setDeleteSelectedConfirmOpen(false)}
      />
    </div>
  );
}
