import { useEffect, useMemo, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { AnsiText } from "../AnsiText";
import { useContextMenu } from "../ContextMenu";
import { buildConsoleCopyMenu } from "../../utils/consoleClipboard";
import { useExecutionStore } from "../../stores/executionStore";
import type { Execution } from "../../types";
import { cancelExecution } from "../../utils/executor";
import { CancelIcon, ClearIcon, SpinnerIcon } from "../icons";

/** One tracked run belonging to this mini-app, in the shape the tabs need. */
export interface MiniAppConsoleEntry {
  executionId: string;
  widgetLabel: string;
}

export type MiniAppRunnerTab = "interface" | "console" | "processes";

interface MiniAppRunnerTabsProps {
  /** Every widget run currently tracked for THIS mini-app (running or
   *  recently finished — see `MiniAppRunner`'s `executionWidgets`). Order is
   *  not significant; both the Console and Processes bodies sort by
   *  `startedAt` themselves. */
  entries: ReadonlyArray<MiniAppConsoleEntry>;
  activeTab: MiniAppRunnerTab;
  onTabChange: (tab: MiniAppRunnerTab) => void;
  /** The Interface tab's body — the widget panel (or its empty state),
   *  rendered by `MiniAppRunner`. Kept as a prop rather than owned here so
   *  this component stays scoped to the tab strip + Console/Processes
   *  bodies, matching `MiniAppRunner`'s existing widget-panel JSX. */
  interfaceBody: ReactElement;
}

/** Runs sorted oldest-first (by `startedAt`), for the Console tab's
 *  chronological merged log. */
function useSortedRuns(
  entries: ReadonlyArray<MiniAppConsoleEntry>,
  executions: Record<string, Execution>,
): ReadonlyArray<{ entry: MiniAppConsoleEntry; execution: Execution }> {
  return useMemo(
    () =>
      entries
        .map((entry) => ({ entry, execution: executions[entry.executionId] }))
        .filter(
          (r): r is { entry: MiniAppConsoleEntry; execution: Execution } =>
            r.execution !== undefined,
        )
        .sort((a, b) => a.execution.startedAt - b.execution.startedAt),
    [entries, executions],
  );
}

interface ConsoleTabBodyProps {
  runs: ReadonlyArray<{ entry: MiniAppConsoleEntry; execution: Execution }>;
  onClear: () => void;
}

/**
 * One continuous, chronologically-merged log across every tracked run
 * (running AND finished) — NOT split by chip/tab-switcher. Each run's own
 * output block is preceded by a synthetic, presentation-only separator line
 * (styled like a workflow step header, see `.output-line--meta` /
 * `.output-line--workdir` in `theme.css`, produced for workflow steps by
 * `useWorkflowBridge.buildStepHeaderLines`). This does NOT call
 * `appendWorkflowStepHeader` — that mutates an execution's persisted log in
 * the store; the separator here is purely a rendered artifact of this
 * component, never written back to any execution.
 *
 * The Clear button is pinned top-right INSIDE this body (not in the tab
 * strip) — it acts on the console's content, so it reads as part of the
 * console rather than a fourth tab-level control sitting at the same visual
 * height as Interface/Console/Processes.
 */
function ConsoleTabBody({ runs, onClear }: ConsoleTabBodyProps): ReactElement {
  const { t } = useTranslation();
  const { show } = useContextMenu();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const totalLogLength = runs.reduce((n, r) => n + r.execution.log.length, 0);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [totalLogLength, runs.length]);

  const handleContextMenu = (e: ReactMouseEvent<HTMLDivElement>): void => {
    show({
      event: {
        clientX: e.clientX,
        clientY: e.clientY,
        preventDefault: () => e.preventDefault(),
      },
      items: buildConsoleCopyMenu(bodyRef.current, t),
    });
  };

  const clearButton = (
    <button
      type="button"
      className="miniapp-console__clear"
      onClick={onClear}
      aria-label={t("common.clear")}
      title={t("common.clear")}
    >
      <ClearIcon />
    </button>
  );

  if (runs.length === 0) {
    return (
      <>
        {clearButton}
        <div className="empty-state">
          {t("miniapps.console.empty", { defaultValue: "No output yet." })}
        </div>
      </>
    );
  }

  return (
    <>
      {clearButton}
      <div
        ref={bodyRef}
        className="miniapp-console__body"
        onContextMenu={handleContextMenu}
      >
        {runs.map(({ entry, execution }) => (
          <div key={execution.id} className="miniapp-console__run-block">
            <div className="output-line output-line--meta">
              {t("miniapps.console.runHeader", {
                defaultValue: "▸ {{label}} · {{status}}",
                label: entry.widgetLabel,
                status: t(`miniapps.console.status.${execution.status}`, {
                  defaultValue: execution.status,
                }),
              })}
            </div>
            {execution.log.length === 0 && execution.status === "running" ? (
              <div className="miniapp-console__placeholder">
                {t("outputPanel.waiting")}
              </div>
            ) : (
              execution.log.map((line, idx) => (
                <div
                  key={`${execution.id}-${idx}`}
                  className={`output-line output-line--${line.stream}${
                    line.variant === "workdir" ? " output-line--workdir" : ""
                  }`}
                >
                  <AnsiText text={line.line} />
                </div>
              ))
            )}
            {execution.error ? (
              <div className="output-line output-line--stderr">
                <AnsiText text={execution.error} />
              </div>
            ) : null}
            {execution.timedOut ? (
              <div className="output-line output-line--timeout">
                {t("outputPanel.timedOutLine")}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}

interface ProcessesTabBodyProps {
  runs: ReadonlyArray<{ entry: MiniAppConsoleEntry; execution: Execution }>;
}

/** Live subset of `runs` filtered to `running`/`pending` — functionally the
 *  old `MiniAppActiveProcesses` component's content, now a tab body. */
function ProcessesTabBody({ runs }: ProcessesTabBodyProps): ReactElement {
  const { t } = useTranslation();
  const active = runs.filter(
    (r) => r.execution.status === "running" || r.execution.status === "pending",
  );

  const handleCancel = (executionId: string): void => {
    void cancelExecution(executionId).catch((err: unknown) => {
      console.error("failed to cancel mini-app process", executionId, err);
    });
  };

  if (active.length === 0) {
    return (
      <div className="empty-state">
        {t("miniapps.runner.processes.empty", {
          defaultValue: "No active processes.",
        })}
      </div>
    );
  }

  return (
    <ul className="miniapp-processes__list">
      {active.map(({ entry, execution }) => (
        <li key={execution.id} className="miniapp-processes__item">
          <span className="miniapp-processes__spinner" aria-hidden="true">
            <SpinnerIcon />
          </span>
          <span className="miniapp-processes__label" title={entry.widgetLabel}>
            {entry.widgetLabel}
          </span>
          <span className="miniapp-processes__pid">
            {execution.pid !== undefined
              ? t("miniapps.runner.processes.pid", { pid: execution.pid })
              : t("miniapps.runner.processes.pidPending")}
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--icon miniapp-processes__cancel"
            onClick={() => handleCancel(execution.id)}
            aria-label={t("miniapps.runner.processes.cancel")}
            title={t("miniapps.runner.processes.cancel")}
          >
            <CancelIcon />
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Permanent 3-tab layout for the Mini-App runner: Interface / Console /
 * Processes, positioned under the runner's header. Replaces the earlier
 * collapsible, bottom-docked `MiniAppConsolePanel` (chip-switcher,
 * auto-expand/collapse) — that whole interaction model no longer exists.
 *
 *  - Interface: the widget panel (owned by `MiniAppRunner`, passed in as
 *    `interfaceBody`).
 *  - Console: ONE continuous, chronologically-merged log across every
 *    tracked run (running + finished), with a Clear button (the ONLY place
 *    Clear lives).
 *  - Processes: only `running`/`pending` runs, each with its PID (or
 *    "starting…") and a Cancel button. A live badge on the tab itself shows
 *    the running count.
 *
 * Deliberately NO auto-switching between tabs when a run starts, and NO
 * badge/highlight on the Console tab for new output — both were explicitly
 * rejected in favour of a fully user-driven tab choice (see the design
 * discussion this component implements).
 */
export function MiniAppRunnerTabs({
  entries,
  activeTab,
  onTabChange,
  interfaceBody,
}: MiniAppRunnerTabsProps): ReactElement {
  const { t } = useTranslation();
  const executions = useExecutionStore((s) => s.executions);
  const runs = useSortedRuns(entries, executions);

  const runningCount = useMemo(
    () =>
      runs.filter(
        (r) =>
          r.execution.status === "running" || r.execution.status === "pending",
      ).length,
    [runs],
  );

  const handleClear = (): void => {
    useExecutionStore.getState().clearTerminated();
  };

  return (
    <div className="miniapp-runner__tabs-wrap">
      <div className="miniapp-runner__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          id="miniapp-runner-tab-interface"
          aria-controls="miniapp-runner-panel-interface"
          aria-selected={activeTab === "interface"}
          className={`miniapp-runner__tab${
            activeTab === "interface" ? " is-active" : ""
          }`}
          onClick={() => onTabChange("interface")}
        >
          {t("miniapps.runner.tabs.interface", { defaultValue: "Interface" })}
        </button>
        <button
          type="button"
          role="tab"
          id="miniapp-runner-tab-console"
          aria-controls="miniapp-runner-panel-console"
          aria-selected={activeTab === "console"}
          className={`miniapp-runner__tab${
            activeTab === "console" ? " is-active" : ""
          }`}
          onClick={() => onTabChange("console")}
        >
          {t("miniapps.runner.tabs.console", { defaultValue: "Console" })}
        </button>
        <button
          type="button"
          role="tab"
          id="miniapp-runner-tab-processes"
          aria-controls="miniapp-runner-panel-processes"
          aria-selected={activeTab === "processes"}
          className={`miniapp-runner__tab${
            activeTab === "processes" ? " is-active" : ""
          }`}
          onClick={() => onTabChange("processes")}
        >
          {t("miniapps.runner.tabs.processes", { defaultValue: "Processes" })}
          {runningCount > 0 ? (
            <span
              className="miniapp-runner__tab-badge"
              aria-label={t("miniapps.runner.tabs.runningCount", {
                defaultValue: "{{count}} running",
                count: runningCount,
              })}
            >
              {runningCount}
            </span>
          ) : null}
        </button>
      </div>

      <div
        id="miniapp-runner-panel-interface"
        role="tabpanel"
        aria-labelledby="miniapp-runner-tab-interface"
        hidden={activeTab !== "interface"}
      >
        {activeTab === "interface" ? interfaceBody : null}
      </div>
      <div
        id="miniapp-runner-panel-console"
        role="tabpanel"
        aria-labelledby="miniapp-runner-tab-console"
        hidden={activeTab !== "console"}
        className="miniapp-console"
      >
        {activeTab === "console" ? (
          <ConsoleTabBody runs={runs} onClear={handleClear} />
        ) : null}
      </div>
      <div
        id="miniapp-runner-panel-processes"
        role="tabpanel"
        aria-labelledby="miniapp-runner-tab-processes"
        hidden={activeTab !== "processes"}
        className="miniapp-processes"
      >
        {activeTab === "processes" ? <ProcessesTabBody runs={runs} /> : null}
      </div>
    </div>
  );
}
