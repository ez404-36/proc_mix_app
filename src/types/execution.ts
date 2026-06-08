export type ExecutionEventKind =
  | "started"
  | "stdout"
  | "stderr"
  | "result"
  | "finished"
  | "error"
  | "cancelled";

export interface ExecutionEventBase {
  kind: ExecutionEventKind;
  executionId: string;
  /**
   * Set by the Rust workflow runner when this execution is a node within a
   * workflow run; carries that run's id. The execution bridge routes such
   * events into the single aggregated workflow process keyed by this id
   * instead of creating a standalone terminal entry. Absent (and omitted
   * from the wire) for every direct command run.
   */
  workflowRunId?: string;
}

export interface StartedEvent extends ExecutionEventBase {
  kind: "started";
  pid?: number;
  commandId?: string;
  /**
   * Resolved variables (sensitive values pre-masked to "***") the run was
   * started with. Carried on the event so a run the frontend did NOT
   * initiate — a scheduled fire or a workflow node — can show its variable
   * values in the console exactly like a direct library run (which captures
   * them via {@link triggerCommandRun} at pre-registration). Omitted from
   * the wire for commands without variables.
   */
  variables?: ExecutionVariable[];
}

export interface StdoutEvent extends ExecutionEventBase {
  kind: "stdout";
  line: string;
}

export interface StderrEvent extends ExecutionEventBase {
  kind: "stderr";
  line: string;
}

export interface FinishedEvent extends ExecutionEventBase {
  kind: "finished";
  exitCode: number | null;
  durationMs: number;
  commandId?: string;
  timedOut?: boolean;
}

export interface ErrorEvent extends ExecutionEventBase {
  kind: "error";
  message: string;
  commandId?: string;
}

export interface CancelledEvent extends ExecutionEventBase {
  kind: "cancelled";
  commandId?: string;
}

/**
 * Structured output extraction for a single run, produced by the Rust
 * `core::extractor` when the command declared an `outputSchema`. `fields`
 * maps each schema field name to its extracted JSON value; `returnValue`
 * is the chosen return value. `error` is set (and `fields`/`returnValue`
 * are empty) when extraction failed — the command itself still ran.
 *
 * Values are arbitrary JSON, so they are typed `unknown`; consumers must
 * narrow before use (e.g. render via a JSON tree).
 */
export interface ExtractedResult {
  fields: Record<string, unknown>;
  returnValue: unknown;
  error?: string;
}

/**
 * Emitted only for runs whose command declared an output schema. Arrives
 * AFTER all stdout/stderr events for the run and BEFORE the terminal
 * `finished` event (a deterministic ordering the bridge relies on to
 * attach the result before marking the execution done).
 */
export interface ResultEvent extends ExecutionEventBase {
  kind: "result";
  commandId?: string;
  fields: Record<string, unknown>;
  returnValue: unknown;
  error?: string;
}

export type ExecutionEvent =
  | StartedEvent
  | StdoutEvent
  | StderrEvent
  | ResultEvent
  | FinishedEvent
  | ErrorEvent
  | CancelledEvent;

export type ExecutionStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "cancelled";

/**
 * Stream a log line belongs to:
 *   - "stdout" / "stderr" → real child output.
 *   - "meta" → an app-injected separator line (not from any child), used by
 *     the aggregated workflow process to delimit each step with a header
 *     (e.g. "▸ Build") and an exit trailer. Rendered with a distinct,
 *     subtle style by the OutputPanel.
 */
export type ExecutionLogStream = "stdout" | "stderr" | "meta";

export interface ExecutionLogLine {
  stream: ExecutionLogStream;
  line: string;
  ts: number;
}

/**
 * A single resolved variable for a run, captured at execution start so the
 * OutputPanel can show the user what values the command actually ran with.
 * `value` is already display-ready: values for specs flagged `sensitive`
 * are masked to "***" by the producer (`triggerCommandRun`), so consumers
 * MUST NOT reconstruct the raw value from this field.
 */
export interface ExecutionVariable {
  name: string;
  value: string;
  sensitive: boolean;
}

export interface Execution {
  id: string;
  commandId?: string;
  commandName: string;
  /**
   * Marks this as the aggregated process for a whole workflow run (its `id`
   * is the workflow `run_id`). Drives panel behavior: the Cancel button
   * cancels the WORKFLOW (not a single command execution), and the Re-run
   * button is hidden because a workflow has no single source command. A
   * plain command execution leaves this unset.
   */
  isWorkflow?: boolean;
  /**
   * The script source that was sent to Rust for execution. Captured at
   * execution start so the OutputPanel can show the user the exact code that
   * is running — not just the command's display name.
   */
  script?: string;
  /**
   * The shell used to run the script (e.g. "bash", "pwsh"). Optional because
   * Rust resolves a platform default when the command does not specify one;
   * in that case we render a generic "shell" label.
   */
  shell?: string;
  status: ExecutionStatus;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  durationMs?: number;
  /**
   * Resolved variable values this run was started with, captured so the
   * OutputPanel can show them alongside the script. Absent for commands
   * without variables. Sensitive values are pre-masked — see
   * {@link ExecutionVariable}.
   */
  variables?: ExecutionVariable[];
  /**
   * Per-command environment variable overrides active for this run.
   * Absent when the command has no env overrides. Displayed in the
   * OutputPanel alongside the script and resolved variables.
   */
  env?: Record<string, string>;
  log: ExecutionLogLine[];
  error?: string;
  timedOut?: boolean;
  /**
   * Structured output extraction for this run, set when the command
   * declared an `outputSchema` and a `result` event arrived. Drives the
   * OutputPanel "Result" tab. Absent for commands without a schema.
   */
  result?: ExtractedResult;
}
