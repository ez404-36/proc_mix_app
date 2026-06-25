import type { ReactElement } from "react";
import type { TFunction } from "i18next";

import type { ExecutionTarget } from "../../types";
import { isOverridingSystem, isValidEnvVarName } from "../../utils/envVars";
import { Dropdown } from "../Dropdown";
import type { DropdownOption } from "../Dropdown";
import { ToggleSwitch } from "../ToggleSwitch";
import { TrashIcon } from "../icons";
import { TargetSelector } from "./TargetSelector";
import type { EnvRow, FormState, FormTab } from "./formState";

export interface EnvTabProps {
  t: TFunction;
  active: boolean;
  form: FormState;
  // Where-to-run.
  onTargetChange: (target: ExecutionTarget) => void;
  onPromptSshPasswordChange: (value: boolean) => void;
  // Shell.
  shellOptions: ReadonlyArray<DropdownOption>;
  showNoShellsWarning: boolean;
  onShellChange: (next: string) => void;
  // Working directory.
  onWorkingDirChange: (value: string) => void;
  onPromptWorkingDirChange: (value: boolean) => void;
  // Env rows.
  systemVars: Record<string, string>;
  onEnvRowAdd: () => void;
  onEnvRowRemove: (index: number) => void;
  updateEnvRow: (index: number, patch: Partial<EnvRow>) => void;
}

/**
 * The command form's Env tab: where-to-run selector, shell, working
 * directory, and per-command environment variable overrides.
 * Presentational — state and handlers come from the parent CommandForm.
 */
export function EnvTab(props: EnvTabProps): ReactElement {
  const {
    t,
    active,
    form,
    onTargetChange,
    onPromptSshPasswordChange,
    shellOptions,
    showNoShellsWarning,
    onShellChange,
    onWorkingDirChange,
    onPromptWorkingDirChange,
    systemVars,
    onEnvRowAdd,
    onEnvRowRemove,
    updateEnvRow,
  } = props;

  const tab: FormTab = "env";
  return (
    <div
      role="tabpanel"
      id={`command-form-panel-${tab}`}
      aria-labelledby={`command-form-tab-${tab}`}
      hidden={!active}
      className="command-form__panel"
    >
      {/*
       * Where-to-run selector (Local / Remote host / Ask at run time).
       * Sourced from the shared SSH host store so the offered hosts match
       * Environment → Connections exactly. Remote runs disable elevation
       * (handled on the admin checkbox below).
       */}
      <TargetSelector
        value={form.target}
        onChange={onTargetChange}
        promptSshPassword={form.promptSshPassword}
        onPromptSshPasswordChange={onPromptSshPasswordChange}
      />

      <div className="command-form__field">
        <span className="command-form__label">
          {t("commandForm.fields.shell")}
        </span>
        <Dropdown
          value={form.shell}
          options={shellOptions}
          onChange={onShellChange}
          ariaLabel={t("commandForm.fields.shell")}
        />
        {showNoShellsWarning ? (
          <span className="command-form__warning" role="note">
            {t("commandForm.warnings.noShellsDetected")}
          </span>
        ) : null}
      </div>

      <div className="command-form__field">
        <span className="command-form__label">
          {t("commandForm.fields.workingDir")}
        </span>
        <input
          type="text"
          className="input command-form__working-dir-input"
          value={form.workingDir}
          onChange={(e) => onWorkingDirChange(e.target.value)}
          placeholder={t("commandForm.placeholders.workingDir")}
          aria-label={t("commandForm.fields.workingDir")}
        />
        <div className="command-form__field command-form__field--inline">
          <ToggleSwitch
            checked={form.promptWorkingDir}
            onChange={onPromptWorkingDirChange}
            ariaLabel={t("commandForm.fields.promptWorkingDir")}
          />
          <span>{t("commandForm.fields.promptWorkingDir")}</span>
        </div>
      </div>

      <div className="command-form__field">
        <span className="command-form__label">
          {t("commandForm.env.title", {
            defaultValue: "Environment variables",
          })}
        </span>
        <span className="command-form__hint" role="note">
          {t("commandForm.env.hint", {
            defaultValue:
              "These KEY=VALUE pairs are injected into the command's environment at run time, overriding any inherited system variables with the same key.",
          })}
        </span>
      </div>
      {form.envRows.length > 0 ? (
        <ul className="command-form__env-list">
          {form.envRows.map((row, index) => {
            const overridesSystem = isOverridingSystem(row.key, systemVars);
            const invalidKey =
              row.key.trim() !== "" && !isValidEnvVarName(row.key.trim());
            return (
              <li key={row.rowId} className="command-form__env-row">
                <div className="command-form__env-row-controls">
                  <input
                    type="text"
                    className={
                      invalidKey
                        ? "input command-form__env-key input--error"
                        : overridesSystem
                          ? "input command-form__env-key input--warning"
                          : "input command-form__env-key"
                    }
                    value={row.key}
                    onChange={(e) =>
                      updateEnvRow(index, { key: e.target.value })
                    }
                    placeholder={t("commandForm.env.keyPlaceholder", {
                      defaultValue: "KEY",
                    })}
                    aria-label={t("commandForm.env.keyLabel", {
                      defaultValue: "Key",
                    })}
                    aria-invalid={invalidKey || overridesSystem}
                    title={
                      invalidKey
                        ? t("commandForm.env.invalidKey", {
                            defaultValue:
                              "Invalid name. Use letters, digits and underscore; must not start with a digit.",
                          })
                        : undefined
                    }
                    spellCheck={false}
                  />
                  <input
                    type="text"
                    className="input command-form__env-value"
                    value={row.value}
                    onChange={(e) =>
                      updateEnvRow(index, { value: e.target.value })
                    }
                    placeholder={t("commandForm.env.valuePlaceholder", {
                      defaultValue: "Value",
                    })}
                    aria-label={t("commandForm.env.valueLabel", {
                      defaultValue: "Value",
                    })}
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon command-form__env-remove"
                    onClick={() => onEnvRowRemove(index)}
                    aria-label={t("commandForm.env.removeRow", {
                      defaultValue: "Remove",
                    })}
                    title={t("commandForm.env.removeRow", {
                      defaultValue: "Remove",
                    })}
                  >
                    <TrashIcon />
                  </button>
                </div>
                {overridesSystem && (
                  <p className="command-form__env-override-hint">
                    {t("commandForm.env.overridesSystemValue", {
                      defaultValue:
                        "Overrides system variable. Current value: {{value}}",
                      value: systemVars[row.key.trim()] ?? "",
                    })}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="command-form__env-empty">
          {t("commandForm.env.empty", {
            defaultValue: "No environment variables set for this command.",
          })}
        </p>
      )}
      <button type="button" className="btn btn--ghost" onClick={onEnvRowAdd}>
        {t("commandForm.env.addRow", { defaultValue: "Add variable" })}
      </button>
    </div>
  );
}
