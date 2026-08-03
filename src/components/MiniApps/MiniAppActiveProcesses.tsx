import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useExecutionStore } from "../../stores/executionStore";
import { cancelExecution } from "../../utils/executor";
import { CancelIcon, SpinnerIcon } from "../icons";

/**
 * One entry in the active-processes panel: the widget it belongs to
 * (resolved to its display label by the caller) plus the execution id the
 * runner is tracking for it.
 */
export interface ActiveProcessEntry {
  executionId: string;
  widgetLabel: string;
}

interface MiniAppActiveProcessesProps {
  entries: ReadonlyArray<ActiveProcessEntry>;
}

/**
 * Panel listing every OS process a mini-app currently has in flight — one
 * row per concurrently-running widget action, each carrying the real PID
 * (when the executor reported one) and a Cancel button.
 *
 * A single mini-app can trigger several concurrent processes (one per
 * button/toggle click; nothing here assumes at most one), so this reads the
 * live `executionStore` for each tracked execution id rather than caching
 * a snapshot — the PID/status only becomes available once the `started`
 * execution event lands, and the row disappears once the runner removes the
 * execution id from `entries` on completion (see `MiniAppRunner`).
 *
 * Renders nothing when there is nothing running — this is a status surface,
 * not a permanent chrome element.
 */
export function MiniAppActiveProcesses({
  entries,
}: MiniAppActiveProcessesProps): ReactElement | null {
  const { t } = useTranslation();
  const executions = useExecutionStore((s) => s.executions);

  if (entries.length === 0) return null;

  const handleCancel = (executionId: string): void => {
    void cancelExecution(executionId).catch((err: unknown) => {
      console.error("failed to cancel mini-app process", executionId, err);
    });
  };

  return (
    <div
      className="miniapp-processes"
      role="region"
      aria-label={t("miniapps.runner.processes.title")}
    >
      <div className="miniapp-processes__header">
        <span className="miniapp-processes__title">
          {t("miniapps.runner.processes.title")}
        </span>
        <span className="miniapp-processes__count">{entries.length}</span>
      </div>
      <ul className="miniapp-processes__list">
        {entries.map((entry) => {
          const execution = executions[entry.executionId];
          const pid = execution?.pid;
          return (
            <li key={entry.executionId} className="miniapp-processes__item">
              <span className="miniapp-processes__spinner" aria-hidden="true">
                <SpinnerIcon />
              </span>
              <span className="miniapp-processes__label" title={entry.widgetLabel}>
                {entry.widgetLabel}
              </span>
              <span className="miniapp-processes__pid">
                {pid !== undefined
                  ? t("miniapps.runner.processes.pid", { pid })
                  : t("miniapps.runner.processes.pidPending")}
              </span>
              <button
                type="button"
                className="btn btn--ghost btn--icon miniapp-processes__cancel"
                onClick={() => handleCancel(entry.executionId)}
                aria-label={t("miniapps.runner.processes.cancel")}
                title={t("miniapps.runner.processes.cancel")}
              >
                <CancelIcon />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
