import { useEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useContextMenu } from "../ContextMenu";
import { buildConsoleCopyMenu } from "../../utils/consoleClipboard";
import { useExecutionStore } from "../../stores/executionStore";
import type { ConsoleDockPosition } from "../../stores/executionStore";
import { Dropdown } from "../Dropdown";
import type { DropdownOption } from "../Dropdown";
import { useCommandStore } from "../../stores/commandStore";
import { useUIStore } from "../../stores/uiStore";
import type {
  Command,
  Execution,
  ExecutionStatus,
  ExtractedResult,
} from "../../types";
import { cancelExecution } from "../../utils/executor";
import { triggerCommandRun } from "../../services/commandRunner";
import { cancelWorkflow } from "../../utils/workflowRunner";
import {
  CancelIcon,
  ClearIcon,
  RerunIcon,
  SpinnerIcon,
  StatusCheckIcon,
  StatusCrossIcon,
} from "../icons";

const RECENT_VISIBLE = 10;

function statusLabel(
  status: ExecutionStatus,
  t: TFunction,
  timedOut?: boolean,
): string {
  switch (status) {
    case "pending":
      return t("outputPanel.status.pending");
    case "running":
      return t("outputPanel.status.running");
    case "success":
      return t("outputPanel.status.success");
    case "error":
      // A timeout is reported as an `error` status carrying `timedOut`.
      // Surface a distinct label so the user understands the run was
      // stopped by its timeout, not by a non-zero exit code.
      return timedOut
        ? t("outputPanel.timedOut")
        : t("outputPanel.status.error");
    case "cancelled":
      return t("outputPanel.status.cancelled");
  }
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Visual loader/status icon shown next to the status badge. Mirrors the
 * `StatusIcon` used by the inline command-form output:
 *   - running  → animated SVG spinner
 *   - success  → solid green check
 *   - error    → solid red cross
 *   - pending / cancelled → no icon (badge alone conveys the state)
 *
 * Icons are inline SVGs (no dependency, no emoji). Color uses CSS classes
 * so theme switching follows the rest of the app. Each icon carries an
 * `aria-label` for screen readers.
 */
interface StatusIconProps {
  status: ExecutionStatus;
  t: TFunction;
}

function StatusIcon({ status, t }: StatusIconProps): ReactElement | null {
  switch (status) {
    case "running":
      return (
        <span
          className="output-panel__status-icon output-panel__status-icon--running"
          role="img"
          aria-label={t("outputPanel.status.running")}
        >
          <SpinnerIcon />
        </span>
      );
    case "success":
      return (
        <span
          className="output-panel__status-icon output-panel__status-icon--success"
          role="img"
          aria-label={t("outputPanel.status.success")}
        >
          <StatusCheckIcon />
        </span>
      );
    case "error":
      return (
        <span
          className="output-panel__status-icon output-panel__status-icon--error"
          role="img"
          aria-label={t("outputPanel.status.error")}
        >
          <StatusCrossIcon />
        </span>
      );
    case "pending":
    case "cancelled":
    default:
      return null;
  }
}

interface OutputBodyProps {
  execution: Execution;
}

function OutputBody({ execution }: OutputBodyProps): ReactElement {
  const { t } = useTranslation();
  const { show } = useContextMenu();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const logLength = execution.log.length;

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logLength, execution.id]);

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

  if (execution.log.length === 0 && execution.status === "running") {
    return (
      <div
        ref={bodyRef}
        className="output-panel__body"
        onContextMenu={handleContextMenu}
      >
        <div className="output-panel__placeholder">
          {t("outputPanel.waiting")}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={bodyRef}
      className="output-panel__body"
      onContextMenu={handleContextMenu}
    >
      {execution.log.map((line, idx) => (
        <div
          key={`${execution.id}-${idx}`}
          className={`output-line output-line--${line.stream}`}
        >
          {line.line}
        </div>
      ))}
      {execution.error ? (
        <div className="output-line output-line--stderr">
          {execution.error}
        </div>
      ) : null}
      {execution.timedOut ? (
        // The executor kills a timed-out process and reports a `finished`
        // event with no error message, so without this line the terminal
        // would only show whatever the child printed before the kill —
        // leaving the user to guess why it stopped. Make the timeout
        // explicit with a dedicated, highlighted line.
        <div className="output-line output-line--timeout">
          {t("outputPanel.timedOutLine")}
        </div>
      ) : null}
    </div>
  );
}

interface ResultViewProps {
  result: ExtractedResult;
  t: TFunction;
}

/**
 * Renders the structured output extraction for the active execution: an
 * inline error when extraction failed, otherwise the chosen return value
 * plus the full field map as pretty-printed JSON. Kept deliberately
 * simple (a JSON tree could come later) so the data is always inspectable.
 */
function ResultView({ result, t }: ResultViewProps): ReactElement {
  if (result.error !== undefined) {
    return (
      <div className="output-panel__body output-panel__result">
        <div className="output-line output-line--stderr" role="alert">
          {t("outputPanel.result.error", {
            defaultValue: "Extraction failed: {{message}}",
            message: result.error,
          })}
        </div>
      </div>
    );
  }
  return (
    <div className="output-panel__body output-panel__result">
      <div className="output-panel__result-section">
        <span className="output-panel__result-label">
          {t("outputPanel.result.returnValue", {
            defaultValue: "Return value",
          })}
        </span>
        <pre className="output-panel__result-json">
          {JSON.stringify(result.returnValue, null, 2)}
        </pre>
      </div>
      <div className="output-panel__result-section">
        <span className="output-panel__result-label">
          {t("outputPanel.result.fields", { defaultValue: "Fields" })}
        </span>
        <pre className="output-panel__result-json">
          {JSON.stringify(result.fields, null, 2)}
        </pre>
      </div>
    </div>
  );
}

export function OutputPanel(): ReactElement | null {
  const { t } = useTranslation();
  const panelOpen = useExecutionStore((s) => s.panelOpen);
  const activeExecutionId = useExecutionStore((s) => s.activeExecutionId);
  const executions = useExecutionStore((s) => s.executions);
  const recentIds = useExecutionStore((s) => s.recentIds);
  const setPanelOpen = useExecutionStore((s) => s.setPanelOpen);
  const setActiveExecution = useExecutionStore((s) => s.setActiveExecution);
  const clearTerminated = useExecutionStore((s) => s.clearTerminated);
  const clearExecution = useExecutionStore((s) => s.clearExecution);
  const panelHeight = useExecutionStore((s) => s.panelHeight);
  const setPanelHeight = useExecutionStore((s) => s.setPanelHeight);
  const panelWidth = useExecutionStore((s) => s.panelWidth);
  const setPanelWidth = useExecutionStore((s) => s.setPanelWidth);
  const consolePosition = useUIStore((s) => s.consolePosition);
  const setConsolePosition = useUIStore((s) => s.setConsolePosition);
  const commands = useCommandStore((s) => s.commands);
  // The command currently open in the full-screen editor (if any) and its
  // live, possibly-unsaved Script body. A re-run of that exact command must
  // replay what the user is editing — not the last-saved version.
  const editorTarget = useUIStore((s) => s.commandEditorTarget);
  const editorLiveScript = useUIStore((s) => s.commandEditorLiveScript);

  const positionOptions: ReadonlyArray<DropdownOption> = [
    { value: "bottom", label: t("outputPanel.position.bottom", { defaultValue: "Снизу" }) },
    { value: "right", label: t("outputPanel.position.right", { defaultValue: "Справа" }) },
    { value: "left", label: t("outputPanel.position.left", { defaultValue: "Слева" }) },
  ];

  const handlePositionChange = (value: string): void => {
    setConsolePosition(value as ConsoleDockPosition);
  };

  // Drag-to-resize. For bottom dock: drag the top edge (vertical). For
  // left/right dock: drag the inner edge (horizontal). The store clamps.
  const handleResizePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);

    if (consolePosition === "bottom") {
      const startY = event.clientY;
      const startHeight = panelHeight;
      const onMove = (moveEvent: PointerEvent): void => {
        setPanelHeight(startHeight + (startY - moveEvent.clientY));
      };
      const onUp = (): void => {
        handle.releasePointerCapture(event.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    } else {
      const startX = event.clientX;
      const startWidth = panelWidth;
      const onMove = (moveEvent: PointerEvent): void => {
        const delta =
          consolePosition === "right"
            ? startX - moveEvent.clientX
            : moveEvent.clientX - startX;
        setPanelWidth(startWidth + delta);
      };
      const onUp = (): void => {
        handle.releasePointerCapture(event.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    }
  };

  const handleResizeKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ): void => {
    const STEP = 24;
    if (consolePosition === "bottom") {
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setPanelHeight(panelHeight + STEP);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setPanelHeight(panelHeight - STEP);
      }
    } else {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setPanelWidth(panelWidth + (consolePosition === "right" ? STEP : -STEP));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setPanelWidth(panelWidth + (consolePosition === "right" ? -STEP : STEP));
      }
    }
  };

  const active: Execution | null = useMemo(() => {
    if (!activeExecutionId) return null;
    return executions[activeExecutionId] ?? null;
  }, [activeExecutionId, executions]);

  // Which body tab is shown: the raw output log or the structured result.
  // Only meaningful when the active execution carries a `result`. Reset to
  // "output" whenever the active execution changes so switching processes
  // never lands on a stale Result tab.
  const [activeTab, setActiveTab] = useState<"output" | "result">("output");
  useEffect(() => {
    setActiveTab("output");
  }, [activeExecutionId]);

  useEffect(() => {
    const root = document.documentElement;
    // When the panel is closed the component renders `null` but stays
    // mounted (it lives at the App root), so its cleanup never runs on
    // close. Clear the `<html>` markers here, keyed on `panelOpen`, so the
    // side-dock `app-shell` padding is released and the layout reclaims its
    // full width the moment the console is closed.
    const clearMarkers = (): void => {
      root.removeAttribute("data-console-position");
      root.removeAttribute("data-console-open");
      root.style.removeProperty("--console-side-width");
    };
    if (!panelOpen) {
      clearMarkers();
      return;
    }
    root.dataset["consolePosition"] = consolePosition;
    root.dataset["consoleOpen"] = "true";
    if (consolePosition !== "bottom") {
      root.style.setProperty("--console-side-width", `${panelWidth}px`);
    } else {
      root.style.removeProperty("--console-side-width");
    }
    return clearMarkers;
  }, [panelOpen, consolePosition, panelWidth]);
  const hasResult = active?.result !== undefined;

  // The command that produced the active execution, if it still exists.
  // Drives the Re-run button: an execution whose source command was
  // deleted (or that was never tied to a command, e.g. a transient
  // live-run) cannot be replayed, so the button is hidden in those cases.
  // A workflow aggregate has no single source command and is excluded
  // explicitly (it also has no `commandId`, but the marker makes intent
  // clear and is robust if a workflow ever carries one).
  const rerunSource = useMemo(() => {
    if (active?.isWorkflow) return null;
    if (!active?.commandId) return null;
    return commands.find((c) => c.id === active.commandId) ?? null;
  }, [active?.isWorkflow, active?.commandId, commands]);

  const recents = useMemo(
    () =>
      recentIds
        .slice(0, RECENT_VISIBLE)
        .map((id) => executions[id])
        .filter((e): e is Execution => e !== undefined),
    [recentIds, executions],
  );

  if (!panelOpen) return null;

  const handleCancel = (): void => {
    if (!active) return;
    // A workflow aggregate's `id` is the workflow run id, not a single
    // execution id — cancelling it must stop the WHOLE workflow (which in
    // turn kills the in-flight node), so route through `cancelWorkflow`.
    // A plain command execution cancels just that execution.
    if (active.isWorkflow) {
      cancelWorkflow(active.id).catch((err) => {
        console.error("cancel workflow failed", err);
      });
      return;
    }
    cancelExecution(active.id).catch((err) => {
      console.error("cancel failed", err);
    });
  };

  const handleClose = (): void => {
    setPanelOpen(false);
  };

  const handleClear = (): void => {
    // Clear only terminal executions (finished / errored / cancelled);
    // anything still running stays so the user doesn't lose live output.
    // The panel stays open — closing is the "Close" button's job.
    clearTerminated();
  };

  const handleRerun = (): void => {
    if (!rerunSource || !active) return;
    // If the user is editing this exact command in the full-screen editor,
    // replay the live (possibly unsaved) Script body rather than the saved
    // record — running while editing must reflect the edit. Otherwise run the
    // persisted command verbatim.
    const isEditingThisCommand =
      editorTarget?.mode === "edit" &&
      editorTarget.commandId === rerunSource.id &&
      editorLiveScript !== null;
    const target: Command = isEditingThisCommand
      ? { ...rerunSource, script: editorLiveScript }
      : rerunSource;

    // Re-run in the CURRENT terminal: drop the previous execution (clearing
    // its log) so the re-run doesn't pile up as a separate entry in the
    // recents strip. We deliberately do NOT reuse the old execution id —
    // every run gets a fresh id so its history row (keyed by execution id)
    // stays unique. `triggerCommandRun` registers the new run and makes the
    // panel switch to it, so it visually replaces the one we just cleared.
    clearExecution(active.id);
    // Pass the raw variable values from the previous run so the user is
    // not prompted again. Falls back to an empty map (fresh prompt) when
    // the previous execution did not capture variable values.
    void triggerCommandRun(target, {
      variableValues: active.variableValuesRaw ?? {},
    });
  };

  const panelStyle =
    consolePosition === "bottom"
      ? { height: panelHeight }
      : { width: panelWidth };

  return (
    <div
      className={`output-panel output-panel--${consolePosition}`}
      role="region"
      aria-label={t("outputPanel.ariaLabel")}
      style={panelStyle}
    >
      <div
        className="output-panel__resize"
        role="separator"
        aria-orientation={consolePosition === "bottom" ? "horizontal" : "vertical"}
        aria-label={t("outputPanel.resizeLabel")}
        tabIndex={0}
        onPointerDown={handleResizePointerDown}
        onKeyDown={handleResizeKeyDown}
      />
      <div className="output-panel__header">
        <div className="output-panel__title-row">
          <span className="output-panel__title">
            {active ? active.commandName : t("outputPanel.defaultTitle")}
          </span>
          {active ? (
            <span
              className={`output-panel__status output-panel__status--${active.status}${
                active.timedOut ? " output-panel__status--timedOut" : ""
              }`}
            >
              {statusLabel(active.status, t, active.timedOut)}
            </span>
          ) : null}
          {active ? <StatusIcon status={active.status} t={t} /> : null}
          {active?.durationMs !== undefined ? (
            <span className="output-panel__meta">
              {formatDuration(active.durationMs)}
            </span>
          ) : null}
          {active?.exitCode !== undefined && active.exitCode !== null ? (
            <span className="output-panel__meta">
              {t("outputPanel.exitCode", { code: active.exitCode })}
            </span>
          ) : null}
          {active?.status === "running" ? (
            <button
              type="button"
              className="btn command-form__action command-form__action--cancel output-panel__inline-action"
              onClick={handleCancel}
              title={t("outputPanel.cancelTitle")}
            >
              <span className="command-form__action-icon--cancel">
                <CancelIcon />
              </span>
              {t("common.cancel")}
            </button>
          ) : null}
          {active && active.status !== "running" && rerunSource ? (
            <button
              type="button"
              className="btn command-form__action command-form__action--run output-panel__inline-action"
              onClick={handleRerun}
              title={t("outputPanel.rerunTitle")}
            >
              <span className="command-form__action-icon--run">
                <RerunIcon />
              </span>
              {t("outputPanel.rerun")}
            </button>
          ) : null}
        </div>
        <div className="output-panel__actions">
          <Dropdown
            value={consolePosition}
            options={positionOptions}
            onChange={handlePositionChange}
            ariaLabel={t("outputPanel.positionTitle", { defaultValue: "Console position" })}
            className="output-panel__position-select"
          />
          <button
            type="button"
            className="btn command-form__action command-form__action--cancel"
            onClick={handleClear}
            title={t("outputPanel.clearTitle")}
          >
            <span className="command-form__action-icon--cancel">
              <ClearIcon />
            </span>
            {t("common.clear")}
          </button>
          <button
            type="button"
            className="btn btn--view command-form__action"
            onClick={handleClose}
            title={t("outputPanel.closeTitle")}
          >
            <span className="btn--view-icon">
              <CancelIcon />
            </span>
            {t("common.close")}
          </button>
        </div>
      </div>

      {active && active.script ? (
        <div className="output-panel__script">
          <span className="output-panel__script-shell">
            {active.shell ?? t("outputPanel.defaultShell")}
          </span>
          <pre className="output-panel__script-body">{active.script}</pre>
        </div>
      ) : null}

      {active && active.variables && active.variables.length > 0 ? (
        <dl className="output-panel__variables">
          <dt className="output-panel__variables-title">
            {t("outputPanel.variablesTitle")}
          </dt>
          {active.variables.map((variable) => (
            <div key={variable.name} className="output-panel__variable">
              <span className="output-panel__variable-name">
                {variable.name}
              </span>
              <span
                className={`output-panel__variable-value${
                  variable.sensitive
                    ? " output-panel__variable-value--sensitive"
                    : ""
                }`}
              >
                {variable.value}
              </span>
            </div>
          ))}
        </dl>
      ) : null}

      {active && active.env && Object.keys(active.env).length > 0 ? (
        <dl className="output-panel__variables output-panel__env">
          <dt className="output-panel__variables-title">
            {t("outputPanel.envTitle", { defaultValue: "Environment" })}
          </dt>
          {Object.entries(active.env).map(([key, value]) => (
            <div key={key} className="output-panel__variable">
              <span className="output-panel__variable-name output-panel__env-key">
                {key}
              </span>
              <span className="output-panel__variable-value">
                {value}
              </span>
            </div>
          ))}
        </dl>
      ) : null}

      {active && hasResult ? (
        <div className="output-panel__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "output"}
            className={`output-panel__tab${
              activeTab === "output" ? " is-active" : ""
            }`}
            onClick={() => setActiveTab("output")}
          >
            {t("outputPanel.tabs.output", { defaultValue: "Output" })}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "result"}
            className={`output-panel__tab${
              activeTab === "result" ? " is-active" : ""
            }`}
            onClick={() => setActiveTab("result")}
          >
            {t("outputPanel.tabs.result", { defaultValue: "Result" })}
          </button>
        </div>
      ) : null}

      {active ? (
        hasResult && activeTab === "result" && active.result ? (
          <ResultView result={active.result} t={t} />
        ) : (
          <OutputBody execution={active} />
        )
      ) : (
        <div className="output-panel__body">
          <div className="output-panel__placeholder">
            {t("outputPanel.noSelection")}
          </div>
        </div>
      )}

      {recents.length > 1 ? (
        <div className="output-panel__recents">
          {recents.map((exec) => (
            <button
              key={exec.id}
              type="button"
              className={`output-panel__recent${
                exec.id === activeExecutionId ? " is-active" : ""
              }`}
              onClick={() => setActiveExecution(exec.id)}
              title={exec.commandName}
            >
              <span
                className={`output-panel__recent-dot output-panel__recent-dot--${exec.status}`}
                aria-hidden="true"
              />
              <span className="output-panel__recent-name">
                {exec.commandName}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
