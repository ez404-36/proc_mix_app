// Create / edit form for a cron schedule, rendered as a full-screen page
// (the `scheduler-editor` view) rather than a modal — mirrors the
// `CommandForm` / command-editor pattern.
//
// Responsibilities:
//   - Pick a target (command or workflow) from the existing library.
//   - Choose a recurrence TYPE (every-N-minutes / every-N-hours / daily /
//     weekly / monthly / custom) and fill its parameter sub-form; the
//     structured value is compiled to a 5-field cron via `buildCron`, with a
//     live preview of the next fire times (`preview_next_runs`).
//   - Capture variable values AT CREATION for a command target (background
//     runs cannot prompt). Save is blocked until every no-default variable
//     has a value.
//   - Persist via `scheduleActions`, surfacing quota / invalid-cron errors.

import { useEffect, useMemo, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  createSchedule,
  updateSchedule,
} from "../../services/scheduleActions";
import { useCommandStore } from "../../stores/commandStore";
import { useWorkflowStore } from "../../stores/workflowStore";
import type {
  Command,
  NewScheduleInput,
  Schedule,
  ScheduleTargetKind,
  CommandVariableValues,
} from "../../types";
import { isCommandVariableValues } from "../../types";
import { getCommandName } from "../../utils/commandLabels";
import {
  buildCron,
  defaultRecurrence,
  parseCron,
  RECURRENCE_TYPES,
  WEEKDAYS,
  type Recurrence,
  type RecurrenceType,
} from "../../utils/scheduleRecurrence";
import { previewNextRuns } from "../../utils/scheduleRepository";
import {
  commandVariablesSatisfied,
  requiredVariableNames,
  seedVariableValues,
} from "../../utils/scheduleVariables";

import { Dropdown } from "../Dropdown";
import type { DropdownOption } from "../Dropdown";
import { HelpTooltip } from "../HelpTooltip";
import { CancelIcon, SaveIcon } from "../icons";
import { NumberStepper } from "../NumberStepper";

interface ScheduleFormProps {
  /** The schedule being edited, or `null` to create a new one. */
  schedule: Schedule | null;
  /** Leave the editor (back to the Scheduler list) — called on Save / Cancel. */
  onClose: () => void;
}

/** Default recurrence type for a brand-new schedule. */
const DEFAULT_RECURRENCE_TYPE: RecurrenceType = "daily";

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}



export function ScheduleForm({
  schedule,
  onClose,
}: ScheduleFormProps): ReactElement {
  const { t } = useTranslation();
  const commands = useCommandStore((s) => s.commands);
  const workflows = useWorkflowStore((s) => s.workflows);

  const editing = schedule !== null;

  const [name, setName] = useState("");
  const [targetKind, setTargetKind] = useState<ScheduleTargetKind>("command");
  const [targetId, setTargetId] = useState("");
  const [recurrence, setRecurrence] = useState<Recurrence>(() =>
    defaultRecurrence(DEFAULT_RECURRENCE_TYPE),
  );
  const [skipIfRunning, setSkipIfRunning] = useState(false);
  // Persist each fire's console output (and extracted result) to history so it
  // is viewable in the schedule's History tab. Default ON. Capture is
  // commands-only in v1 — workflow targets record no output regardless.
  const [captureOutput, setCaptureOutput] = useState(true);
  // Catch-up: whether to replay missed runs, and how. `catchUp` is the
  // checkbox; `catchUpMode` (once/all) only matters when it's on. They map to
  // the backend `catchUpPolicy`: off -> "none", on -> the mode.
  const [catchUp, setCatchUp] = useState(false);
  const [catchUpMode, setCatchUpMode] = useState<"once" | "all">("once");
  // Timeout override: `useTimeout` is the checkbox; `timeoutSeconds` only
  // applies when it's on. Maps to the backend `timeoutSeconds` (off ->
  // undefined). Command targets only — the workflow runner times nodes itself.
  const [useTimeout, setUseTimeout] = useState(false);
  const [timeoutSeconds, setTimeoutSeconds] = useState(30);
  // Retry-on-error: `retryOnError` is the checkbox; `maxRetries` (>=1) applies
  // when on. Maps to the backend `maxRetries` (off -> 0).
  const [retryOnError, setRetryOnError] = useState(false);
  const [maxRetries, setMaxRetries] = useState(1);
  const [enabled, setEnabled] = useState(true);
  const [variableValues, setVariableValues] = useState<CommandVariableValues>(
    {},
  );
  const [preview, setPreview] = useState<string[]>([]);
  const [cronError, setCronError] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Reset the form whenever the edited schedule changes (or on mount).
  useEffect(() => {
    if (schedule) {
      setName(schedule.name);
      setTargetKind(schedule.targetKind);
      setTargetId(schedule.targetId);
      // Recognise the stored cron as a structured recurrence, else fall back
      // to the custom expression mode carrying the raw string.
      setRecurrence(parseCron(schedule.cron));
      setSkipIfRunning(schedule.skipIfRunning);
      setCaptureOutput(schedule.captureOutput);
      // "none" -> checkbox off; "once"/"all" -> on with that mode.
      setCatchUp(schedule.catchUpPolicy !== "none");
      setCatchUpMode(schedule.catchUpPolicy === "all" ? "all" : "once");
      // A stored positive timeout/retry turns its checkbox on with that value.
      setUseTimeout(
        schedule.timeoutSeconds !== undefined && schedule.timeoutSeconds > 0,
      );
      setTimeoutSeconds(
        schedule.timeoutSeconds && schedule.timeoutSeconds > 0
          ? schedule.timeoutSeconds
          : 30,
      );
      setRetryOnError(schedule.maxRetries > 0);
      setMaxRetries(schedule.maxRetries > 0 ? schedule.maxRetries : 1);
      setEnabled(schedule.enabled);
      // Only command targets carry a flat variable map here; workflow
      // variable capture is handled per-node and out of scope for the MVP
      // edit form (the stored values round-trip untouched). The guard
      // narrows the polymorphic `variableValues` union via the discriminator.
      if (isCommandVariableValues(schedule)) {
        setVariableValues(schedule.variableValues);
      } else {
        setVariableValues({});
      }
    } else {
      setName("");
      setTargetKind("command");
      setTargetId("");
      setRecurrence(defaultRecurrence(DEFAULT_RECURRENCE_TYPE));
      setSkipIfRunning(false);
      setCaptureOutput(true);
      setCatchUp(false);
      setCatchUpMode("once");
      setUseTimeout(false);
      setTimeoutSeconds(30);
      setRetryOnError(false);
      setMaxRetries(1);
      setEnabled(true);
      setVariableValues({});
    }
    setFormError(null);
    setCronError(false);
  }, [schedule]);

  // The cron string the rest of the form (preview, save) operates on is
  // derived from the structured recurrence.
  const activeCron = buildCron(recurrence);

  const selectedCommand: Command | undefined = useMemo(
    () =>
      targetKind === "command"
        ? commands.find((c) => c.id === targetId)
        : undefined,
    [commands, targetKind, targetId],
  );

  // Seed variable values when a command target is selected (create mode), so
  // every variable starts at its default and no-default ones start blank.
  useEffect(() => {
    if (editing) return;
    if (selectedCommand) {
      setVariableValues(seedVariableValues(selectedCommand.variables));
    } else {
      setVariableValues({});
    }
  }, [editing, selectedCommand]);

  // Live preview of the next fire times, debounced via the effect's natural
  // re-run on `activeCron`.
  useEffect(() => {
    let cancelled = false;
    const cron = activeCron.trim();
    if (cron === "") {
      setPreview([]);
      setCronError(false);
      return;
    }
    void previewNextRuns(cron, 5)
      .then((times) => {
        if (cancelled) return;
        setPreview(times);
        setCronError(false);
      })
      .catch(() => {
        if (cancelled) return;
        setPreview([]);
        setCronError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [activeCron]);

  const targetOptions: ReadonlyArray<DropdownOption> =
    targetKind === "command"
      ? commands.map((c) => ({ value: c.id, label: getCommandName(c, t) }))
      : workflows.map((w) => ({ value: w.id, label: w.name }));

  const requiredVars =
    selectedCommand !== undefined
      ? requiredVariableNames(selectedCommand.variables)
      : [];

  const variablesOk =
    selectedCommand === undefined ||
    commandVariablesSatisfied(selectedCommand, variableValues);

  // No-default variables still blank — surfaced as the reason Save is
  // disabled so the user knows what to fill in (a background run would fail
  // with `missingVariable` otherwise).
  const missingRequiredVars = requiredVars.filter(
    (name) => (variableValues[name] ?? "").trim() === "",
  );

  // Weekly with no selected days has no meaningful cron; block save until at
  // least one day is picked. Other structured types always build a valid cron.
  const recurrenceValid =
    recurrence.type !== "weekly" || recurrence.days.length > 0;

  const canSave =
    name.trim() !== "" &&
    targetId !== "" &&
    !cronError &&
    recurrenceValid &&
    activeCron.trim() !== "" &&
    variablesOk;

  const handleKindChange = (kind: string): void => {
    if (kind !== "command" && kind !== "workflow") return;
    setTargetKind(kind);
    setTargetId("");
    setVariableValues({});
  };

  const handleRecurrenceTypeChange = (next: string): void => {
    const type = RECURRENCE_TYPES.find((rt) => rt === next);
    if (type === undefined) return;
    setRecurrence(defaultRecurrence(type));
  };

  const toggleWeekday = (cronDay: number): void => {
    setRecurrence((prev) => {
      if (prev.type !== "weekly") return prev;
      const has = prev.days.includes(cronDay);
      const days = has
        ? prev.days.filter((d) => d !== cronDay)
        : [...prev.days, cronDay];
      return { ...prev, days };
    });
  };

  const handleVariableChange = (variable: string, value: string): void => {
    setVariableValues((prev) => ({ ...prev, [variable]: value }));
  };

  // Per-type parameter sub-form revealed below the recurrence-type dropdown.
  const renderRecurrenceParams = (): ReactElement | null => {
    switch (recurrence.type) {
      case "everyNMinutes":
        return (
          <div className="form-field schedule-form__param">
            <span className="form-field__label">
              {t("scheduler.form.everyNMinutesLabel")}
            </span>
            <div className="schedule-form__stepper">
              <NumberStepper
                value={recurrence.interval}
                min={1}
                max={59}
                ariaLabel={t("scheduler.form.minutesInterval")}
                decrementLabel={t("scheduler.form.stepDown")}
                incrementLabel={t("scheduler.form.stepUp")}
                onChange={(interval) =>
                  setRecurrence({ type: "everyNMinutes", interval })
                }
              />
            </div>
            <p className="form-hint schedule-form__param-hint">
              {t("scheduler.form.everyNMinutesHint")}
            </p>
          </div>
        );
      case "everyNHours": {
        const r = recurrence;
        return (
          <div className="schedule-form__param schedule-form__param-row">
            <div className="form-field">
              <span className="form-field__label">
                {t("scheduler.form.hoursInterval")}
              </span>
              <div className="schedule-form__stepper">
                <NumberStepper
                  value={r.interval}
                  min={1}
                  max={23}
                  ariaLabel={t("scheduler.form.hoursInterval")}
                  decrementLabel={t("scheduler.form.stepDown")}
                  incrementLabel={t("scheduler.form.stepUp")}
                  onChange={(interval) => setRecurrence({ ...r, interval })}
                />
              </div>
            </div>
            <div className="form-field">
              <span className="form-field__label">
                {t("scheduler.form.onMinute")}
              </span>
              <div className="schedule-form__stepper">
                <NumberStepper
                  value={r.minute}
                  min={0}
                  max={59}
                  ariaLabel={t("scheduler.form.onMinute")}
                  decrementLabel={t("scheduler.form.stepDown")}
                  incrementLabel={t("scheduler.form.stepUp")}
                  onChange={(minute) => setRecurrence({ ...r, minute })}
                />
              </div>
            </div>
          </div>
        );
      }
      case "daily": {
        const r = recurrence;
        return (
          <div className="form-field schedule-form__param">
            <span className="form-field__label">
              {t("scheduler.form.atTime")}
            </span>
            <TimeFields
              hour={r.hour}
              minute={r.minute}
              onChange={(hour, minute) =>
                setRecurrence({ type: "daily", hour, minute })
              }
            />
          </div>
        );
      }
      case "weekly": {
        const r = recurrence;
        return (
          <div className="schedule-form__param">
            <span className="form-field__label">
              {t("scheduler.form.onDays")}
            </span>
            <div className="schedule-form__weekdays">
              {WEEKDAYS.map((d) => (
                <button
                  key={d.cron}
                  type="button"
                  className={`btn btn--ghost${
                    r.days.includes(d.cron) ? " is-active" : ""
                  }`}
                  aria-pressed={r.days.includes(d.cron)}
                  onClick={() => toggleWeekday(d.cron)}
                >
                  {t(`scheduler.weekdays.${d.key}` as const)}
                </button>
              ))}
            </div>
            {r.days.length === 0 ? (
              <p className="form-error">{t("scheduler.form.noDaysSelected")}</p>
            ) : null}
            <div className="form-field">
              <span className="form-field__label">
                {t("scheduler.form.atTime")}
              </span>
              <TimeFields
                hour={r.hour}
                minute={r.minute}
                onChange={(hour, minute) =>
                  setRecurrence({ ...r, hour, minute })
                }
              />
            </div>
          </div>
        );
      }
      case "monthly": {
        const r = recurrence;
        return (
          <div className="schedule-form__param schedule-form__param-row">
            <div className="form-field">
              <span className="form-field__label">
                {t("scheduler.form.onDayOfMonth")}
              </span>
              <div className="schedule-form__stepper">
                <NumberStepper
                  value={r.day}
                  min={1}
                  max={31}
                  ariaLabel={t("scheduler.form.onDayOfMonth")}
                  decrementLabel={t("scheduler.form.stepDown")}
                  incrementLabel={t("scheduler.form.stepUp")}
                  onChange={(day) => setRecurrence({ ...r, day })}
                />
              </div>
            </div>
            <div className="form-field">
              <span className="form-field__label">
                {t("scheduler.form.atTime")}
              </span>
              <TimeFields
                hour={r.hour}
                minute={r.minute}
                onChange={(hour, minute) =>
                  setRecurrence({ ...r, hour, minute })
                }
              />
            </div>
            <p className="form-hint schedule-form__param-hint">
              {t("scheduler.form.monthlyDayHint")}
            </p>
          </div>
        );
      }
      case "custom":
        return (
          <div className="schedule-form__param">
            <input
              className={`input${cronError ? " input--error" : ""}`}
              type="text"
              value={recurrence.cron}
              placeholder={t("scheduler.form.cronPlaceholder")}
              aria-label={t("scheduler.form.cronExpression")}
              onChange={(e) =>
                setRecurrence({ type: "custom", cron: e.target.value })
              }
            />
            <p className="form-hint">{t("scheduler.form.cronHelp")}</p>
          </div>
        );
    }
  };

  // Variable-capture block for a command target with variables. Placed between
  // the target picker and the recurrence picker. Required (no-default)
  // variables are starred and block Save while blank; each variable with a
  // description gets a help-tooltip next to its label.
  const renderVariables = (): ReactElement | null => {
    if (
      selectedCommand === undefined ||
      (selectedCommand.variables?.length ?? 0) === 0
    ) {
      return null;
    }
    return (
      <div className="form-field">
        <span className="form-field__label">
          {t("scheduler.form.variables")}
        </span>
        <p className="form-hint">{t("scheduler.form.variablesHint")}</p>
        {selectedCommand.variables?.map((spec) => {
          const required = requiredVars.includes(spec.name);
          const missing = missingRequiredVars.includes(spec.name);
          return (
            <label key={spec.name} className="form-field">
              <span className="schedule-form__variable-label">
                {required ? (
                  <RequiredLabel>{spec.name}</RequiredLabel>
                ) : (
                  <span className="form-field__label">{spec.name}</span>
                )}
                {spec.description ? (
                  <HelpTooltip
                    id={`schedule-form-variable-help-${spec.name}`}
                    buttonLabel={t("scheduler.form.variableHelp", {
                      name: spec.name,
                    })}
                    body={spec.description}
                  />
                ) : null}
              </span>
              <input
                className={`input${missing ? " input--error" : ""}`}
                type={spec.sensitive ? "password" : "text"}
                value={variableValues[spec.name] ?? ""}
                aria-required={required}
                aria-invalid={missing}
                onChange={(e) =>
                  handleVariableChange(spec.name, e.target.value)
                }
              />
            </label>
          );
        })}
        {missingRequiredVars.length > 0 ? (
          <p className="form-error">{t("scheduler.form.variablesRequired")}</p>
        ) : null}
      </div>
    );
  };

  const handleSave = async (): Promise<void> => {
    setFormError(null);
    // Defense-in-depth: the Save button is disabled while required variables
    // are blank, but never let an unsatisfied schedule through (a background
    // run would fail with `missingVariable`).
    if (!variablesOk) {
      setFormError(t("scheduler.form.variablesRequired"));
      return;
    }
    const input: NewScheduleInput = {
      name: name.trim(),
      targetKind,
      targetId,
      cron: activeCron.trim(),
      // Command targets carry the captured flat map; workflow targets keep
      // whatever was stored (empty for new workflow schedules in the MVP).
      variableValues:
        targetKind === "command"
          ? variableValues
          : schedule?.variableValues ?? {},
      skipIfRunning,
      captureOutput,
      catchUpPolicy: catchUp ? catchUpMode : "none",
      // Timeout override applies to command targets only; off (or a workflow
      // target) sends undefined so the command's own timeout stands.
      timeoutSeconds:
        useTimeout && targetKind === "command" ? timeoutSeconds : undefined,
      maxRetries: retryOnError ? maxRetries : 0,
      enabled,
    };

    const result =
      editing && schedule
        ? await updateSchedule(schedule.id, input)
        : await createSchedule(input);

    if (result.ok) {
      onClose();
      return;
    }
    if (result.reason === "invalidCron") {
      setCronError(true);
      setFormError(t("scheduler.form.invalidCron"));
    }
    // "unknown" already surfaced a toast inside the service.
  };

  return (
    <div className="schedule-editor-view">
      <header className="view-header schedule-form__header">
        <h1 className="view-title">
          {editing
            ? t("scheduler.form.editTitle")
            : t("scheduler.form.createTitle")}
        </h1>
        <div className="view-header__actions">

          <button
            type="button"
            className="btn command-form__action command-form__action--cancel"
            onClick={onClose}
          >
            <span className="command-form__action-icon--cancel">
              <CancelIcon />
            </span>
            {t("scheduler.form.cancel")}
          </button>
          <button
            type="button"
            className="btn btn--primary command-form__action"
            disabled={!canSave}
            onClick={() => void handleSave()}
          >
            <SaveIcon />
            {t("common.save")}
          </button>
        </div>
      </header>

      <div className="schedule-form">
        <fieldset className="schedule-form__section schedule-form__section--stack">
          <legend className="schedule-form__section-title">
            {t("scheduler.form.basicSection")}
          </legend>

          <label className="form-field">
            <RequiredLabel>{t("scheduler.form.name")}</RequiredLabel>
            <input
              className="input"
              type="text"
              value={name}
              aria-required="true"
              placeholder={t("scheduler.form.namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <div className="form-field">
            <RequiredLabel>{t("scheduler.form.target")}</RequiredLabel>
            <div className="schedule-form__target">
              <Dropdown
                value={targetKind}
                options={[
                  {
                    value: "command",
                    label: t("scheduler.form.targetCommand"),
                  },
                  {
                    value: "workflow",
                    label: t("scheduler.form.targetWorkflow"),
                  },
                ]}
                onChange={handleKindChange}
                ariaLabel={t("scheduler.form.target")}
              />
              {targetOptions.length > 0 ? (
                <Dropdown
                  value={targetId}
                  options={[
                    {
                      value: "",
                      label: t("scheduler.form.selectTarget", {
                        kind:
                          targetKind === "command"
                            ? t("scheduler.form.targetCommand")
                            : t("scheduler.form.targetWorkflow"),
                      }),
                    },
                    ...targetOptions,
                  ]}
                  onChange={setTargetId}
                  ariaLabel={t("scheduler.form.target")}
                />
              ) : (
                <p className="form-hint">
                  {t("scheduler.form.noTargets", {
                    kind:
                      targetKind === "command"
                        ? t("scheduler.form.targetCommand")
                        : t("scheduler.form.targetWorkflow"),
                  })}
                </p>
              )}
            </div>
          </div>

          {renderVariables()}
        </fieldset>

        <fieldset className="schedule-form__section">
          <legend className="schedule-form__section-title">
            {t("scheduler.form.scheduleSection")}
          </legend>
          <div className="schedule-form__columns">
            <div className="form-field schedule-form__column">
              <span className="form-field__label">
                {t("scheduler.form.when")}
              </span>
              <Dropdown
                value={recurrence.type}
                options={RECURRENCE_TYPES.map((type) => ({
                  value: type,
                  label: t(`scheduler.recurrence.${type}` as const),
                }))}
                onChange={handleRecurrenceTypeChange}
                ariaLabel={t("scheduler.form.when")}
              />

              <div className="schedule-form__recurrence-params">
                {renderRecurrenceParams()}
              </div>
            </div>

            <div className="form-field schedule-form__column">
              <span className="form-field__label">
                {t("scheduler.form.preview")}
              </span>
              {cronError ? (
                <p className="form-error">{t("scheduler.form.invalidCron")}</p>
              ) : preview.length === 0 ? (
                <p className="form-hint">{t("scheduler.form.previewEmpty")}</p>
              ) : (
                <ul className="schedule-form__preview">
                  {preview.map((iso) => (
                    <li key={iso}>{formatTime(iso)}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </fieldset>

        <fieldset className="schedule-form__section schedule-form__section--stack">
          <legend className="schedule-form__section-title">
            {t("scheduler.form.advancedSection")}
          </legend>

        <div className="form-checkbox-row">
          <label className="form-checkbox">
            <input
              type="checkbox"
              checked={skipIfRunning}
              onChange={(e) => setSkipIfRunning(e.target.checked)}
            />
            <span>{t("scheduler.form.skipIfRunning")}</span>
          </label>
          <HelpTooltip
            id="schedule-form-skip-if-running-help"
            buttonLabel={t("scheduler.form.skipIfRunningHelp")}
            body={t("scheduler.form.skipIfRunningTooltip")}
          />
        </div>

        <div className="form-checkbox-row">
          <label className="form-checkbox">
            <input
              type="checkbox"
              checked={captureOutput}
              onChange={(e) => setCaptureOutput(e.target.checked)}
            />
            <span>{t("scheduler.form.captureOutput")}</span>
          </label>
          <HelpTooltip
            id="schedule-form-capture-output-help"
            buttonLabel={t("scheduler.form.captureOutputHelp")}
            body={t("scheduler.form.captureOutputTooltip")}
          />
        </div>

        <div className="schedule-form__catch-up">
          <div className="form-checkbox-row">
            <label className="form-checkbox">
              <input
                type="checkbox"
                checked={catchUp}
                onChange={(e) => setCatchUp(e.target.checked)}
              />
              <span>{t("scheduler.form.catchUp")}</span>
            </label>
            <HelpTooltip
              id="schedule-form-catch-up-help"
              buttonLabel={t("scheduler.form.catchUpHelp")}
              body={t("scheduler.form.catchUpTooltip")}
            />
          </div>

          {catchUp ? (
            <div
              className="schedule-form__catch-up-modes"
              role="radiogroup"
              aria-label={t("scheduler.form.catchUp")}
            >
              <label className="form-radio">
                <input
                  type="radio"
                  name="catch-up-mode"
                  checked={catchUpMode === "once"}
                  onChange={() => setCatchUpMode("once")}
                />
                <span>{t("scheduler.form.catchUpOnce")}</span>
              </label>
              <label className="form-radio">
                <input
                  type="radio"
                  name="catch-up-mode"
                  checked={catchUpMode === "all"}
                  onChange={() => setCatchUpMode("all")}
                />
                <span>{t("scheduler.form.catchUpAll")}</span>
              </label>
            </div>
          ) : null}
        </div>

        {targetKind === "command" ? (
          <div className="schedule-form__catch-up">
            <label className="form-checkbox">
              <input
                type="checkbox"
                checked={useTimeout}
                onChange={(e) => setUseTimeout(e.target.checked)}
              />
              <span>{t("scheduler.form.useTimeout")}</span>
            </label>
            {useTimeout ? (
              <label className="form-field schedule-form__sub-field">
                <span className="form-field__label">
                  {t("scheduler.form.timeoutSeconds")}
                </span>
                <div className="schedule-form__stepper">
                  <NumberStepper
                    value={timeoutSeconds}
                    min={1}
                    max={86400}
                    ariaLabel={t("scheduler.form.timeoutSeconds")}
                    decrementLabel={t("scheduler.form.stepDown")}
                    incrementLabel={t("scheduler.form.stepUp")}
                    onChange={setTimeoutSeconds}
                  />
                </div>
              </label>
            ) : null}
          </div>
        ) : null}

        <div className="schedule-form__catch-up">
          <label className="form-checkbox">
            <input
              type="checkbox"
              checked={retryOnError}
              onChange={(e) => setRetryOnError(e.target.checked)}
            />
            <span>{t("scheduler.form.retryOnError")}</span>
          </label>
          {retryOnError ? (
            <label className="form-field schedule-form__sub-field">
              <span className="form-field__label">
                {t("scheduler.form.maxRetries")}
              </span>
              <div className="schedule-form__stepper">
                <NumberStepper
                  value={maxRetries}
                  min={1}
                  max={10}
                  ariaLabel={t("scheduler.form.maxRetries")}
                  decrementLabel={t("scheduler.form.stepDown")}
                  incrementLabel={t("scheduler.form.stepUp")}
                  onChange={setMaxRetries}
                />
              </div>
            </label>
          ) : null}
        </div>

        <label className="form-checkbox">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>{t("scheduler.form.enabledOnCreate")}</span>
        </label>
        </fieldset>

        {formError !== null ? (
          <p className="form-error">{formError}</p>
        ) : null}
      </div>

    </div>
  );
}

/**
 * Time-of-day picker rendered as two separately-labelled number steppers —
 * Hours (0-23) and Minutes (0-59), each zero-padded to two digits (HH / MM)
 * and defaulting to 00. Replaces the native `<input type="time">` so the
 * control matches the app's stepper style and the rest of the form's fields.
 */
function TimeFields({
  hour,
  minute,
  onChange,
}: {
  hour: number;
  minute: number;
  onChange: (hour: number, minute: number) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="schedule-form__time">
      <label className="form-field schedule-form__time-field">
        <span className="form-field__label">{t("scheduler.form.hours")}</span>
        <div className="schedule-form__stepper">
          <NumberStepper
            value={hour}
            min={0}
            max={23}
            padLength={2}
            ariaLabel={t("scheduler.form.hours")}
            decrementLabel={t("scheduler.form.stepDown")}
            incrementLabel={t("scheduler.form.stepUp")}
            onChange={(h) => onChange(h, minute)}
          />
        </div>
      </label>
      <label className="form-field schedule-form__time-field">
        <span className="form-field__label">{t("scheduler.form.minutes")}</span>
        <div className="schedule-form__stepper">
          <NumberStepper
            value={minute}
            min={0}
            max={59}
            padLength={2}
            ariaLabel={t("scheduler.form.minutes")}
            decrementLabel={t("scheduler.form.stepDown")}
            incrementLabel={t("scheduler.form.stepUp")}
            onChange={(m) => onChange(hour, m)}
          />
        </div>
      </label>
    </div>
  );
}

/**
 * A `form-field__label` marked as required: a red asterisk to the left and a
 * heavier, full-strength label — matching the command form's required-field
 * treatment (`form-field__label--required` / `form-field__required`). The
 * glyph is `aria-hidden`; the associated input carries `aria-required`.
 */
function RequiredLabel({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  return (
    <span className="form-field__label form-field__label--required">
      <span className="form-field__required" aria-hidden="true">
        *
      </span>
      {children}
    </span>
  );
}
