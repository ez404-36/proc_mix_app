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
}
