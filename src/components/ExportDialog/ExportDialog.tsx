import type { ReactElement } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { Command, MiniApp, Workflow } from "../../types";
import { getCommandName } from "../../utils/commandLabels";
import { SelectionTree } from "../SelectionDialog/SelectionTree";

interface ExportDialogProps {
  commands: ReadonlyArray<Command>;
  workflows: ReadonlyArray<Workflow>;
  miniapps: ReadonlyArray<MiniApp>;
  /** Called with the resolved subset to export. */
  onExport: (selection: {
    commands: Command[];
    workflows: Workflow[];
    miniapps: MiniApp[];
  }) => void;
  onCancel: () => void;
}

/**
 * Customizable export dialog: a three-group checkbox tree (Commands /
 * Workflows / Mini-apps). Selecting a workflow or a mini-app force-includes
 * (and locks) every command it references, so an exported file is always
 * self-consistent.
 *
 * The selection mechanics live in the shared {@link SelectionTree} (also used
 * by the Import dialog); this wrapper only supplies the export-specific
 * labels and resolves command display names.
 *
 * The footnote states that `secret`-variant artifact values are never written
 * to the file (see `toExportedMiniApp` in `utils/dataTransfer`), so a user
 * sharing a mini-app knows the recipient must re-enter them.
 */
export function ExportDialog({
  commands,
  workflows,
  miniapps,
  onExport,
  onCancel,
}: ExportDialogProps): ReactElement {
  const { t } = useTranslation();

  return createPortal(
    <SelectionTree<Command, Workflow, MiniApp>
      title={t("exportDialog.title")}
      confirmLabel={t("exportDialog.exportBtn")}
      commands={commands}
      workflows={workflows}
      miniapps={miniapps}
      renderCommandLabel={(cmd) => getCommandName(cmd, t)}
      renderWorkflowLabel={(wf) => wf.name}
      renderMiniAppLabel={(ma) => ma.name}
      footnote={t("exportDialog.secretsOmitted")}
      formModifier="command-form--export"
      onConfirm={onExport}
      onCancel={onCancel}
    />,
    document.body,
  );
}
