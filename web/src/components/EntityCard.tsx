// Entity card (F4/F5) — a read-only command/workflow tile with a Run button.
//
// Mirrors the desktop list-tile card but WITHOUT any mutating controls: no
// context menu, no edit/delete, no favorite toggle. View + run only.
//
// Two layouts (matching the desktop Library's display modes):
//   - tiles (default): title + description + a bottom Run/View action row.
//   - compact: a single dense row — title left, icon-only Run/View at the right
//     (no description, no bottom row). Driven by the `compact` prop + the shared
//     `list-tile--compact` class.

import { useTranslation } from "react-i18next";
import { RunIcon } from "@app/components/icons/RunIcon";
import { ViewIcon } from "@app/components/icons/ViewIcon";
import type { ApiEntitySummary } from "../api/types";
import { entityDescription, entityName } from "../utils/entityLabels";

interface EntityCardProps {
  entity: ApiEntitySummary;
  /** Open the read-only detail modal. */
  onView: (entity: ApiEntitySummary) => void;
  /** Run the entity (the coordinator decides whether to prompt for variables). */
  onRun: (entity: ApiEntitySummary) => void;
  /** Dense, icon-only layout (Library compact mode). Default false. */
  compact?: boolean;
}

export function EntityCard({
  entity,
  onView,
  onRun,
  compact = false,
}: EntityCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const name = entityName(entity, t);
  const desc = entityDescription(entity, t);
  const isCommand = entity.kind === "command";
  const runLabel = t("common.run");
  const viewLabel = t("library.view", "View");

  if (compact) {
    return (
      <div
        className={`list-tile list-tile--${entity.kind} list-tile--compact`}
        onDoubleClick={() => onView(entity)}
      >
        <div className="list-tile__head">
          <div className="list-tile__heading">
            <h3 className="list-tile__title">{name}</h3>
          </div>
          <div className="list-tile__head-actions">
            <button
              type="button"
              className="btn btn--run btn--icon"
              onClick={() => onRun(entity)}
              aria-label={runLabel}
              title={runLabel}
            >
              <RunIcon />
            </button>
            <button
              type="button"
              className="btn btn--view btn--icon"
              onClick={() => onView(entity)}
              aria-label={viewLabel}
              title={viewLabel}
            >
              <ViewIcon />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`list-tile list-tile--${entity.kind}`}
      onDoubleClick={() => onView(entity)}
    >
      <div className="list-tile__head">
        <div>
          <h3 className="list-tile__title">{name}</h3>
          {desc ? <p className="list-tile__desc">{desc}</p> : null}
        </div>
      </div>
      <div className="list-tile__meta">
        <span className={`type-badge type-badge--${entity.kind}`}>
          {isCommand ? t("home.typeCommand") : t("home.typeWorkflow")}
        </span>
      </div>
      <div className="list-tile__actions">
        <button
          type="button"
          className="btn btn--run"
          onClick={() => onRun(entity)}
        >
          <RunIcon />
          {runLabel}
        </button>
        <button
          type="button"
          className="btn btn--view"
          onClick={() => onView(entity)}
        >
          <span className="btn--view-icon">
            <ViewIcon />
          </span>
          {viewLabel}
        </button>
      </div>
    </div>
  );
}
