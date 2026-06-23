import type { TFunction } from "i18next";
import type {
  Command,
  Shell,
  VariableSpec,
} from "../../types";
import type { PlatformOrUnknown } from "../../types/platform";
import type { DropdownOption } from "../Dropdown";
import {
  getCommandDescription,
  getCommandName,
} from "../../utils/commandLabels";
import type { EnvRow, FormState, VariableRow } from "../../types/commandForm";

export type {
  EnvRow,
  FormState,
  RunLine,
  RunResult,
  RunStatus,
  VariableRow,
} from "../../types/commandForm";
export {
  CANCEL_FALLBACK_MS,
  CANCEL_GRACE_MS,
  envRowsToRecord,
  INITIAL_RUN_RESULT,
  parseTimeoutSeconds,
  rowsToVariableSpecs,
  syncScriptDefaultsToRows,
  syncVariableDefaultToScript,
} from "../../utils/commandFormState";

/**
 * Every logical shell name the form is willing to surface. The Rust
 * executor accepts these verbatim (see `Shell` in src/types/command.ts
 * for the mapping). At runtime this list is filtered down to the
 * shells actually detected on the host PATH — see `buildShellOptions`.
 */
export const ALL_SHELLS: readonly Shell[] = [
  "bash",
  "zsh",
  "sh",
  "fish",
  "pwsh",
  "powershell",
  "cmd",
];

export function isShell(value: string): value is Shell {
  return (ALL_SHELLS as readonly string[]).includes(value);
}

/**
 * Default shell to preselect when creating a new command, picked from the
 * host OS. Windows defaults to `powershell` (PS 5.1, ships with every
 * Windows install) rather than `pwsh` which requires a separate install.
 */
export function defaultShellForPlatform(
  platform: PlatformOrUnknown | null,
): Shell {
  switch (platform) {
    case "macos":
      return "zsh";
    case "windows":
      return "powershell";
    case "linux":
    case "unknown":
    case null:
    default:
      return "bash";
  }
}

/**
 * Pick the shell to pre-select for a fresh CREATE form. Prefers the
 * platform default when it's actually installed; otherwise falls back
 * to the first detected shell; otherwise returns the platform default
 * anyway (zero-detection case — the form will still render and show a
 * warning hint, but the user has to type the script themselves).
 */
export function pickCreateModeShell(
  platform: PlatformOrUnknown | null,
  available: ReadonlyArray<Shell>,
): Shell {
  const preferred = defaultShellForPlatform(platform);
  if (available.includes(preferred)) return preferred;
  if (available.length > 0) {
    const first = available[0];
    if (first !== undefined) return first;
  }
  return preferred;
}

/**
 * Build the dropdown options list for the shell field. Order:
 *   1. If `currentValue` is not in `available`, prepend it as a
 *      disabled option with a localized "(not available)" suffix so
 *      the user can see what is stored without being able to re-pick
 *      it. This is the cross-machine / stale-seed case.
 *   2. Followed by every detected shell in detection order.
 *
 * `currentValue` is the form's current `shell` field, which may be a
 * shell stored on an edited command, or the create-mode default.
 */
export function buildShellOptions(
  currentValue: Shell,
  available: ReadonlyArray<Shell>,
  unavailableSuffix: string,
): ReadonlyArray<DropdownOption> {
  const options: DropdownOption[] = [];
  if (!available.includes(currentValue)) {
    options.push({
      value: currentValue,
      label: `${currentValue} ${unavailableSuffix}`,
      disabled: true,
    });
  }
  for (const sh of available) {
    options.push({ value: sh, label: sh });
  }
  return options;
}

/**
 * The form's four tabs. `main` holds metadata + execution settings,
 * `script` the script editor and variables, `output` the output schema,
 * `env` the per-command environment variable overrides.
 */
export type FormTab = "main" | "script" | "output" | "env";

export interface FormErrors {
  name?: string;
  script?: string;
}

/** Regex enforced on every variable row's `name` field. */
export const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Sentinel option values for the Category dropdown. Categories are
 * modeled inline as free-text on `Command.categoryId`, so there is no
 * "id" namespace to collide with — but we still reserve two sentinels:
 *   - `""`        → "No category" (maps to `categoryId: undefined` on save).
 *   - `__new__`   → opens the inline "add a new category" input.
 * A real category name can never equal `__new__` in practice; the
 * confirm handler trims and stores the literal name the user typed, and
 * the dropdown's own options are the existing names plus these two.
 */
export const CATEGORY_NONE_SENTINEL = "";
export const CATEGORY_NEW_SENTINEL = "__new__";

export type VariableRowErrorKind = "invalidName" | "duplicateName";

/**
 * Compute per-row errors. Returned as a parallel array so rendering
 * can index it by position; the order matches `rows`.
 *
 * Rules:
 *   - First-name-wins for duplicates: the SECOND (and later) occurrence
 *     of a given name receives the `duplicateName` error. The first
 *     occurrence is treated as the canonical entry. This matches the
 *     intuition that the user is most likely about to rename the row
 *     they just added.
 *   - The duplicate check is case-sensitive ("FOO" and "foo" are
 *     distinct).
 *   - The invalid-name check runs independently and takes priority over
 *     duplicate: an invalid-named row is also not eligible to "claim"
 *     a name for the duplicate check, so a second row with the same
 *     invalid name still reports invalidName, never duplicate.
 *   - Empty names are reported as invalidName (they don't match the
 *     regex). This blocks submit until the user types something.
 */
export function computeVariableErrors(
  rows: ReadonlyArray<VariableRow>,
): ReadonlyArray<VariableRowErrorKind | undefined> {
  const seen = new Set<string>();
  return rows.map((row) => {
    if (!VARIABLE_NAME_RE.test(row.name)) {
      return "invalidName";
    }
    if (seen.has(row.name)) {
      return "duplicateName";
    }
    seen.add(row.name);
    return undefined;
  });
}

/**
 * Hydrate the form state's variable rows from a persisted command's
 * spec list. The reverse of {@link rowsToVariableSpecs}.
 *
 * `promptAtRuntime` resolution:
 *   - If the spec carries an explicit `promptAtRuntime` flag (new
 *     records that combine default + prompt), use it verbatim.
 *   - Otherwise fall back to the legacy convention: prompt iff
 *     `defaultValue` is absent.
 */
export function specsToVariableRows(
  specs: ReadonlyArray<VariableSpec>,
): VariableRow[] {
  return specs.map((spec) => ({
    rowId: makeRowId(),
    name: spec.name,
    defaultValue: spec.defaultValue ?? "",
    description: spec.description ?? "",
    sensitive: spec.sensitive ?? false,
    promptAtRuntime:
      spec.promptAtRuntime !== undefined
        ? spec.promptAtRuntime
        : spec.defaultValue === undefined,
    // Hydrated rows already have a real name, so the touched flag is
    // true: showing a validation error on a persisted (necessarily
    // valid) name is fine, but more importantly it would surface
    // legitimately if the user clears the field later.
    nameTouched: true,
  }));
}

export function makeRowId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `var-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Convert a `Command.env` record (KEY → value) to an array of `EnvRow`s
 * suitable for the form's env tab. Each entry gets a fresh `rowId`.
 *
 * Returns an empty array when `env` is `undefined` or empty.
 */
export function recordToEnvRows(
  env: Record<string, string> | undefined,
): EnvRow[] {
  if (!env) return [];
  return Object.entries(env).map(([key, value]) => ({
    rowId: makeRowId(),
    key,
    value,
  }));
}

export function buildInitialState(
  command: Command | null,
  mode: "create" | "edit",
  t: TFunction,
  platform: PlatformOrUnknown | null,
  availableShells: ReadonlyArray<Shell>,
  /** Optional pre-filled script for the create path (from ScriptFirstCreator). */
  initialScript?: string,
): FormState {
  if (mode === "edit" && command) {
    // For seeds, use the localized labels so the user sees and edits the
    // human-readable values. On save we drop the i18n keys and store the
    // literal strings the user just confirmed. The stored shell is kept
    // verbatim — if it's not installed on this host the dropdown will
    // render it as a disabled option so the user is aware.
    return {
      name: getCommandName(command, t),
      description: getCommandDescription(command, t) ?? "",
      script: command.script,
      shell:
        command.shell ?? pickCreateModeShell(platform, availableShells),
      tags: [...command.tags],
      category: command.categoryId ?? "",
      runAsAdmin: command.runAsAdmin,
      variables: command.variables ? specsToVariableRows(command.variables) : [],
      timeoutSeconds: command.timeoutSeconds !== undefined
        ? String(command.timeoutSeconds)
        : "",
      disableHints: false,
      outputSchema: command.outputSchema,
      envRows: recordToEnvRows(command.env),
      workingDir: command.workingDir ?? "",
      promptWorkingDir: command.promptWorkingDir ?? false,
      // A missing target on the stored command means "local" (the executor
      // default). Carry it verbatim otherwise so an edit preserves the host.
      target: command.target ?? { kind: "local" },
      promptSshPassword: command.promptSshPassword ?? false,
    };
  }
  return {
    name: "",
    description: "",
    // When coming from ScriptFirstCreator, the script is pre-filled.
    script: initialScript ?? "",
    shell: pickCreateModeShell(platform, availableShells),
    tags: [],
    category: "",
    // New commands default to non-elevated. Users can opt-in
    // explicitly with the checkbox.
    runAsAdmin: false,
    variables: [],
    timeoutSeconds: "",
    disableHints: false,
    outputSchema: undefined,
    envRows: [],
    workingDir: "",
    promptWorkingDir: false,
    // New commands run locally by default; the user opts into remote
    // execution explicitly via the "where to run" selector.
    target: { kind: "local" },
    promptSshPassword: false,
  };
}

/**
 * Stable string projection of the form used for dirty detection. Excludes
 * fields that never reach the saved command or are not meaningful for
 * "has the user changed anything":
 *   - `disableHints`: editing-session preference, not persisted.
 *   - per-variable `rowId`: a random React key, not user data.
 *   - per-variable `nameTouched`: a transient interaction flag.
 * Everything else (including variable order and values) participates so a
 * genuine edit is detected. `JSON.stringify` of a fixed-shape object is a
 * cheap, order-stable comparison here.
 */
export function fingerprintForm(form: FormState): string {
  return JSON.stringify({
    name: form.name,
    description: form.description,
    script: form.script,
    shell: form.shell,
    tags: form.tags,
    category: form.category,
    runAsAdmin: form.runAsAdmin,
    timeoutSeconds: form.timeoutSeconds,
    outputSchema: form.outputSchema ?? null,
    variables: form.variables.map((v) => ({
      name: v.name,
      defaultValue: v.defaultValue,
      description: v.description,
      sensitive: v.sensitive,
      promptAtRuntime: v.promptAtRuntime,
    })),
    envRows: form.envRows.map((r) => ({ key: r.key, value: r.value })),
    workingDir: form.workingDir,
    promptWorkingDir: form.promptWorkingDir,
    target: form.target,
    promptSshPassword: form.promptSshPassword,
  });
}
