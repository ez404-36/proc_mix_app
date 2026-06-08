import type { ReactElement } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { Command, Workflow } from "../../types";
import { getCommandName } from "../../utils/commandLabels";
import { SelectionTree } from "../SelectionDialog/SelectionTree";

interface ExportDialogProps {
  commands: ReadonlyArray<Command>;
  workflows: ReadonlyArray<Workflow>;
  /** Called with the resolved subset to export. */
  onExport: (selection: { commands: Command[]; workflows: Workflow[] }) => void;
  onCancel: () => void;
}

/**
 * Customizable export dialog: a two-group checkbox tree (Commands /
 * Workflows). Selecting a workflow force-includes (and locks) every command
 * its nodes reference, so an exported file is always self-consistent.
 *
 * The selection mechanics live in the shared {@link SelectionTree} (also used
 * by the Import dialog); this wrapper only supplies the export-specific
 * labels and resolves command display names.
 */
export function ExportDialog({
  commands,
  workflows,
  onExport,
  onCancel,
}: ExportDialogProps): ReactElement {
  const { t } = useTranslation();

  return createPortal(
    <SelectionTree<Command, Workflow>
      title={t("exportDialog.title")}
      confirmLabel={t("exportDialog.exportBtn")}
      commands={commands}
      workflows={workflows}
      renderCommandLabel={(cmd) => getCommandName(cmd, t)}
      renderWorkflowLabel={(wf) => wf.name}
      formModifier="command-form--export"
      onConfirm={onExport}
      onCancel={onCancel}
    />,
    document.body,
  );
}
