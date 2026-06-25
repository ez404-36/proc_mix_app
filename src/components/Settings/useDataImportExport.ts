import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCommandStore } from "../../stores/commandStore";
import { useWorkflowStore } from "../../stores/workflowStore";
import type { Command, Workflow } from "../../types";
import { applyImport, type ImportSelection } from "../../services/dataImport";
import {
  exportData,
  importData,
  InvalidImportError,
  type ProcMixExport,
} from "../../utils/dataTransfer";

/** Inline outcome plaque shown in the Import / Export section. */
interface DataStatus {
  kind: "success" | "error";
  message: string;
}

interface DataImportExport {
  exportDialogOpen: boolean;
  openExportDialog: () => void;
  closeExportDialog: () => void;
  importParsed: ProcMixExport | null;
  closeImportDialog: () => void;
  dataStatus: DataStatus | null;
  exportCommands: Command[];
  exportWorkflows: Workflow[];
  handleExportConfirm: (selection: {
    commands: Command[];
    workflows: Workflow[];
  }) => Promise<void>;
  handleImportOpen: () => Promise<void>;
  handleImportConfirm: (selection: ImportSelection) => void;
}

/**
 * Owns the Import / Export section state and actions.
 *
 * Export opens a selection dialog (the user picks which commands/workflows to
 * include); the chosen subset is written via `exportData`. Import reads +
 * validates the file, then opens a second selection dialog (`ImportDialog`)
 * where the user picks the subset to import and resolves any duplicates
 * (overwrite / skip). The resolved selection is handed to `applyImport`. The
 * native file dialog lives in the Rust `export_data` / `import_data` commands
 * behind `dataTransfer.ts`.
 *
 * Outcomes surface as an inline plaque in the data section (green success /
 * red error) rather than a transient toast, so the result stays visible.
 */
export function useDataImportExport(): DataImportExport {
  const { t } = useTranslation();
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [importParsed, setImportParsed] = useState<ProcMixExport | null>(null);
  const [dataStatus, setDataStatus] = useState<DataStatus | null>(null);
  const exportCommands = useCommandStore((s) => s.commands);
  const exportWorkflows = useWorkflowStore((s) => s.workflows);

  const handleExportConfirm = useCallback(
    async (selection: {
      commands: Command[];
      workflows: Workflow[];
    }): Promise<void> => {
      setExportDialogOpen(false);
      try {
        const saved = await exportData(selection.commands, selection.workflows);
        // `false` = user cancelled the native save dialog → stay silent.
        if (saved) {
          setDataStatus({
            kind: "success",
            message: t("settings.data.exportSuccess", {
              commands: selection.commands.length,
              workflows: selection.workflows.length,
            }),
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setDataStatus({
          kind: "error",
          message: `${t("settings.data.exportError")}: ${msg}`,
        });
      }
    },
    [t],
  );

  // Step 1: read + validate the file, then open the ImportDialog. A parse /
  // validation failure surfaces an error plaque; a cancelled dialog is silent.
  const handleImportOpen = useCallback(async (): Promise<void> => {
    setDataStatus(null);
    try {
      const parsed = await importData();
      // `null` = user cancelled the native open dialog → stay silent.
      if (parsed === null) return;
      setImportParsed(parsed);
    } catch (err) {
      // A malformed/invalid file surfaces a clear, localized message; any
      // other failure (e.g. the IPC read) falls back to its raw message.
      const msg =
        err instanceof InvalidImportError
          ? t("settings.data.importInvalid")
          : err instanceof Error
            ? err.message
            : String(err);
      setDataStatus({
        kind: "error",
        message: `${t("settings.data.importError")}: ${msg}`,
      });
    }
  }, [t]);

  // Step 2: apply the user's resolved selection and report the outcome.
  const handleImportConfirm = useCallback(
    (selection: ImportSelection): void => {
      const parsed = importParsed;
      setImportParsed(null);
      if (parsed === null) return;
      try {
        const result = applyImport(parsed, selection);
        const parts: string[] = [
          t("settings.data.importSuccess", {
            commands: result.commands,
            workflows: result.workflows,
          }),
        ];
        if (result.renamed > 0) {
          parts.push(
            t("settings.data.importRenamed", {
              count: result.renamed,
            }),
          );
        }
        // M2: import is untrusted, so any `runAsAdmin` flag in the file was
        // turned off. Tell the user how many commands were demoted so the
        // safety change is never silent — they re-enable it after review.
        if (result.demotedAdmin > 0) {
          parts.push(
            t("settings.data.importAdminDemoted", {
              count: result.demotedAdmin,
            }),
          );
        }
        // Slug collisions were cleared so the import couldn't fail on the
        // backend's unique-slug index. Tell the user so the change isn't silent.
        if (result.clearedApiSlugs > 0) {
          parts.push(
            t("settings.data.importSlugsCleared", {
              count: result.clearedApiSlugs,
            }),
          );
        }
        setDataStatus({ kind: "success", message: parts.join(" ") });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setDataStatus({
          kind: "error",
          message: `${t("settings.data.importError")}: ${msg}`,
        });
      }
    },
    [importParsed, t],
  );

  return {
    exportDialogOpen,
    openExportDialog: () => setExportDialogOpen(true),
    closeExportDialog: () => setExportDialogOpen(false),
    importParsed,
    closeImportDialog: () => setImportParsed(null),
    dataStatus,
    exportCommands,
    exportWorkflows,
    handleExportConfirm,
    handleImportOpen,
    handleImportConfirm,
  };
}
