import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  computeForcedCommandIds,
  isCommandLocked,
  resolveExportSelection,
  selectExportRecords,
  toggleInSet,
  type SelectableCommand,
  type SelectableWorkflow,
} from "../../utils/exportSelection";
import { SelectionGroup } from "./SelectionGroup";

/** The resolved subset the consumer receives on confirm. */
export interface SelectionResult<
  C extends SelectableCommand,
  W extends SelectableWorkflow,
> {
  commands: C[];
  workflows: W[];
  /**
   * Command ids that were force-included by a selected workflow (a subset of
   * `commands`' ids). Exposed so a consumer (e.g. the import dialog) can apply
   * policy to forced commands without recomputing the dependency graph.
   */
  forcedCommandIds: Set<string>;
}

interface SelectionTreeProps<
  C extends SelectableCommand,
  W extends SelectableWorkflow,
> {
  /** Localized dialog title + accessible label. */
  title: string;
  /** Label of the confirm (primary) button. */
  confirmLabel: string;
  /** Disable the confirm button beyond the "nothing selected" rule. */
  confirmDisabled?: boolean;
  commands: ReadonlyArray<C>;
  workflows: ReadonlyArray<W>;
  /** Render the visible name of a command row. */
  renderCommandLabel: (cmd: C) => ReactNode;
  /** Render the visible name of a workflow row. */
  renderWorkflowLabel: (wf: W) => ReactNode;
  /**
   * Optional extra content rendered after a command's label — used by the
   * import dialog to flag possible duplicates. Receives whether the row is
   * currently checked so the hint only shows for selected items.
   */
  renderCommandExtra?: (cmd: C, checked: boolean) => ReactNode;
  /** Extra modifier appended to `.command-form` (e.g. `command-form--export`). */
  formModifier: string;
  /** Called with the resolved subset when the user confirms. */
  onConfirm: (selection: SelectionResult<C, W>) => void;
  onCancel: () => void;
}

/**
 * Shared two-group checkbox tree (Commands / Workflows) backing both the
 * Export and Import dialogs. Selecting a workflow force-includes (and locks)
 * every command its nodes reference, so the chosen subset is always
 * self-consistent — a workflow can never be selected without the commands
 * its nodes run.
 *
 * Mirrors `ConfirmDialog` modal mechanics: portal to `document.body`,
 * backdrop click + Esc cancel, focus management. The tree is a pure selector
 * — it resolves the chosen subset and hands it back; it never touches the
 * filesystem or the stores itself.
 */
export function SelectionTree<
  C extends SelectableCommand,
  W extends SelectableWorkflow,
>({
  title,
  confirmLabel,
  confirmDisabled = false,
  commands,
  workflows,
  renderCommandLabel,
  renderWorkflowLabel,
  renderCommandExtra,
  formModifier,
  onConfirm,
  onCancel,
}: SelectionTreeProps<C, W>): ReactElement {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Explicit user ticks, kept distinct from the forced set (derived below).
  const [checkedCommandIds, setCheckedCommandIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [checkedWorkflowIds, setCheckedWorkflowIds] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const forcedCommandIds = useMemo(
    () => computeForcedCommandIds(checkedWorkflowIds, workflows),
    [checkedWorkflowIds, workflows],
  );

  // Final per-command checked state = explicitly checked OR forced.
  const isCommandChecked = (id: string): boolean =>
    checkedCommandIds.has(id) || forcedCommandIds.has(id);

  const resolved = useMemo(
    () =>
      resolveExportSelection({
        checkedCommandIds,
        checkedWorkflowIds,
        workflows,
      }),
    [checkedCommandIds, checkedWorkflowIds, workflows],
  );

  const selectedCommandCount = resolved.commandIds.size;
  const selectedWorkflowCount = resolved.workflowIds.size;
  const nothingSelected =
    selectedCommandCount === 0 && selectedWorkflowCount === 0;

  const toggleCommand = (id: string): void => {
    // Forced commands are locked — their toggle is disabled, so this only
    // ever fires for non-forced ones, but guard anyway.
    if (isCommandLocked(id, forcedCommandIds)) return;
    setCheckedCommandIds((prev) => toggleInSet(prev, id));
  };

  const toggleWorkflow = (id: string): void => {
    setCheckedWorkflowIds((prev) => toggleInSet(prev, id));
  };

  const toggleAllCommands = (): void => {
    // Toggling the group only affects EXPLICIT checks. Forced commands stay
    // included regardless (a selected workflow still needs them).
    const allChecked = commands.every((c) => isCommandChecked(c.id));
    setCheckedCommandIds(
      allChecked ? new Set() : new Set(commands.map((c) => c.id)),
    );
  };

  const toggleAllWorkflows = (): void => {
    const allChecked = workflows.every((w) => checkedWorkflowIds.has(w.id));
    setCheckedWorkflowIds(
      allChecked ? new Set() : new Set(workflows.map((w) => w.id)),
    );
  };

  const handleConfirm = (): void => {
    if (nothingSelected || confirmDisabled) return;
    onConfirm({
      ...selectExportRecords(resolved, commands, workflows),
      forcedCommandIds,
    });
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) onCancel();
  };

  return (
    <div className="command-form__backdrop" onClick={handleBackdropClick}>
      <div
        className={`command-form ${formModifier}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <h2 className="command-form__title">{title}</h2>

        <div className="export-tree">
          <SelectionGroup<C>
            label={t("selectionDialog.commandsGroup")}
            emptyLabel={t("selectionDialog.noCommands")}
            items={commands}
            getId={(c) => c.id}
            isChecked={(c) => isCommandChecked(c.id)}
            isLocked={(c) => isCommandLocked(c.id, forcedCommandIds)}
            renderLabel={renderCommandLabel}
            renderExtra={renderCommandExtra}
            lockedHint={t("selectionDialog.requiredByWorkflow")}
            onToggleItem={toggleCommand}
            onToggleAll={toggleAllCommands}
          />

          <SelectionGroup<W>
            label={t("selectionDialog.workflowsGroup")}
            emptyLabel={t("selectionDialog.noWorkflows")}
            items={workflows}
            getId={(w) => w.id}
            isChecked={(w) => checkedWorkflowIds.has(w.id)}
            renderLabel={renderWorkflowLabel}
            onToggleItem={toggleWorkflow}
            onToggleAll={toggleAllWorkflows}
          />
        </div>

        <p className="export-tree__count">
          {t("selectionDialog.selectionCount", {
            commands: selectedCommandCount,
            workflows: selectedWorkflowCount,
          })}
        </p>

        <div className="command-form__actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn btn--ghost"
            onClick={onCancel}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={nothingSelected || confirmDisabled}
            onClick={handleConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
