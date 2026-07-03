import { useMemo } from "react";
import type { ReactElement } from "react";
import type { TFunction } from "i18next";

import { Dropdown } from "../Dropdown";
import type { DropdownOption } from "../Dropdown";
import { ToggleSwitch } from "../ToggleSwitch";
import type { FormState, FormTab } from "./formState";

/** Sentinel value for the "don't substitute into a variable" dropdown option. */
const NO_VARIABLE = "";

export interface ExplorerTabProps {
  t: TFunction;
  active: boolean;
  form: FormState;
  onExplorerEnabledChange: (next: boolean) => void;
  onExplorerPathVariableChange: (next: string) => void;
}

/**
 * The command form's Explorer tab: opt this command into the OS file-manager
 * ("Explorer") context menu — INDEPENDENT of the favorite flag — and optionally
 * bind the right-clicked path to one of the command's variables. Presentational:
 * the parent CommandForm owns state and handlers.
 */
export function ExplorerTab(props: ExplorerTabProps): ReactElement {
  const {
    t,
    active,
    form,
    onExplorerEnabledChange,
    onExplorerPathVariableChange,
  } = props;

  const tab: FormTab = "explorer";

  // Build the variable selector from the command's own named variables. The
  // first option is "don't substitute". A stored value that no longer matches a
  // current variable name is kept visible (disabled) so the user is aware of it.
  const variableOptions = useMemo<ReadonlyArray<DropdownOption>>(() => {
    const names = form.variables
      .map((v) => v.name.trim())
      .filter((n) => n !== "");
    const unique = Array.from(new Set(names));
    const options: DropdownOption[] = [
      {
        value: NO_VARIABLE,
        label: t("commandForm.explorer.noVariable", {
          defaultValue: "— don't substitute —",
        }),
      },
      ...unique.map((name) => ({ value: name, label: name })),
    ];
    const selected = form.explorerPathVariable.trim();
    if (selected !== "" && !unique.includes(selected)) {
      options.push({
        value: selected,
        label: t("commandForm.explorer.missingVariable", {
          defaultValue: "{{name}} (removed)",
          name: selected,
        }),
        disabled: true,
      });
    }
    return options;
  }, [form.variables, form.explorerPathVariable, t]);

  const hasVariables = form.variables.some((v) => v.name.trim() !== "");

  return (
    <div
      role="tabpanel"
      id={`command-form-panel-${tab}`}
      aria-labelledby={`command-form-tab-${tab}`}
      hidden={!active}
      className="command-form__panel"
    >
      {/* --- Opt-in: show this command in the file-manager context menu --- */}
      <div className="command-form__field command-form__field--inline">
        <ToggleSwitch
          checked={form.explorerEnabled}
          onChange={onExplorerEnabledChange}
          ariaLabel={t("commandForm.explorer.enabled", {
            defaultValue: "Show in file manager context menu",
          })}
        />
        <span>
          {t("commandForm.explorer.enabled", {
            defaultValue: "Show in file manager context menu",
          })}
        </span>
      </div>
      <span className="command-form__hint" role="note">
        {t("commandForm.explorer.enabledHint", {
          defaultValue:
            "When launched from a folder's context menu, the selected folder becomes the working directory.",
        })}
      </span>

      {/* --- Path → variable substitution (only meaningful once enabled) --- */}
      {form.explorerEnabled ? (
        <div className="command-form__field">
          <label
            className="command-form__label"
            htmlFor="command-form-explorer-variable"
          >
            {t("commandForm.explorer.pathVariable", {
              defaultValue: "Substitute selected path into variable",
            })}
          </label>
          {hasVariables ? (
            <>
              <Dropdown
                id="command-form-explorer-variable"
                value={form.explorerPathVariable}
                options={variableOptions}
                onChange={onExplorerPathVariableChange}
                ariaLabel={t("commandForm.explorer.pathVariable", {
                  defaultValue: "Substitute selected path into variable",
                })}
              />
              <span className="command-form__hint" role="note">
                {t("commandForm.explorer.pathVariableHint", {
                  defaultValue:
                    "The chosen variable receives the file/folder path as its value.",
                })}
              </span>
            </>
          ) : (
            <span className="command-form__hint" role="note">
              {t("commandForm.explorer.noVariablesHint", {
                defaultValue:
                  "This command has no variables. Add one on the Script tab to substitute the selected path into it.",
              })}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
