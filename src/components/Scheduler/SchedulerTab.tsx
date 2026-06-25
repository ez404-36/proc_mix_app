// The "Scheduler" view: lists cron schedules with enable / edit / delete
// controls and a "New schedule" button. Creating or editing a schedule
// navigates to the full-screen `scheduler-editor` view (see ScheduleEditor +
// ScheduleForm) rather than opening a modal.

import { useMemo, useState } from "react";
import type {
  ChangeEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  deleteSchedule,
  runScheduleNow,
  setScheduleEnabled,
} from "../../services/scheduleActions";
import { useScheduleStore } from "../../stores/scheduleStore";
import { useUIStore } from "../../stores/uiStore";
import type { Schedule, ScheduleSortKey } from "../../types";
import { sortSchedules } from "../../utils/sortLists";
import { paginate } from "../../utils/paginate";
import { ConfirmDialog } from "../ConfirmDialog";
import { useContextMenu } from "../ContextMenu";
import type { ContextMenuEntry } from "../ContextMenu";
import { ListControls } from "../ListControls/ListControls";
import type { SortOption } from "../ListControls/ListControls";
import { Pagination } from "../Pagination/Pagination";
import { PlusIcon, RunIcon, ViewIcon } from "../icons";
import { ToggleSwitch } from "../ToggleSwitch";
import { ScheduleView } from "./ScheduleView";

/** Grid template (column widths) for the schedule table rows. */
const SCHEDULE_TABLE_COLUMNS = "auto minmax(0, 2fr) 1fr 1fr auto";

interface ScheduleTableProps {
  schedules: ReadonlyArray<Schedule>;
  onView: (schedule: Schedule) => void;
  onRun: (schedule: Schedule) => void;
  onToggle: (schedule: Schedule) => void;
}

/** Tabular layout for schedules (table view mode). */
function ScheduleTable({
  schedules,
  onView,
  onRun,
  onToggle,
}: ScheduleTableProps): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="table" role="table" aria-label={t("nav.scheduler")}>
      <div
        className="table__row table__head"
        role="row"
        style={{ gridTemplateColumns: SCHEDULE_TABLE_COLUMNS }}
      >
        <span className="table__cell" role="columnheader" aria-hidden="true" />
        <span className="table__cell" role="columnheader">
          {t("listView.sortByName")}
        </span>
        <span className="table__cell" role="columnheader">
          {t("scheduler.nextRunLabel")}
        </span>
        <span className="table__cell" role="columnheader">
          {t("scheduler.lastRunLabel")}
        </span>
        <span className="table__cell" role="columnheader">
          {t("scheduler.enabled")}
        </span>
      </div>
      {schedules.map((schedule) => {
        const nextRun = formatTime(schedule.nextRunAt);
        const lastRun = formatTime(schedule.lastRunAt);
        return (
          <div
            key={schedule.id}
            className="table__row table__row--body table__row--clickable"
            role="row"
            onClick={() => onView(schedule)}
            style={{ gridTemplateColumns: SCHEDULE_TABLE_COLUMNS }}
          >
            <span className="table__cell table__cell--actions" role="cell">
              <button
                type="button"
                className="btn btn--run btn--icon"
                onClick={(e) => {
                  e.stopPropagation();
                  onRun(schedule);
                }}
                aria-label={t("scheduler.runNow")}
                title={t("scheduler.runNow")}
              >
                <RunIcon />
              </button>
            </span>
            <span className="table__cell" role="cell">
              {schedule.name}
            </span>
            <span className="table__cell table__cell--muted" role="cell">
              {nextRun ?? "—"}
            </span>
            <span className="table__cell table__cell--muted" role="cell">
              {lastRun ?? "—"}
            </span>
            <span className="table__cell" role="cell">
              <label
                className="list-schedule-card__toggle"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  checked={schedule.enabled}
                  onChange={() => onToggle(schedule)}
                  aria-label={
                    schedule.enabled
                      ? t("scheduler.disable")
                      : t("scheduler.enable")
                  }
                />
              </label>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function formatTime(iso: string | undefined): string | null {
  if (iso === undefined) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

interface ScheduleCardProps {
  schedule: Schedule;
  onView: (schedule: Schedule) => void;
  onRun: (schedule: Schedule) => void;
  onToggle: (schedule: Schedule) => void;
  onEdit: (schedule: Schedule) => void;
  onDelete: (schedule: Schedule) => void;
  /** Render the dense layout: no cron/run details, icon-only Run/View buttons. */
  compact?: boolean;
}

function buildScheduleCardMenuItems(
  schedule: Schedule,
  t: TFunction,
  actions: {
    onView: (schedule: Schedule) => void;
    onRun: (schedule: Schedule) => void;
    onToggle: (schedule: Schedule) => void;
    onEdit: (schedule: Schedule) => void;
    onDelete: (schedule: Schedule) => void;
  },
): ContextMenuEntry[] {
  return [
    {
      id: "run",
      label: t("contextMenu.run"),
      onSelect: () => actions.onRun(schedule),
    },
    {
      id: "view",
      label: t("contextMenu.view"),
      onSelect: () => actions.onView(schedule),
    },
    {
      id: "toggle",
      label: schedule.enabled ? t("scheduler.disable") : t("scheduler.enable"),
      onSelect: () => actions.onToggle(schedule),
    },
    { id: "div1", divider: true },
    {
      id: "edit",
      label: t("contextMenu.edit"),
      onSelect: () => actions.onEdit(schedule),
    },
    {
      id: "delete",
      label: t("contextMenu.delete"),
      danger: true,
      onSelect: () => actions.onDelete(schedule),
    },
  ];
}

function ScheduleCard({
  schedule,
  onView,
  onRun,
  onToggle,
  onEdit,
  onDelete,
  compact = false,
}: ScheduleCardProps): ReactElement {
  const { t } = useTranslation();
  const { show } = useContextMenu();
  const nextRun = formatTime(schedule.nextRunAt);
  const lastRun = formatTime(schedule.lastRunAt);

  const handleContextMenu = (e: ReactMouseEvent<HTMLDivElement>): void => {
    show({
      event: {
        clientX: e.clientX,
        clientY: e.clientY,
        preventDefault: () => e.preventDefault(),
      },
      items: buildScheduleCardMenuItems(schedule, t, {
        onView,
        onRun,
        onToggle,
        onEdit,
        onDelete,
      }),
    });
  };

  const enableToggle = (
    <span
      className={`list-schedule-card__toggle${compact ? " list-schedule-card__toggle--compact" : ""}`}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <ToggleSwitch
        checked={schedule.enabled}
        onChange={() => onToggle(schedule)}
        ariaLabel={
          schedule.enabled ? t("scheduler.disable") : t("scheduler.enable")
        }
      />
      {!compact ? (
        <span className="list-schedule-card__toggle-label">
          {schedule.enabled ? t("scheduler.enabled") : t("scheduler.disabled")}
        </span>
      ) : null}
    </span>
  );

  return (
    <div
      className={`list-tile list-tile--schedule list-schedule-card${compact ? " list-tile--compact" : ""}`}
      onContextMenu={handleContextMenu}
      onDoubleClick={() => onView(schedule)}
    >
      <div className="list-tile__head">
        <div className="list-tile__heading">
          <h3 className="list-tile__title" title={schedule.name}>
            {schedule.name}
          </h3>
          {!compact ? (
            <p className="list-tile__desc">
              <code className="list-schedule-card__cron">{schedule.cron}</code>
            </p>
          ) : null}
        </div>
        {compact ? (
          <div className="list-tile__head-actions">
            <button
              type="button"
              className="btn btn--run btn--icon"
              onClick={() => onRun(schedule)}
              onDoubleClick={(e) => e.stopPropagation()}
              aria-label={t("scheduler.runNow")}
              title={t("scheduler.runNow")}
            >
              <RunIcon />
            </button>
            <button
              type="button"
              className="btn btn--view btn--icon"
              onClick={() => onView(schedule)}
              onDoubleClick={(e) => e.stopPropagation()}
              aria-label={t("library.view")}
              title={t("library.view")}
            >
              <ViewIcon />
            </button>
            {enableToggle}
          </div>
        ) : (
          enableToggle
        )}
      </div>

      <div className="list-tile__meta">
        <span className="shell-badge">
          {schedule.targetKind === "command"
            ? t("scheduler.form.targetCommand")
            : t("scheduler.form.targetWorkflow")}
        </span>
        {schedule.lastRunStatus !== undefined ? (
          <span
            className={`history-row__status history-row__status--scheduled-${schedule.lastRunStatus}`}
          >
            {t(`scheduler.status.${schedule.lastRunStatus}` as const)}
          </span>
        ) : null}
      </div>

      {!compact ? (
        <div className="list-schedule-card__runs">
          <span>
            {nextRun !== null
              ? t("scheduler.nextRun", { time: nextRun })
              : t("scheduler.nextRunNever")}
          </span>
          <span>
            {lastRun !== null
              ? t("scheduler.lastRun", { time: lastRun })
              : t("scheduler.lastRunNever")}
          </span>
          <span>{t("scheduler.runCount", { count: schedule.runCount })}</span>
        </div>
      ) : null}

      {!compact ? (
        <div className="list-tile__actions">
          <button
            type="button"
            className="btn btn--run"
            onClick={() => onRun(schedule)}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <RunIcon />
            {t("scheduler.runNow")}
          </button>
          <button
            type="button"
            className="btn btn--view"
            onClick={() => onView(schedule)}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <span className="btn--view-icon">
              <ViewIcon />
            </span>
            {t("library.view")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function SchedulerTab(): ReactElement {
  const { t } = useTranslation();
  const schedules = useScheduleStore((s) => s.schedules);
  const setScheduleEditorTarget = useUIStore((s) => s.setScheduleEditorTarget);
  const setView = useUIStore((s) => s.setView);
  const view = useUIStore((s) => s.schedulesView);
  const updateView = useUIStore((s) => s.updateSchedulesView);

  const [query, setQuery] = useState("");
  // Transient table page (1-based); reset on filter/sort/page-size changes.
  const [page, setPage] = useState<number>(1);
  const [viewSchedule, setViewSchedule] = useState<Schedule | null>(null);
  // The schedule staged for deletion (awaiting confirmation), or null.
  const [pendingDelete, setPendingDelete] = useState<Schedule | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return schedules;
    return schedules.filter((s) => s.name.toLowerCase().includes(q));
  }, [schedules, query]);

  const sortOptions: ReadonlyArray<SortOption<ScheduleSortKey>> = useMemo(
    () => [
      { key: "createdAt", dir: "desc", label: t("listView.sortNewestFirst") },
      { key: "createdAt", dir: "asc", label: t("listView.sortOldestFirst") },
      { key: "name", dir: "asc", label: t("listView.sortNameAsc") },
      { key: "name", dir: "desc", label: t("listView.sortNameDesc") },
      { key: "runCount", dir: "desc", label: t("listView.sortRunsDesc") },
      { key: "runCount", dir: "asc", label: t("listView.sortRunsAsc") },
    ],
    [t],
  );

  const sorted = useMemo(
    () => sortSchedules(filtered, { key: view.sortKey, dir: view.sortDir }),
    [filtered, view.sortKey, view.sortDir],
  );

  const pageResult = useMemo(
    () => paginate(sorted, page, view.pageSize),
    [sorted, page, view.pageSize],
  );

  const showTable = view.mode === "table";
  const compact = view.mode === "compact";

  const handleSearch = (e: ChangeEvent<HTMLInputElement>): void => {
    setQuery(e.target.value);
    setPage(1);
  };

  const handleNew = (): void => {
    setScheduleEditorTarget({ mode: "create", scheduleId: null });
    setView("scheduler-editor");
  };

  const handleEdit = (schedule: Schedule): void => {
    setScheduleEditorTarget({ mode: "edit", scheduleId: schedule.id });
    setView("scheduler-editor");
  };

  const handleToggle = (schedule: Schedule): void => {
    void setScheduleEnabled(schedule.id, !schedule.enabled);
  };

  const handleRun = (schedule: Schedule): void => {
    void runScheduleNow(schedule.id);
  };

  const confirmDelete = (): void => {
    if (pendingDelete === null) return;
    void deleteSchedule(pendingDelete.id);
    setPendingDelete(null);
  };

  return (
    <>
      <header className="view-header">
        <div>
          <h1 className="view-title">{t("scheduler.title")}</h1>
          <p className="view-subtitle">{t("scheduler.subtitle")}</p>
        </div>
      </header>

      <div className="scheduler-hint-row">
        <p className="form-hint scheduler-runs-hint">
          {t("scheduler.runsWhileOpen")}
        </p>
        <button
          type="button"
          className="btn btn--primary"
          onClick={handleNew}
          aria-label={t("scheduler.new")}
          title={t("scheduler.new")}
        >
          <PlusIcon />
          {t("scheduler.newLabel")}
        </button>
      </div>

      <div className="library-toolbar">
        <input
          className="input"
          type="search"
          placeholder={t("scheduler.searchPlaceholder")}
          value={query}
          onChange={handleSearch}
        />
        <ListControls
          sortOptions={sortOptions}
          sortKey={view.sortKey}
          sortDir={view.sortDir}
          onSortChange={(key, dir) => {
            updateView({ sortKey: key, sortDir: dir });
            setPage(1);
          }}
          mode={view.mode}
          onModeChange={(mode) => updateView({ mode })}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          {schedules.length === 0
            ? t("scheduler.noSchedules")
            : t("scheduler.noResults")}
        </div>
      ) : showTable ? (
        <>
          <ScheduleTable
            schedules={pageResult.pageItems}
            onView={setViewSchedule}
            onRun={handleRun}
            onToggle={handleToggle}
          />
          <Pagination
            page={pageResult.page}
            totalPages={pageResult.totalPages}
            pageSize={view.pageSize}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              updateView({ pageSize: size });
              setPage(1);
            }}
          />
        </>
      ) : (
        <div className={`command-list${compact ? " command-list--compact" : ""}`}>
          {sorted.map((schedule) => (
            <ScheduleCard
              key={schedule.id}
              schedule={schedule}
              onView={setViewSchedule}
              onRun={handleRun}
              onToggle={handleToggle}
              onEdit={handleEdit}
              onDelete={setPendingDelete}
              compact={compact}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("scheduler.deleteConfirmTitle")}
        message={t("scheduler.deleteConfirm", {
          name: pendingDelete?.name ?? "",
        })}
        confirmLabel={t("common.delete")}
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />

      <ScheduleView
        schedule={viewSchedule}
        onClose={() => setViewSchedule(null)}
        onEdit={(schedule) => {
          setViewSchedule(null);
          handleEdit(schedule);
        }}
        onRun={(schedule) => {
          setViewSchedule(null);
          handleRun(schedule);
        }}
        onDelete={(schedule) => {
          setViewSchedule(null);
          setPendingDelete(schedule);
        }}
      />
    </>
  );
}
