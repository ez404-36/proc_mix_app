import type { ReactElement } from "react";
import type { TFunction } from "i18next";

import type {
  ParsedCli,
  UtilityHelp,
  VariableSpec,
} from "../../types";
import type { PlatformOrUnknown } from "../../types/platform";
import type { UtilityNameRange } from "../../utils/utilityName";
import { HelpTooltip } from "../HelpTooltip";
import { NumberStepper } from "../NumberStepper";
import { ToggleSwitch } from "../ToggleSwitch";
import { TrashIcon } from "../icons";
import { ScriptEditor } from "./ScriptEditor";
import { FlagBuilder } from "./FlagBuilder";
import { syncScriptDefaultsToRows } from "./formState";
import type {
  FormErrors,
  FormState,
  FormTab,
  VariableRow,
} from "./formState";
import type {
  UtilityHighlight,
} from "./scriptHighlight";
import type { VariableRowErrorKind } from "./formState";

export interface ScriptTabProps {
  t: TFunction;
  active: boolean;
  form: FormState;
  setForm: (updater: (state: FormState) => FormState) => void;
  errors: FormErrors;
  showErrors: boolean;
  platform: PlatformOrUnknown | null;
  // Script editor highlighting.
  scriptVariableSpecs: VariableSpec[];
  utilityHighlights: UtilityHighlight[];
  helpByUtility: ReadonlyMap<string, UtilityHelp>;
  utilityRanges: UtilityNameRange[];
  flagsByUtility: ReadonlyMap<string, ParsedCli>;
  // Flag builder.
  resolvedHelp: UtilityHelp | null;
  flagBuilderOpen: boolean;
  flagBuilderData: ParsedCli | null;
  flagBuilderLoading: boolean;
  onOpenFlagBuilder: () => void;
  onFlagBuilderChange: (script: string) => void;
  onFlagBuilderDismiss: () => void;
  // Admin elevation.
  isRemoteTarget: boolean;
  elevationLocked: boolean;
  escalationDetected: boolean;
  adminPasswordStored: boolean;
  // Variables.
  variableErrors: ReadonlyArray<VariableRowErrorKind | undefined>;
  onVariableAdd: () => void;
  onVariableRemove: (index: number) => void;
  updateVariableRow: (index: number, patch: Partial<VariableRow>) => void;
}

/**
 * The command form's Script tab: the highlighting script editor, the
 * (optional) flag builder, the run-as-administrator toggle + hints, the
 * timeout stepper, and the variable-row editor. Presentational — all state
 * and handlers come from the parent CommandForm.
 */
export function ScriptTab(props: ScriptTabProps): ReactElement {
  const {
    t,
    active,
    form,
    setForm,
    errors,
    showErrors,
    platform,
    scriptVariableSpecs,
    utilityHighlights,
    helpByUtility,
    utilityRanges,
    flagsByUtility,
    resolvedHelp,
    flagBuilderOpen,
    flagBuilderData,
    flagBuilderLoading,
    onOpenFlagBuilder,
    onFlagBuilderChange,
    onFlagBuilderDismiss,
    isRemoteTarget,
    elevationLocked,
    escalationDetected,
    adminPasswordStored,
    variableErrors,
    onVariableAdd,
    onVariableRemove,
    updateVariableRow,
  } = props;

  const tab: FormTab = "script";
  return (
    <div
      role="tabpanel"
      id={`command-form-panel-${tab}`}
      aria-labelledby={`command-form-tab-${tab}`}
      hidden={!active}
      className="command-form__panel"
    >
      <div className="command-form__field">
        <span className="command-form__label command-form__label--required">
          <span className="command-form__required" aria-hidden="true">
            *
          </span>
          {t("commandForm.fields.script")}
        </span>
        {/*
         * "Expert mode" toggle. Sits between the Script label and the
         * editor. When checked it suppresses the leading-utility
         * highlight + hover help (see `disableHints` in form state).
         * Variable highlighting is unaffected — it reflects the
         * command's own declared variables, not an external hint.
         */}
        <label className="command-form__field command-form__field--inline command-form__disable-hints">
          <input
            type="checkbox"
            checked={form.disableHints}
            onChange={(e) =>
              setForm((s) => ({ ...s, disableHints: e.target.checked }))
            }
          />
          <span>{t("commandForm.fields.disableHints")}</span>
        </label>
        {/*
         * Script field uses ScriptEditor (overlay-highlighting
         * textarea) so `${var}` references — typed or inserted
         * via the right-click "Insert variable" menu — are
         * visually distinguished. Known variables (declared in
         * the Variables section below) get one colour, unknown
         * ones another so typos stand out.
         *
         * `scriptVariableSpecs` is derived from the current row
         * state but only its `name` field is consulted by the
         * editor — see the highlight regex. We pass full specs
         * so future enhancements (e.g. show description on
         * hover over a highlighted reference) don't need a
         * prop-signature change.
         */}
        <ScriptEditor
          value={form.script}
          onChange={(next) =>
            setForm((s) => ({
              ...s,
              script: next,
              variables: syncScriptDefaultsToRows(next, s.variables),
            }))
          }
          variables={scriptVariableSpecs}
          placeholder={t("commandForm.placeholders.script")}
          rows={8}
          ariaInvalid={showErrors && errors.script ? true : false}
          ariaDescribedBy={
            showErrors && errors.script
              ? "command-form-script-error"
              : undefined
          }
          utilityHighlights={utilityHighlights}
          helpByUtility={helpByUtility}
          utilityRanges={utilityRanges}
          flagsByUtility={flagsByUtility}
        />
        {showErrors && errors.script ? (
          <span
            id="command-form-script-error"
            className="command-form__error"
            role="alert"
          >
            {errors.script}
          </span>
        ) : null}

        {resolvedHelp?.status === "found" && !flagBuilderOpen ? (
          <div className="command-form__build-flags-wrap">
            <span className="command-form__build-flags-experimental">
              {t("scriptFirstCreator.actionBuildExperimental")}
            </span>
            <button
              type="button"
              className="btn btn--ghost command-form__build-flags"
              onClick={onOpenFlagBuilder}
              disabled={flagBuilderLoading}
            >
              {flagBuilderLoading
                ? t("scriptFirstCreator.building")
                : t("scriptFirstCreator.actionBuild")}
            </button>
          </div>
        ) : null}

        {flagBuilderOpen && flagBuilderData !== null ? (
          <FlagBuilder
            script={form.script}
            parsed={flagBuilderData}
            onChange={onFlagBuilderChange}
            onDismiss={onFlagBuilderDismiss}
          />
        ) : null}
      </div>

      {/*
       * Admin toggle. When on, the command spawns with elevated
       * privileges (sudo on Unix, UAC on Windows), rendered as the
       * shared iOS-style ToggleSwitch with a visible label beside it.
       * Hint copy is platform-conditional:
       *   - Windows: warn that live-output capture is limited
       *     (the UAC child runs in a different security context).
       *   - Unix + no password stored yet: explain the first-run
       *     password prompt so the modal doesn't surprise users.
       *
       * When the script itself starts with sudo/doas/pkexec, we
       * force the toggle on and disable it (see
       * `escalationDetected` above). The hint below explains why.
       */}
      <div
        className={`command-form__field command-form__field--inline${
          elevationLocked ? " command-form__field--locked" : ""
        }`}
        title={
          isRemoteTarget
            ? t("commandForm.tooltips.runAsAdminRemote", {
                defaultValue:
                  "Run as administrator is not available for remote commands.",
              })
            : escalationDetected
              ? t("commandForm.tooltips.runAsAdminAutoDetected", {
                  defaultValue:
                    "Detected sudo/doas/pkexec at the start of the script — admin mode is required.",
                })
              : undefined
        }
      >
        <ToggleSwitch
          // Remote runs can't be elevated: force the switch off
          // regardless of the persisted flag so the UI matches what the
          // executor will actually do.
          checked={!isRemoteTarget && form.runAsAdmin}
          disabled={elevationLocked}
          onChange={(next) => setForm((s) => ({ ...s, runAsAdmin: next }))}
          ariaLabel={t("commandForm.fields.runAsAdmin", {
            defaultValue: "Run as administrator",
          })}
        />
        <span>
          {t("commandForm.fields.runAsAdmin", {
            defaultValue: "Run as administrator",
          })}
        </span>
      </div>
      {isRemoteTarget ? (
        <span className="command-form__hint" role="note">
          {t("commandForm.hints.runAsAdminRemote", {
            defaultValue:
              "Run as administrator is not available for remote commands.",
          })}
        </span>
      ) : escalationDetected ? (
        <span className="command-form__hint" role="note">
          {t("commandForm.hints.runAsAdminAutoDetected", {
            defaultValue:
              "Detected sudo/doas/pkexec at the start of the script. Admin mode is required and can't be disabled until you remove the escalation prefix.",
          })}
        </span>
      ) : null}
      {!isRemoteTarget && form.runAsAdmin && platform === "windows" ? (
        <span className="command-form__hint" role="note">
          {t("commandForm.warnings.windowsAdmin", {
            defaultValue:
              "Windows will show a UAC prompt. Live output capture is limited.",
          })}
        </span>
      ) : null}
      {!isRemoteTarget &&
      form.runAsAdmin &&
      platform !== "windows" &&
      !adminPasswordStored ? (
        <span className="command-form__hint" role="note">
          {t("commandForm.warnings.adminPasswordWillAsk", {
            defaultValue:
              "You'll be asked for your administrator password on the first run.",
          })}
        </span>
      ) : null}

      <div className="command-form__field">
        <span className="command-form__label">
          {t("commandForm.fields.timeoutSeconds", {
            defaultValue: "Timeout (seconds)",
          })}
        </span>
        {/*
         * Timeout stepper. "Empty = no limit" — the value is stored as a
         * string (`""` = no limit); we bridge it to NumberStepper's
         * nullable mode (`null` ⇄ `""`). The shared component hides the
         * native spinner arrows and renders the app's ghost-button
         * steppers.
         */}
        <NumberStepper
          allowEmpty
          value={
            form.timeoutSeconds.trim() === ""
              ? null
              : Number.parseInt(form.timeoutSeconds, 10)
          }
          onChange={(next) =>
            setForm((s) => ({
              ...s,
              timeoutSeconds: next === null ? "" : String(next),
            }))
          }
          min={1}
          max={Number.MAX_SAFE_INTEGER}
          placeholder={t("commandForm.placeholders.timeoutSeconds", {
            defaultValue: "No limit",
          })}
          ariaLabel={t("commandForm.fields.timeoutSeconds", {
            defaultValue: "Timeout (seconds)",
          })}
          decrementLabel={t("commandForm.timeout.decrement")}
          incrementLabel={t("commandForm.timeout.increment")}
        />
      </div>

      {/*
       * Variables section. Each row declares a `${name}` reference
       * that the runner will resolve at execution time. The
       * `promptAtRuntime` checkbox is the ONLY UI affordance that
       * produces `defaultValue === undefined` on the saved spec —
       * unchecking it preserves the empty string as a valid default
       * (see VariableSpec docs for the semantics). Errors are
       * computed by `computeVariableErrors` and shown inline; any
       * error on any row blocks submit via the form-level
       * `hasErrors` aggregation.
       */}
      <div className="command-form__field">
        <div className="command-form__variables-header">
          <span className="command-form__label">
            {t("commandForm.variables.title")}
          </span>
          {/*
           * Help affordance: an icon-only button paired with a
           * custom popover so the cheat-sheet stays open as long
           * as the cursor is over either the icon or the
           * popover itself. Native `title` was tried first but
           * browsers auto-dismiss it after a few seconds and
           * don't expose its lifetime — the popover gives us
           * that control. See `VariablesHelpTooltip` for the
           * open/close logic (hover-intent close delay +
           * focus/blur for keyboard users).
           */}
          <HelpTooltip
            id="command-form-variables-help"
            buttonLabel={t("commandForm.variables.help")}
            body={t("commandForm.variables.helpTooltip")}
          />
        </div>
        {form.variables.length > 0 ? (
          <ul className="command-form__variables">
            {form.variables.map((row, index) => {
              const errorKind = variableErrors[index];
              // Suppress `invalidName` until the user has actually
              // interacted with the name field, OR until they hit
              // Save (which flips `showErrors`). `duplicateName`
              // always shows because it can only happen after the
              // user has typed something. This keeps a freshly-
              // added blank row from screaming at the user before
              // they get a chance to type.
              const suppressInvalid =
                errorKind === "invalidName" && !row.nameTouched && !showErrors;
              const visibleErrorKind = suppressInvalid ? undefined : errorKind;
              const errorMessage =
                visibleErrorKind === "invalidName"
                  ? t("commandForm.variables.errors.invalidName")
                  : visibleErrorKind === "duplicateName"
                    ? t("commandForm.variables.errors.duplicateName")
                    : null;
              const errorId = `command-form-variable-${row.rowId}-error`;
              return (
                <li key={row.rowId} className="command-form__variables-row">
                  <div className="command-form__variables-row-fields">
                    <input
                      type="text"
                      className="input command-form__variables-name"
                      value={row.name}
                      onChange={(e) =>
                        updateVariableRow(index, {
                          name: e.target.value,
                          // Any keystroke counts as a touch so the
                          // user sees feedback as they type. Once
                          // touched, the flag stays true for the
                          // life of the row.
                          nameTouched: true,
                        })
                      }
                      onBlur={() => {
                        // Mark touched on blur too, in case the
                        // user tabbed in/out without typing.
                        if (!row.nameTouched) {
                          updateVariableRow(index, { nameTouched: true });
                        }
                      }}
                      placeholder={t("commandForm.variables.namePlaceholder")}
                      aria-label={t("commandForm.variables.namePlaceholder")}
                      aria-invalid={errorMessage ? true : undefined}
                      aria-describedby={errorMessage ? errorId : undefined}
                    />
                    <input
                      type="text"
                      className="input command-form__variables-default"
                      value={row.defaultValue}
                      onChange={(e) => {
                        const val = e.target.value;
                        updateVariableRow(index, {
                          defaultValue: val,
                          ...(val === "" ? { promptAtRuntime: true } : {}),
                        });
                      }}
                      placeholder={t(
                        "commandForm.variables.defaultValuePlaceholder",
                      )}
                      aria-label={t(
                        "commandForm.variables.defaultValuePlaceholder",
                      )}
                    />
                    <input
                      type="text"
                      className="input command-form__variables-description"
                      value={row.description}
                      onChange={(e) =>
                        updateVariableRow(index, {
                          description: e.target.value,
                        })
                      }
                      placeholder={t(
                        "commandForm.variables.descriptionPlaceholder",
                      )}
                      aria-label={t(
                        "commandForm.variables.descriptionPlaceholder",
                      )}
                    />
                    <div className="command-form__variables-toggles">
                      <label className="command-form__field command-form__field--inline">
                        <input
                          type="checkbox"
                          checked={row.promptAtRuntime}
                          onChange={(e) =>
                            updateVariableRow(index, {
                              promptAtRuntime: e.target.checked,
                            })
                          }
                        />
                        <span>{t("commandForm.variables.promptAtRuntime")}</span>
                      </label>
                      <label className="command-form__field command-form__field--inline">
                        <input
                          type="checkbox"
                          checked={row.sensitive}
                          onChange={(e) =>
                            updateVariableRow(index, {
                              sensitive: e.target.checked,
                            })
                          }
                        />
                        <span>{t("commandForm.variables.sensitive")}</span>
                      </label>
                      {row.sensitive ? (
                        <p className="form-hint">
                          {t("commandForm.variables.sensitiveLeakWarning")}
                        </p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="btn btn--ghost btn--icon command-form__variables-remove"
                      onClick={() => onVariableRemove(index)}
                      aria-label={t("commandForm.variables.remove")}
                      title={t("commandForm.variables.remove")}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                  {errorMessage ? (
                    <span
                      id={errorId}
                      className="command-form__error"
                      role="alert"
                    >
                      {errorMessage}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        <button type="button" className="btn btn--ghost" onClick={onVariableAdd}>
          {t("commandForm.variables.add")}
        </button>
      </div>
    </div>
  );
}
