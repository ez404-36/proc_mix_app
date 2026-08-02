import { type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ExportDialog } from "../ExportDialog";
import { ImportDialog } from "../ImportDialog";
import { ExportIcon, ImportIcon } from "../icons";
import { useDataImportExport } from "./useDataImportExport";

export function DataSection(): ReactElement {
  const { t } = useTranslation();
  const {
    exportDialogOpen,
    openExportDialog,
    closeExportDialog,
    importParsed,
    closeImportDialog,
    dataStatus,
    exportCommands,
    exportWorkflows,
    exportMiniApps,
    handleExportConfirm,
    handleImportOpen,
    handleImportConfirm,
  } = useDataImportExport();

  return (
    <section className="view-section">
      <h2 className="view-section__title">{t("settings.data.title")}</h2>
      <div className="empty-state settings-info">
        <div className="settings-info__lead">
          {t("settings.data.description")}
        </div>
        <div className="settings-group settings-group--tight">
          <button
            type="button"
            className="btn btn--primary"
            onClick={openExportDialog}
          >
            <ExportIcon />
            {t("settings.data.exportBtn")}
          </button>
          <button
            type="button"
            className="btn btn--run"
            onClick={() => void handleImportOpen()}
          >
            <ImportIcon />
            {t("settings.data.importBtn")}
          </button>
        </div>
        {dataStatus !== null ? (
          <div
            className={`data-status data-status--${dataStatus.kind}`}
            role="status"
          >
            {dataStatus.message}
          </div>
        ) : null}
        <div className="settings-caption settings-caption--spaced">
          {t("settings.data.subhint")}
        </div>
      </div>

      {exportDialogOpen ? (
        <ExportDialog
          commands={exportCommands}
          workflows={exportWorkflows}
          miniapps={exportMiniApps}
          onExport={(selection) => void handleExportConfirm(selection)}
          onCancel={closeExportDialog}
        />
      ) : null}

      {importParsed !== null ? (
        <ImportDialog
          parsed={importParsed}
          existingCommands={exportCommands}
          onImport={handleImportConfirm}
          onCancel={closeImportDialog}
        />
      ) : null}
    </section>
  );
}
