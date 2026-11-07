import { useEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from "react";
import { Message } from "@arco-design/web-react";
import { useTranslation } from "react-i18next";
import { AnsiText } from "../AnsiText";
import { useContextMenu } from "../ContextMenu";
import { buildConsoleCopyMenu } from "../../utils/consoleClipboard";
import { useExecutionStore } from "../../stores/executionStore";
import type { Execution } from "../../types";
import { cancelExecution, sendExecutionStdin } from "../../utils/executor";
import { CancelIcon, ClearIcon, SpinnerIcon } from "../icons";

/** One tracked run belonging to this mini-app, in the shape the Console
 *  tab needs. */
export interface MiniAppConsoleEntry {
  executionId: string;
  widgetLabel: string;
}

export type MiniAppRunnerTab = "interface" | "console";

interface MiniAppRunnerTabsProps {
  /** Every widget run currently tracked for THIS mini-app (running or
   *  recently finished — see `MiniAppRunner`'s `executionWidgets`). Order is
   *  not significant; the Console body sorts by `startedAt` itself. */
  entries: ReadonlyArray<MiniAppConsoleEntry>;
  activeTab: MiniAppRunnerTab;
  onTabChange: (tab: MiniAppRunnerTab) => void;
  /** The Interface tab's body — the widget panel (or its empty state),
   *  rendered by `MiniAppRunner`. Kept as a prop rather than owned here so
   *  this component stays scoped to the tab strip + Console body, matching
   *  `MiniAppRunner`'s existing widget-panel JSX. */
  interfaceBody: ReactElement;
}

/** Runs sorted newest-first (by `startedAt`) — the Console tab's chip
 *  order, mirroring OutputPanel's recents strip. The newest run is also the
 *  default selection, so a fresh click lands on the log the user just
 *  started. */
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
        .sort((a, b) => b.execution.startedAt - a.execution.startedAt),
    [entries, executions],
  );
}

interface ConsoleTabBodyProps {
  runs: ReadonlyArray<{ entry: MiniAppConsoleEntry; execution: Execution }>;
}

/**
 * Per-process console: a chip strip (one chip per tracked run, newest
 * first), the selected run's toolbar (label · status · PID · Clear/Cancel),
 * that run's own log, and a stdin row targeting exactly that run. There is
 * deliberately NO merged across-runs view — with several concurrent
 * processes a single interleaved log makes the stdin target ambiguous, so
 * the chips ARE the process list and the selection is the stdin target.
 *
 * Selection falls back to the newest run whenever the selected run has been
 * cleared or evicted (`selected ?? runs[0]`), so the body never renders
 * against a stale id. Clear removes ONLY the selected (terminated) run via
 * `clearExecution(id)` — a running run shows Cancel instead and cannot be
 * cleared mid-flight.
 */
function ConsoleTabBody({ runs }: ConsoleTabBodyProps): ReactElement {
  const { t } = useTranslation();
  const { show } = useContextMenu();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [stdinCommand, setStdinCommand] = useState("");
  const [stdinPending, setStdinPending] = useState(false);

  const selected = runs.find((r) => r.execution.id === selectedRunId) ?? runs[0];

  const isActive =
    selected !== undefined &&
    (selected.execution.status === "running" ||
      selected.execution.status === "pending");
  const acceptsStdin = isActive && selected.execution.stdin === true;

  const selectedExecutionId = selected?.execution.id ?? null;

  // The stdin input is per-target: typed text always belongs to the run it
  // was typed FOR. When the target changes (chip click, or the selected run
  // was cleared/evicted and selection fell back to another run), drop the
  // draft — otherwise pressing Enter after a switch would silently send the
  // previous run's command to the new one.
  useEffect(() => {
    setStdinCommand("");
  }, [selectedExecutionId]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [selectedRunId, selected?.execution.log.length]);

  const submitStdin = async (): Promise<void> => {
    if (selected === undefined || !acceptsStdin) return;
    if (stdinCommand.trim() === "" || stdinPending) return;
    setStdinPending(true);
    try {
      await sendExecutionStdin(selected.execution.id, stdinCommand);
      setStdinCommand("");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      Message.error(
        t("miniapps.console.stdinFailed", {
          defaultValue: "Failed to send command: {{detail}}",
          detail,
        }),
      );
    } finally {
      setStdinPending(false);
    }
  };

  const handleStdinKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key === "Enter") void submitStdin();
  };

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

  if (selected === undefined) {
    return (
      <div className="empty-state">
        {t("miniapps.console.empty", { defaultValue: "No output yet." })}
      </div>
    );
  }

  const { entry, execution } = selected;

  return (
    <>
      <div
        className="miniapp-console__chips"
        role="group"
        aria-label={t("miniapps.console.chipsLabel", { defaultValue: "Runs" })}
      >
        {runs.map(({ entry: chipEntry, execution: chipExecution }) => {
          const chipIsActive =
            chipExecution.status === "running" ||
            chipExecution.status === "pending";
          const isSelected = chipExecution.id === execution.id;
          return (
            <button
              key={chipExecution.id}
              type="button"
              aria-pressed={isSelected}
              className={`miniapp-console__chip${
                isSelected ? " is-active" : ""
              }`}
              onClick={() => setSelectedRunId(chipExecution.id)}
              title={chipEntry.widgetLabel}
            >
              {chipIsActive ? (
                <span
                  className="miniapp-console__chip-spinner"
                  aria-hidden="true"
                >
                  <SpinnerIcon />
                </span>
              ) : null}
              <span className="miniapp-console__chip-label">
                {chipEntry.widgetLabel}
              </span>
            </button>
          );
        })}
      </div>
      <div className="miniapp-console__toolbar">
        <span
          className="miniapp-console__toolbar-label"
          title={entry.widgetLabel}
        >
          {entry.widgetLabel}
        </span>
        <span className="miniapp-console__toolbar-status">
          {t(`miniapps.console.status.${execution.status}`, {
            defaultValue: execution.status,
          })}
        </span>
        <span className="miniapp-console__toolbar-pid">
          {execution.pid !== undefined
            ? t("miniapps.console.pid", {
                defaultValue: "PID {{pid}}",
                pid: execution.pid,
              })
            : isActive
              ? t("miniapps.console.pidPending", {
                  defaultValue: "starting…",
                })
              : ""}
        </span>
        <span className="miniapp-console__toolbar-actions">
          {!isActive ? (
            <button
              type="button"
              className="btn btn--ghost btn--icon"
              onClick={() => {
                useExecutionStore.getState().clearExecution(execution.id);
              }}
              aria-label={t("common.clear")}
              title={t("common.clear")}
            >
              <ClearIcon />
            </button>
          ) : null}
          {isActive ? (
            <button
              type="button"
              className="btn btn--ghost btn--icon"
              onClick={() => {
                void cancelExecution(execution.id).catch((err: unknown) => {
                  console.error(
                    "failed to cancel mini-app process",
                    execution.id,
                    err,
                  );
                });
              }}
              aria-label={t("miniapps.console.cancel", {
                defaultValue: "Cancel",
              })}
              title={t("miniapps.console.cancel", { defaultValue: "Cancel" })}
            >
              <CancelIcon />
            </button>
          ) : null}
        </span>
      </div>
      <div
        ref={bodyRef}
        className="miniapp-console__body"
        onContextMenu={handleContextMenu}
      >
        {execution.log.length === 0 && isActive ? (
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
      {acceptsStdin ? (
        <div className="miniapp-console__stdin">
          <input
            className="input miniapp-console__stdin-input"
            value={stdinCommand}
            onChange={(event) => setStdinCommand(event.target.value)}
            onKeyDown={handleStdinKeyDown}
            disabled={stdinPending}
            placeholder={t("miniapps.console.stdinPlaceholder", {
              defaultValue: "Type a command and press Enter",
            })}
            aria-label={t("miniapps.console.stdinInput", {
              defaultValue: "Process input",
            })}
          />
        </div>
      ) : null}
    </>
  );
}

/**
 * Permanent 2-tab layout for the Mini-App runner: Interface / Console,
 * positioned under the runner's header.
 *
 *  - Interface: the widget panel (owned by `MiniAppRunner`, passed in as
 *    `interfaceBody`).
 *  - Console: per-process run chips + the selected run's log, status, PID,
 *    Clear/Cancel, and stdin. A live badge on the tab itself shows the
 *    running count (it used to live on a separate Processes tab, which the
 *    chips absorbed — a running chip IS the process row).
 *
 * Deliberately NO auto-switching between tabs when a run starts — the
 * user's tab choice is authoritative.
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
        {activeTab === "console" ? <ConsoleTabBody runs={runs} /> : null}
      </div>
    </div>
  );
}
