import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCommandStore } from "../../stores/commandStore";
import { useMiniAppStore } from "../../stores/miniappStore";
import { useWorkflowStore } from "../../stores/workflowStore";
import type { Command, MiniApp, Workflow } from "../../types";
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

/**
 * Whether any of the mini-apps about to be exported carries a `secret`-variant
 * artifact whose value would have been written to the file. `toExportedMiniApp`
 * blanks those values unconditionally; this only decides whether the success
 * plaque needs to MENTION it, so the note appears exactly when it is relevant.
 */
function hasSecretArtifact(miniapps: ReadonlyArray<MiniApp>): boolean {
  return miniapps.some((ma) =>
    ma.widgets.some(
      (w) => w.kind === "artifact" && w.variant === "secret" && w.value !== "",
    ),
  );
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
  /**
   * Every mini-app in the store, offered as a third selectable group in the
   * Export dialog. Only the user's chosen subset is written to the file —
   * exporting one command must never ship every mini-app the user owns.
   */
  exportMiniApps: MiniApp[];
  handleExportConfirm: (selection: {
    commands: Command[];
    workflows: Workflow[];
    miniapps: MiniApp[];
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
  const exportMiniApps = useMiniAppStore((s) => s.miniapps);

  const handleExportConfirm = useCallback(
    async (selection: {
      commands: Command[];
      workflows: Workflow[];
      miniapps: MiniApp[];
    }): Promise<void> => {
      setExportDialogOpen(false);
      try {
        // Only the SELECTED mini-apps are written — never the whole store.
        const saved = await exportData(
          selection.commands,
          selection.workflows,
          selection.miniapps,
        );
        // `false` = user cancelled the native save dialog → stay silent.
        if (saved) {
          const parts: string[] = [
            t("settings.data.exportSuccess", {
              commands: selection.commands.length,
              workflows: selection.workflows.length,
              miniapps: selection.miniapps.length,
            }),
          ];
          // Secret artifact values are blanked by `toExportedMiniApp`; say so
          // when at least one exported mini-app actually carried one, so the
          // recipient knows they must re-enter it.
          if (hasSecretArtifact(selection.miniapps)) {
            parts.push(t("settings.data.exportSecretsOmitted"));
          }
          setDataStatus({ kind: "success", message: parts.join(" ") });
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
            miniapps: result.miniapps,
          }),
        ];
        // A malformed mini-app is dropped rather than aborting the import
        // (commands/workflows are already written by then). Report the loss so
        // the user knows the file was not fully applied.
        if (result.miniappsFailed > 0) {
          parts.push(
            t("settings.data.importMiniAppsFailed", {
              count: result.miniappsFailed,
            }),
          );
        }
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
    exportMiniApps,
    handleExportConfirm,
    handleImportOpen,
    handleImportConfirm,
  };
}
