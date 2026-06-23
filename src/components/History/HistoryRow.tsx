// One row in the History list. Shows the kind (Created/Edited/…),
// the localized "<verb> <name>" sentence, a timestamp, and — for the
// undoable variants — the action buttons.
//
// Action-button visibility rules (per the requirements):
//   - commandEdited  → "Undo" visible only while the command still
//                       exists. If the user deletes it later, undo
//                       no longer makes sense (the command is gone).
//   - commandDeleted → "Restore" visible only while the command does
//                       NOT currently exist. After a successful
//                       restore, the row's Restore button hides
//                       because the command is back.
// All other kinds have no action buttons.

import { type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useCommandStore } from "../../stores/commandStore";
import { useHistoryStore } from "../../stores/historyStore";
import type { HistoryEvent } from "../../types";
import { formatTargetBadge, isRemoteTarget } from "../../utils/targetLabel";
import {
  historyEventSubjectId,
  historyEventSubjectName,
} from "../../types";
import {
  EditIcon,
  PlusIcon,
  RestoreIcon,
  RunIcon,
  TrashIcon,
} from "../icons";
import { ScheduledRunOutput } from "./ScheduledRunOutput";
import { SshHostChangeDetail } from "./SshHostChangeDetail";

/**
 * Color grouping for the action-icon column — drives the `--<group>` CSS
 * modifier (and thus the icon hue). Several `kind`s share a color
 * (create/edit/delete/run); `restore` is its own (blue) group.
 */
type ActionGroup = "create" | "edit" | "delete" | "run" | "restore";

function actionGroup(kind: HistoryEvent["kind"]): ActionGroup {
  switch (kind) {
    case "commandCreated":
    case "workflowCreated":
      return "create";
    case "commandEdited":
    case "workflowEdited":
    case "commandReverted":
      // An undone edit shares the edit (orange) hue; its glyph differs
      // (the restore arrow) and the aria-label reads "Undo edit".
      return "edit";
    case "commandDeleted":
    case "workflowDeleted":
      return "delete";
    case "commandRun":
    case "workflowRun":
    case "scheduledRun":
      return "run";
    case "commandRestored":
      return "restore";
    case "sshHostAdded":
    case "sshHostDiscovered":
      return "create";
    case "sshHostEdited":
    case "sshHostEditedExternally":
      return "edit";
    case "sshHostDeleted":
    case "sshHostDeletedExternally":
      return "delete";
  }
}

/**
 * Glyph for a history kind. Edits use the pencil; an undone edit
 * (`commandReverted`) and a restored deletion (`commandRestored`) use the
 * undo/restore arrow so they read as "return to a prior state".
 */
function ActionIcon({ kind }: { kind: HistoryEvent["kind"] }): ReactElement {
  switch (kind) {
    case "commandCreated":
    case "workflowCreated":
      return <PlusIcon />;
    case "commandEdited":
    case "workflowEdited":
      return <EditIcon />;
    case "commandReverted":
    case "commandRestored":
      return <RestoreIcon />;
    case "commandDeleted":
    case "workflowDeleted":
      return <TrashIcon />;
    case "commandRun":
    case "workflowRun":
    case "scheduledRun":
      return <RunIcon />;
    case "sshHostAdded":
    case "sshHostDiscovered":
      return <PlusIcon />;
    case "sshHostEdited":
    case "sshHostEditedExternally":
      return <EditIcon />;
    case "sshHostDeleted":
    case "sshHostDeletedExternally":
      return <TrashIcon />;
  }
}

interface HistoryRowProps {
  event: HistoryEvent;
  /** Whether this row is ticked for bulk deletion. */
  selected: boolean;
  /** Toggle this row's bulk-delete selection. */
  onToggleSelect: (eventId: string) => void;
}

/**
 * Format an ISO timestamp using the browser's locale-aware
 * `toLocaleString`. Returns the original string on a parse failure
 * — we never want the row to render "Invalid Date" because of a
 * malformed timestamp.
 */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

/** Kinds that carry an SSH snapshot we can inspect for `isPattern`. */
type SshEventKind =
  | "sshHostAdded"
  | "sshHostDiscovered"
  | "sshHostEdited"
  | "sshHostEditedExternally"
  | "sshHostDeleted"
  | "sshHostDeletedExternally";

function isSshEvent(
  event: HistoryEvent,
): event is Extract<HistoryEvent, { kind: SshEventKind }> {
  return event.kind.startsWith("sshHost");
}

/**
 * Whether an SSH history event concerns a wildcard/pattern block (a "rule")
 * rather than a concrete connection. Read from whichever snapshot the variant
 * carries (`snapshotAfter` for add/edit/discover, `snapshotBefore` for delete).
 */
function sshEventIsPattern(
  event: Extract<HistoryEvent, { kind: SshEventKind }>,
): boolean {
  switch (event.kind) {
    case "sshHostAdded":
    case "sshHostDiscovered":
      return event.snapshotAfter.isPattern;
    case "sshHostEdited":
    case "sshHostEditedExternally":
      return event.snapshotAfter.isPattern;
    case "sshHostDeleted":
    case "sshHostDeletedExternally":
      return event.snapshotBefore.isPattern;
  }
}

/**
 * Build the human-readable kind label used in the row title.
 * Translation keys live under `history.kinds.<kind>` and accept a
 * `{{name}}` interpolation. SSH events that concern a PATTERN use a `_pattern`
 * key variant so the sentence reads "rule" instead of "connection".
 */
function kindKey(event: HistoryEvent): string {
  if (isSshEvent(event) && sshEventIsPattern(event)) {
    return `history.kinds.${event.kind}_pattern`;
  }
  return `history.kinds.${event.kind}`;
}

export function HistoryRow({
  event,
  selected,
  onToggleSelect,
}: HistoryRowProps): ReactElement {
  const { t } = useTranslation();
  const undoEdit = useHistoryStore((s) => s.undoEdit);
  const restoreDeleted = useHistoryStore((s) => s.restoreDeleted);
  const undoSshEdit = useHistoryStore((s) => s.undoSshEdit);
  // Subscribe to *just* the existence boolean — using a selector that
  // returns a primitive prevents re-rendering when unrelated commands
  // change. The Zustand store re-runs the selector on every update;
  // identity-stable primitives short-circuit React reconciliation.
  const subjectId = historyEventSubjectId(event);
  const commandExists = useCommandStore((s) =>
    s.commands.some((c) => c.id === subjectId),
  );

  const showUndo = event.kind === "commandEdited" && commandExists;
  const showRestore = event.kind === "commandDeleted" && !commandExists;
  // SSH edits (in ProcMix or external) can be reverted by re-writing the
  // prior snapshot, but only when its source is writable (OpenSSH user config).
  const showSshUndo =
    (event.kind === "sshHostEdited" ||
      event.kind === "sshHostEditedExternally") &&
    event.snapshotBefore.source === "open-ssh-config";

  // Per-row run-status badge for `commandRun` events.
  let runStatusBadge: ReactElement | null = null;
  if (event.kind === "commandRun") {
    let statusText: string;
    switch (event.status) {
      case "running":
        statusText = t("history.runStatus.running");
        break;
      case "succeeded":
        statusText = t("history.runStatus.succeeded");
        break;
      case "failed":
        // A timeout is recorded with `status: "failed"` and `timedOut`.
        // The process was signal-killed so there is usually no exit code
        // — showing "Exit ?" (the old behaviour) was the confusing
        // symptom the user reported. Surface a dedicated label instead.
        statusText = event.timedOut
          ? t("history.runStatus.timedOut")
          : t("history.runStatus.failed", {
              code: event.exitCode ?? "?",
            });
        break;
      case "cancelled":
        statusText = t("history.runStatus.cancelled");
        break;
    }
    runStatusBadge = (
      <span
        className={`history-row__status history-row__status--${event.status}${
          event.timedOut ? " history-row__status--timedOut" : ""
        }`}
      >
        {statusText}
      </span>
    );
  } else if (event.kind === "scheduledRun") {
    // Scheduled fires carry a richer status set than the streaming
    // executor (success / error / missingVariable / skipped / cancelled).
    runStatusBadge = (
      <span
        className={`history-row__status history-row__status--scheduled-${event.status}`}
      >
        {t(`scheduler.status.${event.status}` as const)}
      </span>
    );
  }

  // Bulk-delete checkbox. Rendered as a direct child of the row's wrapper
  // (a sibling of any `<details>` summary) so a click toggles only the
  // selection, never the disclosure. `stopPropagation` guards the run-row
  // case where the surrounding `<summary>` would otherwise toggle on click.
  const selectBox = (
    <input
      type="checkbox"
      className="history-row__select"
      checked={selected}
      onChange={() => onToggleSelect(event.id)}
      onClick={(e) => e.stopPropagation()}
      aria-label={t("history.selectRow")}
    />
  );

  const icon = (
    <span
      className={`history-row__action-icon history-row__action-icon--${actionGroup(
        event.kind,
      )}`}
      aria-label={t(`history.kindLabels.${event.kind}` as const)}
      title={t(`history.kindLabels.${event.kind}` as const)}
    >
      <ActionIcon kind={event.kind} />
    </span>
  );
  const title = (
    <span className="history-row__title">
      {t(kindKey(event), { name: historyEventSubjectName(event) })}
    </span>
  );
  const meta = (
    <div className="history-row__meta">
      {event.kind === "commandRun" && isRemoteTarget(event.target) ? (
        <span className="target-badge">
          {formatTargetBadge(event.target, t)}
        </span>
      ) : null}
      {showUndo && (
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => void undoEdit(event.id)}
        >
          {t("history.undoBtn")}
        </button>
      )}
      {showRestore && (
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => void restoreDeleted(event.id)}
        >
          {t("history.restoreBtn")}
        </button>
      )}
      {showSshUndo && (
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => void undoSshEdit(event.id)}
        >
          {t("history.undoBtn")}
        </button>
      )}
      <time
        className="history-row__timestamp"
        dateTime={event.createdAt}
        title={event.createdAt}
      >
        {formatTimestamp(event.createdAt)}
      </time>
    </div>
  );

  // A run row is expandable when it has captured detail to show: the row
  // becomes the clickable summary of a `<details>` revealing the same console
  // block / result / "no output" note as the schedule view's История tab
  // (shared `ScheduledRunOutput`).
  //   - scheduledRun: always expandable (it renders a "no output" note when
  //     capture was disabled — preserving the existing behaviour).
  //   - commandRun / workflowRun: expandable ONLY when output was persisted, so
  //     older rows (recorded before output persistence) and runs that produced
  //     nothing stay plain, non-interactive rows with no empty expander.
  // Every non-run kind keeps the plain row.
  const runDetail =
    event.kind === "scheduledRun"
      ? { output: event.output, result: event.result }
      : (event.kind === "commandRun" || event.kind === "workflowRun") &&
          event.output !== undefined &&
          event.output.length > 0
        ? { output: event.output, result: event.result }
        : undefined;

  if (runDetail !== undefined) {
    return (
      <li className="history-row history-row--scheduled history-row--selectable">
        {selectBox}
        <details className="history-row__disclosure">
          <summary className="history-row__summary">
            <div className="history-row__main">
              {icon}
              {title}
              {runStatusBadge}
            </div>
            {meta}
          </summary>
          <ScheduledRunOutput
            output={runDetail.output}
            result={runDetail.result}
          />
        </details>
      </li>
    );
  }

  // SSH edit rows (ProcMix or external) are expandable, revealing the
  // `Field: old > new` change list (and the new block if the raw text changed).
  if (
    event.kind === "sshHostEdited" ||
    event.kind === "sshHostEditedExternally"
  ) {
    return (
      <li className="history-row history-row--scheduled history-row--selectable">
        {selectBox}
        <details className="history-row__disclosure">
          <summary className="history-row__summary">
            <div className="history-row__main">
              {icon}
              {title}
            </div>
            {meta}
          </summary>
          <SshHostChangeDetail
            before={event.snapshotBefore}
            after={event.snapshotAfter}
          />
        </details>
      </li>
    );
  }

  return (
    <li className="history-row history-row--selectable">
      {selectBox}
      <div className="history-row__main">
        {icon}
        {title}
        {runStatusBadge}
      </div>
      {meta}
    </li>
  );
}
