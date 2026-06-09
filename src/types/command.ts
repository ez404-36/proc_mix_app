import type { OutputSchema } from "./outputSchema";

/**
 * Logical shell name persisted on a `Command`. The Rust executor maps each
 * value to a concrete (program, args) tuple in `shell_invocation`. Each
 * variant spawns its *native* binary — no aliasing between shells:
 *   - "bash"       -> bash -c <script>
 *   - "zsh"        -> zsh -c <script>
 *   - "sh"         -> sh -c <script>
 *   - "fish"       -> fish -c <script>
 *   - "pwsh"       -> pwsh -NoProfile -Command <script>   (PowerShell Core)
 *   - "powershell" -> powershell -NoProfile -Command <script>   (Windows PS 5.1)
 *   - "cmd"        -> cmd /C <script>
 */
export type Shell =
  | "bash"
  | "zsh"
  | "fish"
  | "sh"
  | "pwsh"
  | "powershell"
  | "cmd";

/**
 * A user-declared variable that may be referenced from a command's
 * `script`, `args`, `workingDir`, or `env` values using the `${name}`
 * or `${name:default}` syntax (see the Rust `core::parser` module for
 * the resolution grammar).
 *
 * `defaultValue` semantics — IMPORTANT for the run-time prompt:
 *   - `undefined` (key absent)  → no default; the runner MUST prompt
 *     the user before executing the command, unless a value was
 *     supplied programmatically.
 *   - `""` (empty string)       → empty IS a valid default; the
 *     runner substitutes "" and does NOT prompt.
 *   - non-empty string          → used as the default value.
 *
 * `sensitive` controls how the value is rendered in execution events
 * and logs: the Rust executor substitutes "***" wherever a sensitive
 * value would otherwise appear in a preview field. It does NOT change
 * the substitution applied to the command itself — the child process
 * still receives the real value.
 */
export interface VariableSpec {
  name: string;
  /**
   * Default value used when the runtime is given no explicit value for
   * this variable.
   *
   * Use `undefined` (omit the key) to force a prompt at run time.
   * An empty string `""` is a *valid* default and will NOT trigger a
   * prompt — pass `undefined` if you want the user to be asked.
   */
  defaultValue?: string;
  description?: string;
  sensitive?: boolean;
}

export interface Command {
  id: string;
  name: string;
  /**
   * Optional i18next translation key for the display name. When set, UI code
   * should render `t(nameKey)` instead of `name`. Used by built-in/demo
   * (seed) commands so their labels follow the active language. User-created
   * commands MUST NOT set this — their literal `name` is preserved as typed.
   */
  nameKey?: string;
  description?: string;
  /**
   * Optional i18next translation key for the display description. When set,
   * UI code should render `t(descriptionKey)` instead of `description`.
   * Same rules as `nameKey`: seeds only, never user input.
   */
  descriptionKey?: string;
  icon?: string;
  script: string;
  shell?: Shell;
  args?: string[];
  workingDir?: string;
  /**
   * When true, the runner prompts the user for a working directory before
   * each run, pre-filling the stored `workingDir` value (if any) as the
   * default. Behaves like `VariableSpec.defaultValue === undefined` — a
   * prompt is always shown even when `workingDir` is set.
   */
  promptWorkingDir?: boolean;
  env?: Record<string, string>;
  tags: string[];
  categoryId?: string;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  runCount: number;
  /**
   * When true, this command is spawned with elevated privileges:
   *   - Linux/macOS: via `sudo -S` using the password stored in the
   *     OS keychain. The first elevated run prompts the user for the
   *     password via {@link promptForAdminPassword}; subsequent runs
   *     are silent.
   *   - Windows: via `Start-Process -Verb RunAs`, which triggers the
   *     OS-native UAC dialog. No password is ever stored.
   *
   * Defaults to `false`. The flag is persistent — it applies to every
   * invocation of this command (Library, palette, hotkey, tray, and
   * live-run inside the editor), not just to the form session.
   */
  runAsAdmin: boolean;
  /**
   * Variable specs referenced by `${name}` / `${name:default}` in the
   * `script`, `args`, `workingDir`, or `env` values. Optional —
   * commands without parameterisation omit the field entirely.
   *
   * See {@link VariableSpec} for the prompt-at-runtime semantics.
   */
  variables?: VariableSpec[];
  /**
   * Optional execution timeout in seconds. When set, the Rust executor
   * kills the spawned process after this many seconds have elapsed. The
   * `finished` event carries `timedOut: true` to distinguish a timeout
   * from a normal completion or cancel.
   *
   * `undefined` means no limit. The field is omitted from the wire when
   * absent.
   */
  timeoutSeconds?: number;
  /**
   * Optional declarative description of this command's stdout shape. When
   * set, the Rust `core::extractor` parses stdout after the command
   * finishes and emits a `result` execution event; in a workflow the
   * extracted fields become `${name}` variable values for the next node.
   *
   * `undefined` (omit the key) means no parsing — the command's output is
   * the raw stdout, exactly as before this feature. See
   * {@link OutputSchema}.
   */
  outputSchema?: OutputSchema;
}

/**
 * A single CLI flag extracted from `--help` output by the `parse_utility_flags`
 * Tauri command. Mirrors `core::flag_parser::ParsedFlag` (camelCase).
 */
export interface ParsedFlag {
  /** All aliases for this flag, e.g. `["-v", "--verbose"]`. */
  flags: string[];
  /** `true` when the flag accepts a value (e.g. `--output <FILE>`). */
  takesValue: boolean;
  /** The value placeholder hint, e.g. `"FILE"`, `"DIR"`, `"N"`. Empty when `takesValue` is `false`. */
  valueHint: string;
  /** One-line description extracted from the help text. */
  description: string;
  /** `true` for positional arguments explicitly marked as required. */
  required: boolean;
}

/**
 * A positional (non-flag) argument extracted from a `Usage:` line.
 * Mirrors `core::flag_parser::ParsedArg` (camelCase).
 */
export interface ParsedArg {
  /** Argument name, e.g. `"SOURCE"`, `"DEST"`, `"FILE"`. */
  name: string;
  /** Short description, if available. */
  description: string;
  /** `true` when the argument appeared as `<ARG>` (required) vs `[ARG]` (optional). */
  required: boolean;
}

/**
 * Structured CLI metadata returned by the `parse_utility_flags` Tauri command.
 * Mirrors `core::flag_parser::ParsedCli` (camelCase).
 */
export interface ParsedCli {
  /** Positional arguments in the order they appear in the usage line. */
  positionalArgs: ParsedArg[];
  /** All detected flags / options. */
  flags: ParsedFlag[];
}

export interface CommandCategory {
  id: string;
  name: string;
  color?: string;
  icon?: string;
}

export interface CommandTag {
  id: string;
  name: string;
  color?: string;
}

/**
 * Whether the CLI help for a probed utility was found. Mirrors the Rust
 * `UtilityHelpStatus` enum on the wire (`#[serde(rename_all =
 * "kebab-case")]`), so the literals are kebab-case, not the TS-idiomatic
 * camelCase.
 */
export type UtilityHelpStatus = "found" | "not-found";

/**
 * Which probe produced the help text. Mirrors the Rust `HelpSource`
 * enum on the wire:
 *   - "help"        -> `<utility> --help`
 *   - "short-help"  -> `<utility> -h`
 *   - "man"         -> `man -P cat -- <utility>` (Unix only)
 */
export type HelpSource = "help" | "short-help" | "man";

/**
 * Result of a best-effort CLI-help fetch for a single utility, returned
 * by the `fetch_utility_help` Tauri command. Mirrors the Rust
 * `core::utility_help::UtilityHelp` struct exactly (camelCase fields).
 *
 * When `status` is `"not-found"` the `source` and `text` fields are
 * `null` — an absent / unrecognised utility is a normal outcome, not an
 * IPC error.
 */
export interface UtilityHelp {
  /** The utility name that was probed, echoed back for labelling. */
  utility: string;
  status: UtilityHelpStatus;
  /** Which probe succeeded; `null` when `status === "not-found"`. */
  source: HelpSource | null;
  /** The (possibly truncated) help text; `null` when not found. */
  text: string | null;
  /** True when `text` was clipped to the backend's byte cap. */
  truncated: boolean;
}

export type View =
  | "home"
  | "library"
  | "scheduler"
  | "scheduler-editor"
  | "editor"
  | "command-editor"
  | "history"
  | "recorder"
  | "settings"
  | "env";

/**
 * Target for the full-screen command editor view (`command-editor`).
 * `mode` discriminates create vs. edit; `commandId` is the existing
 * `Command.id` to edit, or `null` when creating. We store the id (not the
 * whole command) so the editor view always resolves the freshest version
 * from the store — mirrors the `editorWorkflowId` contract for workflows.
 *
 * `initialScript` may be set when navigating into create mode from the
 * script-first creator flow (ScriptFirstCreator). When present, the form
 * is pre-filled with this value. Ignored in edit mode.
 */
export interface CommandEditorTarget {
  mode: "create" | "edit";
  commandId: string | null;
  /** Pre-fill the Script field when entering create mode via ScriptFirstCreator. */
  initialScript?: string;
}

/** Active tab within the Library view: commands or workflows. */
export type LibraryTab = "commands" | "workflows";

export type Theme = "light" | "dark" | "system";

export type ResolvedTheme = "light" | "dark";
