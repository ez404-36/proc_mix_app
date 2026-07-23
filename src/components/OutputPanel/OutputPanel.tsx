import { useEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useShallow } from "zustand/react/shallow";
import { useContextMenu } from "../ContextMenu";
import type { ContextMenuEntry } from "../ContextMenu";
import { AnsiText } from "../AnsiText";
import { buildConsoleCopyMenu } from "../../utils/consoleClipboard";
import { formatTargetBadge, isRemoteTarget } from "../../utils/targetLabel";
import { useExecutionStore } from "../../stores/executionStore";
import type { ConsoleDockPosition } from "../../stores/executionStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { Dropdown } from "../Dropdown";
import type { DropdownOption } from "../Dropdown";
import { useCommandStore } from "../../stores/commandStore";
import { useWorkflowStore } from "../../stores/workflowStore";
import { useUIStore } from "../../stores/uiStore";
import type {
  Command,
  Execution,
  ExecutionStatus,
  ExtractedResult,
  Workflow,
} from "../../types";
import { cancelExecution } from "../../utils/executor";
import { triggerCommandRun } from "../../services/commandRunner";
import { triggerWorkflowRun } from "../../services/workflowRunner";
import { cancelWorkflow } from "../../utils/workflowRunner";
import { TerminalPanel } from "../Terminal";
import {
  CancelIcon,
  ClearIcon,
  EditIcon,
  PinIcon,
  RerunIcon,
  SpinnerIcon,
  StatusCheckIcon,
  StatusCrossIcon,
  TrashIcon,
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
          className={`output-line output-line--${line.stream}${
            line.variant === "workdir" ? " output-line--workdir" : ""
          }`}
        >
          <AnsiText text={line.line} />
        </div>
      ))}
      {execution.error ? (
        <div className="output-line output-line--stderr">
          <AnsiText text={execution.error} />
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
 * plus the field map as pretty-printed JSON. Kept deliberately simple (a
 * JSON tree could come later) so the data is always inspectable.
 *
 * The Fields block is de-duplicated against the return value: any field
 * whose value equals the chosen `returnValue` is dropped from the Fields
 * display, and the whole block is hidden when nothing distinct remains.
 * This mirrors the command-form schema preview (see OutputSchemaEditor)
 * and eliminates the confusing case where "Return value" and "Fields"
 * showed byte-for-byte identical JSON — e.g. a single-field parse with no
 * return field selected (returnValue = the whole field object).
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
  const returnValueJson = JSON.stringify(result.returnValue);
  const distinctFields = Object.fromEntries(
    Object.entries(result.fields).filter(
      ([, v]) => JSON.stringify(v) !== returnValueJson,
    ),
  );
  const fieldsJson = JSON.stringify(result.fields);
  // Hide the Fields block when it adds nothing beyond the return value:
  // either every field equalled the return value (nothing distinct left),
  // or the field map as a whole is identical to the return value (the
  // "whole result" case where no return field was selected).
  const showFields =
    Object.keys(distinctFields).length > 0 && fieldsJson !== returnValueJson;
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
      {showFields ? (
        <div className="output-panel__result-section">
          <span className="output-panel__result-label">
            {t("outputPanel.result.fields", { defaultValue: "Fields" })}
          </span>
          <pre className="output-panel__result-json">
            {JSON.stringify(distinctFields, null, 2)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

export function OutputPanel(): ReactElement | null {
  const { t } = useTranslation();
  const {
    panelOpen,
    activeExecutionId,
    executions,
    recentIds,
    setPanelOpen,
    setActiveExecution,
    clearTerminated,
    clearExecution,
    renameExecution,
    setPinned,
    reorderRecent,
    panelHeight,
    setPanelHeight,
    panelWidth,
    setPanelWidth,
  } = useExecutionStore(
    useShallow((s) => ({
      panelOpen: s.panelOpen,
      activeExecutionId: s.activeExecutionId,
      executions: s.executions,
      recentIds: s.recentIds,
      setPanelOpen: s.setPanelOpen,
      setActiveExecution: s.setActiveExecution,
      clearTerminated: s.clearTerminated,
      clearExecution: s.clearExecution,
      renameExecution: s.renameExecution,
      setPinned: s.setPinned,
      reorderRecent: s.reorderRecent,
      panelHeight: s.panelHeight,
      setPanelHeight: s.setPanelHeight,
      panelWidth: s.panelWidth,
      setPanelWidth: s.setPanelWidth,
    })),
  );
  // The command currently open in the full-screen editor (if any) and its
  // live, possibly-unsaved Script body. A re-run of that exact command must
  // replay what the user is editing — not the last-saved version.
  const {
    consolePosition,
    setConsolePosition,
    editorTarget,
    editorLiveScript,
  } = useUIStore(
    useShallow((s) => ({
      consolePosition: s.consolePosition,
      setConsolePosition: s.setConsolePosition,
      editorTarget: s.commandEditorTarget,
      editorLiveScript: s.commandEditorLiveScript,
    })),
  );
  const commands = useCommandStore((s) => s.commands);
  const workflows = useWorkflowStore((s) => s.workflows);
  const { show } = useContextMenu();

  const { panelMode, setPanelMode } = useTerminalStore(
    useShallow((s) => ({
      panelMode: s.panelMode,
      setPanelMode: s.setPanelMode,
    })),
  );

  // Fullscreen: expands the console to fill the whole app window, ignoring
  // `consolePosition`/`panelHeight`/`panelWidth` (CSS-only overlay, see
  // `.output-panel--fullscreen`). Local, transient component state —
  // deliberately NOT persisted (a viewing mode, not a layout preference to
  // reopen the app into) and reset whenever the panel closes so reopening
  // the console never surprises the user with fullscreen still active from
  // a previous session.
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!panelOpen) setFullscreen(false);
  }, [panelOpen]);

  // "Fullscreen" is offered as a FOURTH option in the same position dropdown
  // (not a separate toggle button) — it reads as one more display mode
  // alongside Bottom/Right/Left, matching how the user thinks about it.
  // The underlying `consolePosition` store value is untouched by picking
  // it: only the local `fullscreen` flag flips, so the dock position the
  // user had before is exactly what they land back on when they pick
  // Bottom/Right/Left again (or close and reopen the console).
  const positionOptions: ReadonlyArray<DropdownOption> = [
    { value: "bottom", label: t("outputPanel.position.bottom", { defaultValue: "Снизу" }) },
    { value: "right", label: t("outputPanel.position.right", { defaultValue: "Справа" }) },
    { value: "left", label: t("outputPanel.position.left", { defaultValue: "Слева" }) },
    {
      value: "fullscreen",
      label: t("outputPanel.fullscreen", { defaultValue: "Весь экран" }),
    },
  ];
  const positionValue = fullscreen ? "fullscreen" : consolePosition;

  const handlePositionChange = (value: string): void => {
    if (value === "fullscreen") {
      setFullscreen(true);
      return;
    }
    setFullscreen(false);
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

  // The recents-strip button currently being renamed inline (its execution id),
  // plus the live text. `null` = no rename in progress. Commit on Enter/blur.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<string>("");

  const beginRename = (exec: Execution): void => {
    setRenamingId(exec.id);
    setRenameDraft(exec.customName ?? exec.commandName);
  };
  const commitRename = (): void => {
    if (renamingId !== null) {
      renameExecution(renamingId, renameDraft);
    }
    setRenamingId(null);
    setRenameDraft("");
  };
  const cancelRename = (): void => {
    setRenamingId(null);
    setRenameDraft("");
  };

  // Native drag-and-drop reordering of the recents strip. `draggingId` is the
  // run being dragged; `dropTargetId` is the run currently hovered as a drop
  // slot — used to highlight a valid target. A drop calls `reorderRecent`,
  // which itself rejects moves that would cross the pinned/unpinned boundary,
  // so we only need to surface the constraint visually here.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const handleRecentDrop = (overId: string): void => {
    if (draggingId !== null && draggingId !== overId) {
      reorderRecent(draggingId, overId);
    }
    setDraggingId(null);
    setDropTargetId(null);
  };

  // Whether a drag from `draggingId` may legally drop onto `overId` — same
  // pinned/unpinned partition. Mirrors the store's constraint so the hovered
  // target is only highlighted (and the cursor allowed) for valid drops.
  const canDropOn = (overId: string): boolean => {
    if (draggingId === null || draggingId === overId) return false;
    const a = executions[draggingId];
    const b = executions[overId];
    if (!a || !b) return false;
    return (a.pinned ?? false) === (b.pinned ?? false);
  };

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

  // The source that produced the active execution, if it still exists. Drives
  // the Re-run button:
  //   - a command execution → the source Command (replayed via triggerCommandRun)
  //   - a workflow aggregate → the source Workflow (replayed via triggerWorkflowRun)
  // An execution whose source was deleted, or a transient live-run with no
  // source id, cannot be replayed, so the button is hidden in those cases.
  const rerunSource = useMemo(():
    | { kind: "command"; command: Command }
    | { kind: "workflow"; workflow: Workflow }
    | null => {
    if (active?.isWorkflow) {
      if (!active.workflowId) return null;
      const wf = workflows.find((w) => w.id === active.workflowId);
      return wf ? { kind: "workflow", workflow: wf } : null;
    }
    if (!active?.commandId) return null;
    const cmd = commands.find((c) => c.id === active.commandId);
    return cmd ? { kind: "command", command: cmd } : null;
  }, [active?.isWorkflow, active?.workflowId, active?.commandId, commands, workflows]);

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

    if (rerunSource.kind === "workflow") {
      // Re-run a whole workflow. Drop the previous aggregate from the current
      // terminal first so the replay visually replaces it; a fresh run id is
      // assigned by triggerWorkflowRun.
      clearExecution(active.id);
      void triggerWorkflowRun(rerunSource.workflow);
      return;
    }

    const sourceCommand = rerunSource.command;
    // If the user is editing this exact command in the full-screen editor,
    // replay the live (possibly unsaved) Script body rather than the saved
    // record — running while editing must reflect the edit. Otherwise run the
    // persisted command verbatim.
    const isEditingThisCommand =
      editorTarget?.mode === "edit" &&
      editorTarget.commandId === sourceCommand.id &&
      editorLiveScript !== null;
    const target: Command = isEditingThisCommand
      ? { ...sourceCommand, script: editorLiveScript }
      : sourceCommand;

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
    //
    // Also carry the previous run's effective working directory so a
    // command with `promptWorkingDir` does NOT re-open the directory prompt
    // on re-run — the re-run must reuse the same directory the user already
    // chose. `active.workingDir` is the resolved directory (an explicit path,
    // or the home dir when the previous run used the default); supplying it
    // as an override short-circuits the prompt in `triggerCommandRun`.
    // Absent for a remote (SSH) run, where the local cwd does not apply — in
    // that case it stays undefined and no override is passed.
    void triggerCommandRun(target, {
      variableValues: active.variableValuesRaw ?? {},
      ...(active.workingDir !== undefined
        ? { workingDir: active.workingDir }
        : {}),
    });
  };

  // Build the recents-strip context menu for one run: rename, pin/unpin, delete.
  const buildRecentMenu = (exec: Execution): ContextMenuEntry[] => [
    {
      id: "rename",
      label: t("outputPanel.recentMenu.rename"),
      icon: <EditIcon />,
      onSelect: () => beginRename(exec),
    },
    {
      id: "pin",
      label: exec.pinned
        ? t("outputPanel.recentMenu.unpin")
        : t("outputPanel.recentMenu.pin"),
      icon: <PinIcon />,
      onSelect: () => setPinned(exec.id, !exec.pinned),
    },
    { id: "div1", divider: true },
    {
      id: "delete",
      label: t("outputPanel.recentMenu.delete"),
      icon: <TrashIcon />,
      danger: true,
      onSelect: () => clearExecution(exec.id),
    },
  ];

  // Fullscreen ignores the docked size entirely (CSS `inset: 0` overrides
  // any inline height/width), so no style is needed — and applying the
  // docked size anyway would fight the CSS override for no benefit.
  const panelStyle = fullscreen
    ? undefined
    : consolePosition === "bottom"
      ? { height: panelHeight }
      : { width: panelWidth };

  return (
    <div
      className={`output-panel output-panel--${consolePosition}${
        fullscreen ? " output-panel--fullscreen" : ""
      }`}
      role="region"
      aria-label={t("outputPanel.ariaLabel")}
      style={panelStyle}
    >
      {/* Dragging to resize a docked size makes no sense once fullscreen
          already fills the window — hide the handle rather than let it
          fight the CSS override. */}
      {!fullscreen ? (
        <div
          className="output-panel__resize"
          role="separator"
          aria-orientation={consolePosition === "bottom" ? "horizontal" : "vertical"}
          aria-label={t("outputPanel.resizeLabel")}
          tabIndex={0}
          onPointerDown={handleResizePointerDown}
          onKeyDown={handleResizeKeyDown}
        />
      ) : null}
      <div className="output-panel__header">
        <div className="output-panel__title-row">
          <div
            className="output-panel__mode-toggle"
            role="tablist"
            aria-label={t("outputPanel.modeToggle.ariaLabel", {
              defaultValue: "Console mode",
            })}
          >
            <button
              type="button"
              role="tab"
              aria-selected={panelMode === "runs"}
              className={`output-panel__mode-btn${panelMode === "runs" ? " is-active" : ""}`}
              onClick={() => setPanelMode("runs")}
            >
              {t("outputPanel.modeToggle.runs", { defaultValue: "Runs" })}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={panelMode === "terminal"}
              className={`output-panel__mode-btn${
                panelMode === "terminal" ? " is-active" : ""
              }`}
              onClick={() => setPanelMode("terminal")}
            >
              {t("outputPanel.modeToggle.terminal", { defaultValue: "Terminal" })}
            </button>
          </div>
          {panelMode === "runs" ? (
            <span className="output-panel__title">
              {active
                ? (active.customName ?? active.commandName)
                : t("outputPanel.defaultTitle")}
            </span>
          ) : null}
          {panelMode === "runs" && active ? (
            <span
              className={`output-panel__status output-panel__status--${active.status}${
                active.timedOut ? " output-panel__status--timedOut" : ""
              }`}
            >
              {statusLabel(active.status, t, active.timedOut)}
            </span>
          ) : null}
          {panelMode === "runs" && active ? (
            <StatusIcon status={active.status} t={t} />
          ) : null}
          {panelMode === "runs" && active?.durationMs !== undefined ? (
            <span className="output-panel__meta">
              {formatDuration(active.durationMs)}
            </span>
          ) : null}
          {panelMode === "runs" &&
          active?.exitCode !== undefined &&
          active.exitCode !== null ? (
            <span className="output-panel__meta">
              {t("outputPanel.exitCode", { code: active.exitCode })}
            </span>
          ) : null}
          {panelMode === "runs" && active?.status === "running" ? (
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
          {panelMode === "runs" &&
          active &&
          active.status !== "running" &&
          rerunSource ? (
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
            value={positionValue}
            options={positionOptions}
            onChange={handlePositionChange}
            ariaLabel={t("outputPanel.positionTitle", { defaultValue: "Console position" })}
            className="output-panel__position-select"
          />
          {panelMode === "runs" ? (
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
          ) : null}
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

      {panelMode === "runs" && active && active.script ? (
        <div className="output-panel__script">
          <div className="output-panel__script-meta">
            <span className="output-panel__script-shell">
              {t("outputPanel.scriptShell", {
                shell: active.shell ?? t("outputPanel.defaultShell"),
              })}
            </span>
            {active.workingDir ? (
              <span className="output-panel__script-dir">
                {active.workingDir}
              </span>
            ) : null}
            {isRemoteTarget(active.target) ? (
              <span className="target-badge output-panel__script-target">
                {formatTargetBadge(active.target, t)}
              </span>
            ) : null}
          </div>
          <pre className="output-panel__script-body">{active.script}</pre>
        </div>
      ) : null}

      {panelMode === "terminal" ? <TerminalPanel /> : null}

      {panelMode === "runs" && active && active.variables && active.variables.length > 0 ? (
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

      {panelMode === "runs" && active && active.env && Object.keys(active.env).length > 0 ? (
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

      {panelMode === "runs" && active && hasResult ? (
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

      {panelMode === "runs" ? (
        active ? (
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
        )
      ) : null}

      {panelMode === "runs" && recents.length >= 1 ? (
        <div className="output-panel__recents">
          {recents.map((exec) => {
            const displayName = exec.customName ?? exec.commandName;
            if (renamingId === exec.id) {
              return (
                <input
                  key={exec.id}
                  type="text"
                  className="input output-panel__recent-rename"
                  value={renameDraft}
                  autoFocus
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitRename();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelRename();
                    }
                  }}
                  aria-label={t("outputPanel.recentMenu.rename")}
                />
              );
            }
            const isDropTarget = dropTargetId === exec.id && canDropOn(exec.id);
            return (
              <button
                key={exec.id}
                type="button"
                draggable
                className={`output-panel__recent${
                  exec.id === activeExecutionId ? " is-active" : ""
                }${exec.pinned ? " output-panel__recent--pinned" : ""}${
                  draggingId === exec.id ? " is-dragging" : ""
                }${isDropTarget ? " is-drop-target" : ""}`}
                onClick={() => setActiveExecution(exec.id)}
                onContextMenu={(e) =>
                  show({
                    event: {
                      clientX: e.clientX,
                      clientY: e.clientY,
                      preventDefault: () => e.preventDefault(),
                    },
                    items: buildRecentMenu(exec),
                  })
                }
                onDragStart={(e) => {
                  setDraggingId(exec.id);
                  // Required for Firefox to initiate the drag; the payload is
                  // unused (state holds the dragged id).
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", exec.id);
                }}
                onDragOver={(e) => {
                  // Only accept the drop (and show the move cursor) when the
                  // target is in the same partition as the dragged run.
                  if (canDropOn(exec.id)) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dropTargetId !== exec.id) setDropTargetId(exec.id);
                  } else {
                    e.dataTransfer.dropEffect = "none";
                  }
                }}
                onDragLeave={() => {
                  if (dropTargetId === exec.id) setDropTargetId(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  handleRecentDrop(exec.id);
                }}
                onDragEnd={() => {
                  setDraggingId(null);
                  setDropTargetId(null);
                }}
                title={displayName}
              >
                {exec.pinned ? (
                  <span
                    className="output-panel__recent-pin"
                    aria-label={t("outputPanel.pinnedLabel")}
                    title={t("outputPanel.pinnedLabel")}
                  >
                    <PinIcon />
                  </span>
                ) : null}
                <span
                  className={`output-panel__recent-dot output-panel__recent-dot--${exec.status}`}
                  aria-hidden="true"
                />
                <span className="output-panel__recent-name">{displayName}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
