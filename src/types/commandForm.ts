export type RunStatus =
  | 'idle'
  | 'running'
  | 'finished'
  | 'failed'
  | 'cancelled'
  | 'timedOut';

export interface RunLine {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface RunResult {
  status: RunStatus;
  lines: RunLine[];
  exitCode: number | null;
  durationMs: number | null;
  timedOut: boolean;
}

export interface VariableRow {
  rowId: string;
  name: string;
  defaultValue: string;
  description: string;
  sensitive: boolean;
  promptAtRuntime: boolean;
  nameTouched: boolean;
}

/**
 * A single row in the Env tab of the command form, representing one
 * KEY=VALUE environment variable override for the command.
 */
export interface EnvRow {
  /** Stable React key — a random UUID generated once per row lifetime. */
  rowId: string;
  key: string;
  value: string;
}

/**
 * The command form's tabs. `main` holds metadata + execution settings,
 * `script` the script editor and variables, `output` the output schema,
 * `env` the per-command environment variable overrides, `explorer` the OS
 * file-manager context-menu integration settings.
 */
export type FormTab = 'main' | 'script' | 'output' | 'env' | 'explorer';

export interface FormErrors {
  name?: string;
  script?: string;
  /** Set when the API slug is malformed or collides with another command. */
  apiSlug?: string;
}

export interface FormState {
  name: string;
  description: string;
  script: string;
  shell: import('./command').Shell;
  tags: string[];
  category: string;
  runAsAdmin: boolean;
  variables: VariableRow[];
  timeoutSeconds: string;
  disableHints: boolean;
  outputSchema: import('./outputSchema').OutputSchema | undefined;
  /** Per-command environment variable overrides (KEY=VALUE rows). */
  envRows: EnvRow[];
  /** Working directory for the command. Empty string means use the default (home dir). */
  workingDir: string;
  /** When true, the runner will prompt the user for the working directory before each run. */
  promptWorkingDir: boolean;
  /**
   * Where the command runs. `{ kind: 'local' }` (the default) runs on this
   * machine; `{ kind: 'remote', alias }` runs over SSH on the given host;
   * `{ kind: 'remotePrompt' }` asks for the host at run time. See
   * {@link import('./command').ExecutionTarget}.
   */
  target: import('./command').ExecutionTarget;
  /**
   * When true, prompt for a one-shot SSH password before each remote run.
   * Only meaningful when `target` is remote; persisted as
   * `Command.promptSshPassword`.
   */
  promptSshPassword: boolean;
  /**
   * When true, this command may be run over the built-in HTTP API. Persisted
   * as `Command.apiEnabled`.
   */
  apiEnabled: boolean;
  /**
   * Optional HTTP-API slug. Empty string means "no slug" (the API can still
   * address the command by id). Persisted as `Command.apiSlug`.
   */
  apiSlug: string;
  /**
   * When true, this command appears in the OS file-manager ("Explorer") context
   * menu (independent of `favorite`). Persisted as `Command.explorerEnabled`.
   */
  explorerEnabled: boolean;
  /**
   * Name of the command variable that receives the right-clicked path when
   * launched from the Explorer menu. Empty string means "don't substitute into
   * a variable" (the path is still exposed via `PROCMIX_SELECTED_PATH`).
   * Persisted as `Command.explorerPathVariable`.
   */
  explorerPathVariable: string;
}
