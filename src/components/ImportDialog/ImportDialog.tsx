import { useMemo, useState } from "react";
import type { ReactElement } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { Command } from "../../types";
import type {
  ExportedCommand,
  ExportedMiniApp,
  ExportedWorkflow,
  ProcMixExport,
} from "../../utils/dataTransfer";
import { findImportDuplicates } from "../../utils/importDuplicates";
import {
  resolveImportSelection,
  type DuplicateChoice,
  type ImportSelection,
} from "../../utils/importSelection";
import { Dropdown } from "../Dropdown";
import { SelectionTree } from "../SelectionDialog/SelectionTree";
import type { SelectionResult } from "../SelectionDialog/SelectionTree";

interface ImportDialogProps {
  /** The validated envelope read from the file. */
  parsed: ProcMixExport;
  /** Existing library commands, used to flag possible duplicates. */
  existingCommands: ReadonlyArray<Command>;
  /** Called with the user's resolved selection when they confirm import. */
  onImport: (selection: ImportSelection) => void;
  onCancel: () => void;
}

const DEFAULT_DUPLICATE_CHOICE: DuplicateChoice = "rename";

function isDuplicateChoice(value: string): value is DuplicateChoice {
  return value === "rename" || value === "skip";
}

/**
 * Import dialog: mirrors the Export dialog's selectable tree but for the
 * objects in a chosen file. Selecting a workflow force-includes the commands
 * its nodes reference (shared {@link SelectionTree} logic). A checked command
 * that collides with the library shows a notice once the row is ticked:
 *   - same NAME → a "Keep with a new name" / "Skip" choice (importing never
 *     overwrites, so the existing command — and any workflow bound to it —
 *     is always preserved);
 *   - same SCRIPT but different name → an informational warning only; the
 *     command imports as a new copy regardless.
 *
 * The dialog is a pure selector: it resolves the chosen subset plus the
 * overwrite/skip resolution and hands an {@link ImportSelection} back. It
 * never touches the stores itself.
 */
export function ImportDialog({
  parsed,
  existingCommands,
  onImport,
  onCancel,
}: ImportDialogProps): ReactElement {
  const { t } = useTranslation();

  const duplicates = useMemo(
    () => findImportDuplicates(parsed.commands, existingCommands),
    [parsed.commands, existingCommands],
  );

  // Per-duplicate-command choice. Absent = the default (skip). Only commands
  // present in `duplicates` ever get an entry.
  const [choices, setChoices] = useState<Map<string, DuplicateChoice>>(
    () => new Map(),
  );

  const choiceFor = (id: string): DuplicateChoice =>
    choices.get(id) ?? DEFAULT_DUPLICATE_CHOICE;

  // Rename / Skip options for the name-duplicate dropdown. Stable per render
  // of `t` so the dropdown's option identity does not churn.
  const choiceOptions = useMemo(
    () => [
      { value: "rename", label: t("importDialog.choiceRename") },
      { value: "skip", label: t("importDialog.choiceSkip") },
    ],
    [t],
  );

  const setChoice = (id: string, choice: DuplicateChoice): void => {
    setChoices((prev) => {
      const next = new Map(prev);
      next.set(id, choice);
      return next;
    });
  };

  // Delegate the import POLICY (rename/skip + script-only handling) to the pure
  // `resolveImportSelection`. The dialog only gathers raw choices;
  // `forcedCommandIds` comes straight from the tree so the dependency graph is
  // never recomputed here.
  const handleImport = (
    selection: SelectionResult<
      ExportedCommand,
      ExportedWorkflow,
      ExportedMiniApp
    >,
  ): void => {
    onImport(
      resolveImportSelection({
        commands: selection.commands.map((c) => ({ id: c.id, name: c.name })),
        workflowIds: selection.workflows.map((w) => w.id),
        miniappIds: selection.miniapps.map((m) => m.id),
        forcedCommandIds: selection.forcedCommandIds,
        duplicates,
        choiceFor,
        existingNames: existingCommands.map((c) => c.name),
      }),
    );
  };

  const renderCommandExtra = (
    cmd: ExportedCommand,
    checked: boolean,
  ): ReactElement | null => {
    const match = duplicates.get(cmd.id);
    if (match === undefined || !checked) return null;

    // A script-only collision (different name) is just a warning — the command
    // always imports as a new copy, so no action is offered.
    if (match.kind === "script") {
      return (
        <span className="import-tree__dup">
          <span className="import-tree__dup-label">
            {t("importDialog.duplicateScript")}
          </span>
        </span>
      );
    }

    // A name collision: the user keeps it under a new name (default) or skips.
    const handleChange = (value: string): void => {
      if (isDuplicateChoice(value)) setChoice(cmd.id, value);
    };
    return (
      <span className="import-tree__dup">
        <span className="import-tree__dup-label">
          {t("importDialog.duplicateName")}
        </span>
        {/* The dropdown lives inside the row's <label>; a click on its trigger
            would also toggle the checkbox, so stop it bubbling to the label.
            The portal-rendered popup is outside the label and unaffected. */}
        <span
          className="import-tree__dup-choice"
          onClick={(e) => e.stopPropagation()}
        >
          <Dropdown
            value={choiceFor(cmd.id)}
            options={choiceOptions}
            onChange={handleChange}
            popupClassName="import-tree__dup-popup"
            ariaLabel={t("importDialog.duplicateChoiceLabel", {
              name: cmd.name,
            })}
          />
        </span>
      </span>
    );
  };

  return createPortal(
    <SelectionTree<ExportedCommand, ExportedWorkflow, ExportedMiniApp>
      title={t("importDialog.title")}
      confirmLabel={t("importDialog.importBtn")}
      commands={parsed.commands}
      workflows={parsed.workflows}
      // A v1 file has no `miniapps` key; an empty array still renders the
      // group with its empty-state line, which keeps the dialog's shape
      // stable across envelope versions.
      miniapps={parsed.miniapps ?? []}
      renderCommandLabel={(cmd) => cmd.name}
      renderWorkflowLabel={(wf) => wf.name}
      renderMiniAppLabel={(ma) => ma.name}
      renderCommandExtra={renderCommandExtra}
      formModifier="command-form--export command-form--import"
      onConfirm={handleImport}
      onCancel={onCancel}
    />,
    document.body,
  );
}
