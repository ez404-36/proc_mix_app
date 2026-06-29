// History view (F7) — read-only, paginated run history.
//
// Mirrors the desktop History shell (header + list + pager) but VIEW-ONLY: no
// "Clear history", no filters panel, no select/delete/restore/cancel — the web
// History only surfaces runs of API-enabled entities (server-filtered, B2) for
// inspection. Output expands inline per row.

import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { HISTORY_PAGE_SIZE, useHistoryStore } from "../stores/historyStore";
import { HistoryRow } from "../components/HistoryRow";

export function History(): React.JSX.Element {
  const { t } = useTranslation();
  const items = useHistoryStore((s) => s.items);
  const total = useHistoryStore((s) => s.total);
  const page = useHistoryStore((s) => s.page);
  const loading = useHistoryStore((s) => s.loading);
  const error = useHistoryStore((s) => s.error);
  const load = useHistoryStore((s) => s.load);
  const setPage = useHistoryStore((s) => s.setPage);

  useEffect(() => {
    void load();
    // Stable Zustand action identity; load reads the current page from state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE)),
    [total],
  );

  return (
    <div>
      <header className="view-header">
        <div>
          <h1 className="view-title">{t("history.title")}</h1>
          <p className="view-subtitle">{t("history.subtitle")}</p>
        </div>
      </header>

      {error ? (
        <div className="empty-state empty-state--error" role="alert">
          {t("web.error.load", "Could not load. Check your connection.")}
        </div>
      ) : loading && items.length === 0 ? (
        <div className="empty-state">{t("history.loading", "Loading…")}</div>
      ) : items.length === 0 ? (
        <div className="empty-state">{t("history.noEvents", "No runs yet.")}</div>
      ) : (
        <ul className="history-list">
          {items.map((evt) => (
            <HistoryRow key={evt.id} event={evt} />
          ))}
        </ul>
      )}

      {totalPages > 1 ? (
        <nav className="history-pagination" aria-label={t("history.title")}>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={page <= 1 || loading}
            onClick={() => void setPage(page - 1)}
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
            onClick={() => void setPage(page + 1)}
          >
            ›
          </button>
        </nav>
      ) : null}
    </div>
  );
}
