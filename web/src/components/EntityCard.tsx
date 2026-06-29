// Entity card (F4/F5) — a read-only command/workflow tile with a Run button.
//
// Mirrors the desktop list-tile card but WITHOUT any mutating controls: no
// context menu, no edit/delete, no favorite toggle. A click runs; the (future)
// detail modal opens on the View affordance. View + run only — the web UI never
// mutates entities.

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
}

export function EntityCard({
  entity,
  onView,
  onRun,
}: EntityCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const name = entityName(entity, t);
  const desc = entityDescription(entity, t);
  const isCommand = entity.kind === "command";

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
          {t("common.run")}
        </button>
        <button
          type="button"
          className="btn btn--view"
          onClick={() => onView(entity)}
        >
          <span className="btn--view-icon">
            <ViewIcon />
          </span>
          {t("library.view", "View")}
        </button>
      </div>
    </div>
  );
}
