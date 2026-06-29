// Library view (F5) — full list of API-visible commands + workflows.
//
// Mirrors the desktop Library shell (header + Commands/Workflows tabs + a search
// toolbar + a card list) but view + run ONLY: no "new", no edit/delete/favorite/
// duplicate, no table/grouped/pagination modes. The enriched list summaries
// don't carry tags/categories, so filtering is a name/description search. Cards
// are the shared read-only EntityCard.

import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { useEntitiesStore } from "../stores/entitiesStore";
import type { ApiEntitySummary, EntityKind } from "../api/types";
import { EntityCard } from "../components/EntityCard";
import { useEntityActions } from "../hooks/useEntityActions";

type Tab = EntityKind;

/** Case-insensitive match against name + description. */
function matchesQuery(entity: ApiEntitySummary, query: string): boolean {
  if (query.length === 0) return true;
  const q = query.toLowerCase();
  if (entity.name.toLowerCase().includes(q)) return true;
  if (entity.description && entity.description.toLowerCase().includes(q)) {
    return true;
  }
  return false;
}

export function Library(): React.JSX.Element {
  const { t } = useTranslation();
  const entities = useEntitiesStore((s) => s.entities);
  const isLoading = useEntitiesStore((s) => s.isLoading);
  const error = useEntitiesStore((s) => s.error);
  const loaded = useEntitiesStore((s) => s.loaded);
  const load = useEntitiesStore((s) => s.load);
  const { openDetail, requestRun, modals } = useEntityActions();

  const [tab, setTab] = useState<Tab>("command");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const commands = useMemo(
    () => entities.filter((e) => e.kind === "command"),
    [entities],
  );
  const workflows = useMemo(
    () => entities.filter((e) => e.kind === "workflow"),
    [entities],
  );

  const tabEntities = tab === "command" ? commands : workflows;
  const filtered = useMemo(
    () => tabEntities.filter((e) => matchesQuery(e, query.trim())),
    [tabEntities, query],
  );

  const handleSearch = (e: ChangeEvent<HTMLInputElement>): void => {
    setQuery(e.target.value);
  };

  const tabs: ReadonlyArray<{ key: Tab; label: string }> = [
    { key: "command", label: t("workflow.tabs.commands", "Commands") },
    { key: "workflow", label: t("workflow.tabs.workflows", "Workflows") },
  ];

  return (
    <div>
      <header className="view-header">
        <div>
          <h1 className="view-title">{t("library.title")}</h1>
          <p className="view-subtitle">{t("library.subtitle")}</p>
        </div>
      </header>

      <div className="library-tabs-row">
        <div className="library-tabs" role="tablist">
          {tabs.map((tabDef) => (
            <button
              key={tabDef.key}
              type="button"
              role="tab"
              aria-selected={tab === tabDef.key}
              className={`library-tab${tab === tabDef.key ? " is-active" : ""}`}
              onClick={() => setTab(tabDef.key)}
            >
              {tabDef.label}
            </button>
          ))}
        </div>
      </div>

      <div className="library-toolbar">
        <input
          className="input"
          type="search"
          placeholder={
            tab === "command"
              ? t("library.searchPlaceholder")
              : t("workflow.searchPlaceholder")
          }
          value={query}
          onChange={handleSearch}
        />
      </div>

      {isLoading && !loaded ? (
        <div className="empty-state" role="status">
          {t("common.loading", "Loading…")}
        </div>
      ) : error ? (
        <div className="empty-state empty-state--error" role="alert">
          {t("web.error.load", "Could not load. Check your connection.")}
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          {tabEntities.length === 0
            ? tab === "command"
              ? t("library.noCommands")
              : t("workflow.noWorkflows")
            : tab === "command"
              ? t("library.noResults")
              : t("workflow.noResults")}
        </div>
      ) : (
        <div className="command-list">
          {filtered.map((e) => (
            <EntityCard
              key={`${e.kind}-${e.id}`}
              entity={e}
              onView={openDetail}
              onRun={requestRun}
            />
          ))}
        </div>
      )}

      {modals}
    </div>
  );
}
