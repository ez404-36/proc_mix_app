import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Message } from "@arco-design/web-react";
import { useAppVersion } from "../../hooks/useAppVersion";
import { useTheme } from "../../hooks/useTheme";
import { useCommandStore } from "../../stores/commandStore";
import { DEFAULT_TOGGLE_SHORTCUT, useUIStore } from "../../stores/uiStore";
import { useUpdateStore, type CheckResult } from "../../stores/updateStore";
import { useWorkflowStore } from "../../stores/workflowStore";
import type { Command, Theme, Workflow } from "../../types";
import {
  LANGUAGE_NATIVE_NAMES,
  SUPPORTED_LANGUAGES,
  type Language,
} from "../../i18n";
import { ExportDialog } from "../ExportDialog";
import { ImportDialog } from "../ImportDialog";
import { applyImport, type ImportSelection } from "../../services/dataImport";
import {
  clearAdminPassword,
  hasAdminPassword,
  setAdminPassword,
} from "../../utils/adminPassword";
import { promptForAdminPassword } from "../../utils/adminPasswordPrompt";
import {
  exportData,
  importData,
  InvalidImportError,
  type ProcMixExport,
} from "../../utils/dataTransfer";
import { getCachedPlatform } from "../../utils/platform";
import {
  ClearIcon,
  EditIcon,
  ExportIcon,
  ImportIcon,
} from "../icons";
import { ShortcutRow } from "./ShortcutRow";

type ThemeKey =
  | "settings.appearance.themeLight"
  | "settings.appearance.themeDark"
  | "settings.appearance.themeSystem";

/** Inline outcome plaque shown in the Import / Export section. */
interface DataStatus {
  kind: "success" | "error";
  message: string;
}

const THEME_OPTIONS: { value: Theme; labelKey: ThemeKey }[] = [
  { value: "light", labelKey: "settings.appearance.themeLight" },
  { value: "dark", labelKey: "settings.appearance.themeDark" },
  { value: "system", labelKey: "settings.appearance.themeSystem" },
];

export function Settings(): ReactElement {
  const { t } = useTranslation();
  const appVersion = useAppVersion();
  const { theme, setTheme } = useTheme();
  const toggleShortcut = useUIStore((s) => s.toggleShortcut);
  const setToggleShortcut = useUIStore((s) => s.setToggleShortcut);
  const language = useUIStore((s) => s.language);
  const setLanguage = useUIStore((s) => s.setLanguage);

  // --------------------------------------------------------------
  // Administrator-privileges section state.
  //
  // `adminPasswordStored` mirrors what the Rust keychain says about
  // the stored sudo password — we DON'T read the value, just whether
  // anything is there. The status is refreshed on mount and after
  // every set/clear so the buttons reflect reality without the user
  // having to reload.
  //
  // On Windows the whole section is informational because UAC handles
  // auth at OS level — there's nothing for us to store or clear.
  // --------------------------------------------------------------
  const platform = getCachedPlatform();
  const isWindows = platform === "windows";
  const [adminPasswordStored, setAdminPasswordStored] = useState<boolean>(false);

  const refreshAdminPasswordStatus = useCallback(async (): Promise<void> => {
    try {
      const value = await hasAdminPassword();
      setAdminPasswordStored(value);
    } catch {
      // Keychain unavailable — treat as "not stored" so the UI shows
      // the Set button. Attempting to set will surface the real
      // backend error via the Message.error toast below.
      setAdminPasswordStored(false);
    }
  }, []);

  useEffect(() => {
    void refreshAdminPasswordStatus();
  }, [refreshAdminPasswordStatus]);

  const handleSetAdminPassword = useCallback(async (): Promise<void> => {
    // The Settings "Set password" flow is explicitly about persisting,
    // so we ignore the prompt's `remember` flag here: whichever button
    // the user clicked, the entered value is saved to the OS keychain.
    // The triggerCommandRun flow is what differentiates between save
    // and one-shot — this entry point has no other reason to exist.
    const result = await promptForAdminPassword();
    if (result === null) return; // user cancelled — no toast
    try {
      await setAdminPassword(result.password);
      Message.success(
        t("settings.admin.setSuccess", {
          defaultValue: "Administrator password saved",
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Message.error(
        `${t("settings.admin.setError", {
          defaultValue: "Failed to save password",
        })}: ${msg}`,
      );
    }
    await refreshAdminPasswordStatus();
  }, [refreshAdminPasswordStatus, t]);

  const handleClearAdminPassword = useCallback(async (): Promise<void> => {
    try {
      await clearAdminPassword();
      Message.success(
        t("settings.admin.clearSuccess", {
          defaultValue: "Administrator password cleared",
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Message.error(
        `${t("settings.admin.clearError", {
          defaultValue: "Failed to clear password",
        })}: ${msg}`,
      );
    }
    await refreshAdminPasswordStatus();
  }, [refreshAdminPasswordStatus, t]);

  // --------------------------------------------------------------
  // Import / Export. Export opens a selection dialog (the user picks which
  // commands/workflows to include); the chosen subset is written via
  // `exportData`. Import reads + validates the file, then opens a second
  // selection dialog (`ImportDialog`) where the user picks the subset to
  // import and resolves any duplicates (overwrite / skip). The resolved
  // selection is handed to `applyImport`. The native file dialog lives in the
  // Rust `export_data` / `import_data` commands behind `dataTransfer.ts`.
  //
  // Outcomes surface as an inline plaque in the data section (green success /
  // red error) rather than a transient toast, so the result stays visible.
  // --------------------------------------------------------------
  // --------------------------------------------------------------
  // Update check (manual trigger from Settings).
  // --------------------------------------------------------------
  const checkForUpdate = useUpdateStore((s) => s.checkForUpdate);
  const openUpdateModal = useUpdateStore((s) => s.openModal);
  const updatePhase = useUpdateStore((s) => s.phase);
  const [updateCheckResult, setUpdateCheckResult] = useState<CheckResult | null>(null);

  const handleCheckForUpdate = useCallback(async (): Promise<void> => {
    setUpdateCheckResult(null);
    const result = await checkForUpdate();
    setUpdateCheckResult(result);
    if (result.status === "available") {
      openUpdateModal();
    }
  }, [checkForUpdate, openUpdateModal]);

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

  return (
    <div>
      <header className="view-header">
        <div>
          <h1 className="view-title">{t("settings.title")}</h1>
          <p className="view-subtitle">{t("settings.subtitle")}</p>
        </div>
      </header>

      <section className="view-section">
        <h2 className="view-section__title">
          {t("settings.appearance.title")}
        </h2>
        <div className="settings-group">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`theme-option${theme === opt.value ? " is-active" : ""}`}
              onClick={() => setTheme(opt.value)}
            >
              {t(opt.labelKey)}
            </button>
          ))}
        </div>

        <div className="settings-group settings-group--center settings-group--spaced-top">
          <span className="settings-inline-label">
            {t("settings.appearance.languageLabel")}:
          </span>
          {SUPPORTED_LANGUAGES.map((lang: Language) => (
            <button
              key={lang}
              type="button"
              className={`theme-option${language === lang ? " is-active" : ""}`}
              onClick={() => setLanguage(lang)}
            >
              {LANGUAGE_NATIVE_NAMES[lang]}
            </button>
          ))}
        </div>
      </section>

      <section className="view-section">
        <h2 className="view-section__title">{t("settings.shortcuts.title")}</h2>
        <div className="shortcut-list">
          <ShortcutRow
            label={t("settings.shortcuts.toggleLabel")}
            description={t("settings.shortcuts.toggleDescription")}
            accelerator={toggleShortcut}
            defaultAccelerator={DEFAULT_TOGGLE_SHORTCUT}
            onChange={setToggleShortcut}
          />
          <div className="shortcut-list__hint">
            {t("settings.shortcuts.paletteHintPrefix")}{" "}
            <span className="kbd">Ctrl/Cmd</span>
            <span className="shortcut-list__plus">+</span>
            <span className="kbd">K</span>{" "}
            {t("settings.shortcuts.paletteHintSuffix")}
          </div>
        </div>
      </section>

      <section className="view-section">
        <h2 className="view-section__title">{t("settings.tray.title")}</h2>
        <div className="empty-state settings-info">
          <div className="settings-info__line">{t("settings.tray.primary")}</div>
          <div className="settings-caption">
            {t("settings.tray.secondary")}
          </div>
        </div>
      </section>

      <section className="view-section">
        <h2 className="view-section__title">
          {t("settings.admin.title", {
            defaultValue: "Administrator privileges",
          })}
        </h2>
        {isWindows ? (
          /*
           * Windows path: UAC handles elevation at the OS level. No
           * password is stored or queried by our app — surfacing
           * Set/Clear buttons would be misleading.
           */
          <div className="empty-state settings-info">
            <div className="settings-info__body">
              {t("settings.admin.windowsHint", {
                defaultValue:
                  "Not used on Windows — UAC handles elevation when a command is marked Run as administrator.",
              })}
            </div>
          </div>
        ) : (
          <div className="empty-state settings-info">
            <div className="settings-info__lead">
              {adminPasswordStored
                ? t("settings.admin.statusSaved", {
                    defaultValue:
                      "Sudo password is saved in your OS keychain.",
                  })
                : t("settings.admin.statusEmpty", {
                    defaultValue: "No sudo password is saved yet.",
                  })}
            </div>
            <div className="settings-group settings-group--tight">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void handleSetAdminPassword()}
              >
                <EditIcon />
                {adminPasswordStored
                  ? t("settings.admin.changeBtn", {
                      defaultValue: "Change password…",
                    })
                  : t("settings.admin.setBtn", {
                      defaultValue: "Set password…",
                    })}
              </button>
              {adminPasswordStored ? (
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={() => void handleClearAdminPassword()}
                >
                  <ClearIcon />
                  {t("settings.admin.clearBtn", {
                    defaultValue: "Clear saved password",
                  })}
                </button>
              ) : null}
            </div>
            <div className="settings-caption settings-caption--spaced">
              {t("settings.admin.subhint", {
                defaultValue:
                  "Stored securely in your OS keychain. Never written to disk by ProcMix.",
              })}
            </div>
          </div>
        )}
      </section>

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
              onClick={() => setExportDialogOpen(true)}
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
      </section>

      <section className="view-section">
        <h2 className="view-section__title">
          {t("settings.updates.title")}
        </h2>
        <div className="empty-state settings-info">
          <div className="settings-group settings-group--tight">
            <button
              type="button"
              className="btn btn--primary"
              disabled={updatePhase !== "idle"}
              onClick={() => void handleCheckForUpdate()}
            >
              {updatePhase === "checking"
                ? t("settings.updates.checking")
                : t("settings.updates.checkBtn")}
            </button>
          </div>
          {updateCheckResult?.status === "up-to-date" && (
            <div className="data-status data-status--success" role="status">
              {t("settings.updates.upToDate")}
            </div>
          )}
          {updateCheckResult?.status === "error" && (
            <div className="data-status data-status--error" role="status">
              {t("settings.updates.checkError")}: {updateCheckResult.message}
            </div>
          )}
        </div>
      </section>

      <section className="view-section">
        <h2 className="view-section__title">{t("settings.about.title")}</h2>
        <div className="empty-state settings-info">
          <div className="settings-info__line">
            <strong>{t("common.appName")}</strong>{" "}
            {appVersion ? `v${appVersion}` : "—"}
          </div>
          <div className="settings-info__lead">
            {t("settings.about.description")}
          </div>
          <div className="settings-caption">
            {t("settings.about.license")}
          </div>
          <div className="settings-caption">
            {t("settings.about.copyright")}
          </div>
        </div>
      </section>

      {exportDialogOpen ? (
        <ExportDialog
          commands={exportCommands}
          workflows={exportWorkflows}
          onExport={(selection) => void handleExportConfirm(selection)}
          onCancel={() => setExportDialogOpen(false)}
        />
      ) : null}

      {importParsed !== null ? (
        <ImportDialog
          parsed={importParsed}
          existingCommands={exportCommands}
          onImport={handleImportConfirm}
          onCancel={() => setImportParsed(null)}
        />
      ) : null}
    </div>
  );
}
