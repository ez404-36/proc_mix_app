// Home view (F4) — library overview: favorites + recent activity.
//
// Mirrors the desktop Home (favorites section + recent-activity section) but
// view + run only: the cards have no edit/delete/favorite controls. Data comes
// from the shared entities store (the enriched list endpoints carry `favorite`
// and `lastRunAt`, so both sections are derived client-side without extra
// fetches).

import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useEntitiesStore } from "../stores/entitiesStore";
import { EntityCard } from "../components/EntityCard";
import { useEntityActions } from "../hooks/useEntityActions";

const RECENT_LIMIT = 5;

export function Home(): React.JSX.Element {
  const { t } = useTranslation();
  const entities = useEntitiesStore((s) => s.entities);
  const isLoading = useEntitiesStore((s) => s.isLoading);
  const error = useEntitiesStore((s) => s.error);
  const loaded = useEntitiesStore((s) => s.loaded);
  const load = useEntitiesStore((s) => s.load);
  const { openDetail, requestRun, modals } = useEntityActions();

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const favorites = useMemo(
    () => entities.filter((e) => e.favorite),
    [entities],
  );

  const recent = useMemo(
    () =>
      entities
        .filter((e) => e.lastRunAt !== undefined)
        .slice()
        .sort((a, b) => (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? ""))
        .slice(0, RECENT_LIMIT),
    [entities],
  );

  if (isLoading && !loaded) {
    return (
      <div className="empty-state" role="status">
        {t("common.loading", "Loading…")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="empty-state empty-state--error" role="alert">
        {t("web.error.load", "Could not load. Check your connection.")}
      </div>
    );
  }

  return (
    <div>
      <header className="view-header">
        <div>
          <h1 className="view-title">{t("home.title")}</h1>
          <p className="view-subtitle">{t("home.subtitle")}</p>
        </div>
      </header>

      <section className="view-section">
        <h2 className="view-section__title">{t("home.favoritesSection")}</h2>
        {favorites.length === 0 ? (
          <div className="empty-state">{t("home.noFavorites")}</div>
        ) : (
          <div className="command-list">
            {favorites.map((e) => (
              <EntityCard
                key={`${e.kind}-${e.id}`}
                entity={e}
                onView={openDetail}
                onRun={requestRun}
              />
            ))}
          </div>
        )}
      </section>

      <section className="view-section">
        <h2 className="view-section__title">{t("home.recentSection")}</h2>
        {recent.length === 0 ? (
          <div className="empty-state">{t("home.noRecent")}</div>
        ) : (
          <div className="command-list">
            {recent.map((e) => (
              <EntityCard
                key={`${e.kind}-${e.id}`}
                entity={e}
                onView={openDetail}
                onRun={requestRun}
              />
            ))}
          </div>
        )}
      </section>

      {modals}
    </div>
  );
}
