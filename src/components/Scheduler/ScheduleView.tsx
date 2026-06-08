import { useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useCommandStore } from "../../stores/commandStore";
import { useWorkflowStore } from "../../stores/workflowStore";
import type { ScheduledRunEvent, Schedule } from "../../types";
import { getCommandName } from "../../utils/commandLabels";
import { formatDuration } from "../../utils/formatDuration";
import { listScheduleHistoryFromDb } from "../../utils/historyRepository";
import { ScheduledRunOutput } from "../History/ScheduledRunOutput";

import { CancelIcon, EditIcon, RunIcon, TrashIcon } from "../icons";

/** Tabs in the schedule view: static parameters vs. the run history. */
type ScheduleViewTab = "params" | "history";

interface ScheduleViewProps {
  /** The schedule to display, or `null` when the view is closed. */
  schedule: Schedule | null;
  onClose: () => void;
  onEdit: (schedule: Schedule) => void;
  onRun: (schedule: Schedule) => void;
  onDelete: (schedule: Schedule) => void;
}

function formatTime(iso: string | undefined): string | null {
  if (iso === undefined) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

/**
 * Read-only preview of a schedule, opened by double-clicking a Library card or
 * its "View" button. Mirrors the app's portal-modal mechanics
 * (`WorkflowView` / `ConfirmDialog`): `createPortal` to `document.body`, a
 * `.command-form__backdrop` that closes on outside click, Esc closes,
 * `aria-modal`, initial focus on the primary action.
 *
 * Editing / running start only from the explicit buttons here: a casual
 * double-click inspects first; "Run now" fires the target out of band without
 * shifting the cron timing.
 */
export function ScheduleView({
  schedule,
  onClose,
  onEdit,
  onRun,
  onDelete,
}: ScheduleViewProps): ReactElement | null {
  const { t } = useTranslation();
  const editRef = useRef<HTMLButtonElement | null>(null);
  const commands = useCommandStore((s) => s.commands);
  const workflows = useWorkflowStore((s) => s.workflows);

  const [activeTab, setActiveTab] = useState<ScheduleViewTab>("params");

  const [history, setHistory] = useState<ScheduledRunEvent[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const scheduleId = schedule?.id ?? null;

  // Reset to the Parameters tab whenever a different schedule opens.
  useEffect(() => {
    setActiveTab("params");
  }, [scheduleId]);

  // Load this schedule's full run history when the view opens (or the
  // schedule changes). Loaded once per open — newest-first, bounded by the
  // backend's HISTORY_LIMIT — and scrolled rather than paginated.
  useEffect(() => {
    if (scheduleId === null) {
      setHistory([]);
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    listScheduleHistoryFromDb(scheduleId)
      .then((items) => {
        if (cancelled) return;
        // The repository already filters to scheduledRun, but narrow the
        // union so the render code sees the richer event type.
        setHistory(
          items.filter(
            (e): e is ScheduledRunEvent => e.kind === "scheduledRun",
          ),
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("failed to load schedule history", scheduleId, err);
        setHistory([]);
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scheduleId]);

  useEffect(() => {
    if (schedule !== null) {
      editRef.current?.focus();
    }
  }, [schedule]);

  if (schedule === null) return null;

  const targetName =
    schedule.targetKind === "command"
      ? (() => {
          const cmd = commands.find((c) => c.id === schedule.targetId);
          return cmd ? getCommandName(cmd, t) : schedule.targetId;
        })()
      : (workflows.find((w) => w.id === schedule.targetId)?.name ??
        schedule.targetId);

  const nextRun = formatTime(schedule.nextRunAt);
  const lastRun = formatTime(schedule.lastRunAt);

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const handleBackdropClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) onClose();
  };

  const modal = (
    <div
      className="command-form__backdrop"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      <div
        className="command-form command-form--view"
        role="dialog"
        aria-modal="true"
        aria-label={schedule.name}
      >
        <div className="workflow-view__header">
          <h2 className="command-form__title">{schedule.name}</h2>
          <div className="list-tile__meta">
            <span
              className={`list-schedule-card__state${
                schedule.enabled ? " list-schedule-card__state--on" : ""
              }`}
            >
              {schedule.enabled
                ? t("scheduler.enabled")
                : t("scheduler.disabled")}
            </span>
          </div>
          <button
            type="button"
            className="btn btn--icon btn--danger view-header-delete"
            aria-label={t("common.delete")}
            title={t("common.delete")}
            onClick={() => onDelete(schedule)}
          >
            <TrashIcon />
          </button>
        </div>

        <div className="schedule-view__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "params"}
            className={`schedule-view__tab${
              activeTab === "params" ? " is-active" : ""
            }`}
            onClick={() => setActiveTab("params")}
          >
            {t("scheduler.view.tabParams")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "history"}
            className={`schedule-view__tab${
              activeTab === "history" ? " is-active" : ""
            }`}
            onClick={() => setActiveTab("history")}
          >
            {t("scheduler.view.tabHistory")}
          </button>
        </div>

        {activeTab === "params" ? (
        <dl className="schedule-view__details">
          <div className="schedule-view__row">
            <dt>{t("scheduler.form.target")}</dt>
            <dd className="schedule-view__value">
              <span>{targetName}</span>
              <span className="shell-badge">
                {schedule.targetKind === "command"
                  ? t("scheduler.form.targetCommand")
                  : t("scheduler.form.targetWorkflow")}
              </span>
            </dd>
          </div>
          <div className="schedule-view__row">
            <dt>{t("scheduler.view.cron")}</dt>
            <dd>
              <code className="list-schedule-card__cron">{schedule.cron}</code>
            </dd>
          </div>
          <div className="schedule-view__row">
            <dt>{t("scheduler.nextRunLabel")}</dt>
            <dd>{nextRun ?? t("scheduler.view.never")}</dd>
          </div>
          <div className="schedule-view__row">
            <dt>{t("scheduler.lastRunLabel")}</dt>
            <dd className="schedule-view__value">
              <span>{lastRun ?? t("scheduler.view.never")}</span>
              {schedule.lastRunStatus !== undefined ? (
                <span
                  className={`history-row__status history-row__status--scheduled-${schedule.lastRunStatus}`}
                >
                  {t(`scheduler.status.${schedule.lastRunStatus}` as const)}
                </span>
              ) : null}
            </dd>
          </div>
          <div className="schedule-view__row">
            <dt>{t("scheduler.runCountLabel")}</dt>
            <dd>{schedule.runCount}</dd>
          </div>
          {schedule.catchUpPolicy !== "none" ? (
            <div className="schedule-view__row">
              <dt>{t("scheduler.form.catchUp")}</dt>
              <dd>
                {schedule.catchUpPolicy === "all"
                  ? t("scheduler.form.catchUpAll")
                  : t("scheduler.form.catchUpOnce")}
              </dd>
            </div>
          ) : null}
          {schedule.timeoutSeconds !== undefined ? (
            <div className="schedule-view__row">
              <dt>{t("scheduler.form.timeoutSeconds")}</dt>
              <dd>{schedule.timeoutSeconds}</dd>
            </div>
          ) : null}
          {schedule.maxRetries > 0 ? (
            <div className="schedule-view__row">
              <dt>{t("scheduler.form.maxRetries")}</dt>
              <dd>{schedule.maxRetries}</dd>
            </div>
          ) : null}
          {schedule.skipIfRunning ? (
            <div className="schedule-view__row">
              <dt>{t("scheduler.form.skipIfRunning")}</dt>
              <dd>{t("scheduler.view.yes")}</dd>
            </div>
          ) : null}
          {schedule.captureOutput ? (
            <div className="schedule-view__row">
              <dt>{t("scheduler.form.captureOutput")}</dt>
              <dd>{t("scheduler.view.yes")}</dd>
            </div>
          ) : null}
        </dl>
        ) : (
          <ScheduleHistoryTab loading={historyLoading} history={history} />
        )}

        <div className="command-form__actions">
          <button
            type="button"
            className="btn command-form__action command-form__action--cancel"
            onClick={onClose}
          >
            <span className="command-form__action-icon--cancel">
              <CancelIcon />
            </span>
            {t("common.close")}
          </button>
          <button
            type="button"
            className="btn command-form__action command-form__action--run"
            onClick={() => onRun(schedule)}
          >
            <span className="command-form__action-icon--run">
              <RunIcon />
            </span>
            {t("scheduler.runNow")}
          </button>
          <button
            ref={editRef}
            type="button"
            className="btn btn--primary command-form__action"
            onClick={() => onEdit(schedule)}
          >
            <EditIcon />
            {t("common.edit")}
          </button>
        </div>


      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

interface ScheduleHistoryTabProps {
  loading: boolean;
  history: ScheduledRunEvent[];
}

/**
 * The History tab: this schedule's `scheduledRun` events, newest first, in a
 * scrollable list. Each entry shows the timestamp + status badge and — when
 * the schedule captured output — an expandable console block and (if the
 * target declared an output schema) the extracted result.
 */
function ScheduleHistoryTab({
  loading,
  history,
}: ScheduleHistoryTabProps): ReactElement {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="schedule-history">
        <p className="empty-state">{t("scheduler.view.historyLoading")}</p>
      </div>
    );
  }
  if (history.length === 0) {
    return (
      <div className="schedule-history">
        <p className="empty-state">{t("scheduler.view.historyEmpty")}</p>
      </div>
    );
  }
  return (
    <div className="schedule-history">
      <ul className="schedule-history__list">
        {history.map((event) => (
          <ScheduleHistoryEntry key={event.id} event={event} />
        ))}
      </ul>
    </div>
  );
}

/** One run in the History tab. */
function ScheduleHistoryEntry({
  event,
}: {
  event: ScheduledRunEvent;
}): ReactElement {
  const { t } = useTranslation();
  const when = formatTime(event.createdAt) ?? event.createdAt;

  // The WHOLE entry is one disclosure: the head row (time + status + meta) is
  // the clickable summary, and expanding it reveals the captured output /
  // result, or — when nothing was captured — a muted note. This keeps every
  // entry interactive (a consistent affordance) rather than only the rows
  // that happen to have output.
  return (
    <li className="schedule-history__entry">
      <details className="schedule-history__disclosure">
        <summary className="schedule-history__head">
          <time
            className="schedule-history__time"
            dateTime={event.createdAt}
            title={event.createdAt}
          >
            {when}
          </time>
          <span
            className={`history-row__status history-row__status--scheduled-${event.status}`}
          >
            {t(`scheduler.status.${event.status}` as const)}
          </span>
          {event.exitCode !== undefined ? (
            <span className="schedule-history__meta">
              {t("scheduler.view.exitCodeLabel")}: {event.exitCode}
            </span>
          ) : null}
          {event.durationMs !== undefined ? (
            <span className="schedule-history__meta">
              {t("scheduler.view.durationLabel")}:{" "}
              {formatDuration(event.durationMs)}
            </span>
          ) : null}
        </summary>

        <ScheduledRunOutput event={event} />
      </details>
    </li>
  );
}
