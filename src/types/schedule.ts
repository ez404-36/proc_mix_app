// Schedule data model — a cron-driven automatic run of a command or workflow.
//
// Mirrors the Rust `ScheduleRecord` (see `src-tauri/src/storage/schedules.rs`).
// The repository layer (`utils/scheduleRepository.ts`) owns the `null <->
// undefined` translation against the wire format, exactly like
// `workflowRepository` does for `Workflow`. UI code only ever sees `Schedule`.
//
// `variableValues` is polymorphic by `targetKind`:
//   - command  → a flat map of `${name}` -> value.
//   - workflow → a map of nodeId -> (`${name}` -> value).
// Both shapes are captured AT CREATION because a background fire cannot
// prompt. The {@link isWorkflowVariableValues} guard narrows the union at the
// (rare) sites that need to read inside it.

import type { ScheduleTargetKind } from "./history";

export type { ScheduleTargetKind } from "./history";

/** Flat variable values for a command target: `${name}` -> value. */
export type CommandVariableValues = Record<string, string>;

/** Nested variable values for a workflow target: nodeId -> (`${name}` -> value). */
export type WorkflowVariableValues = Record<string, Record<string, string>>;

/**
 * Per-run variable values captured at creation. The concrete shape depends on
 * the schedule's `targetKind` — use {@link isWorkflowVariableValues} /
 * {@link isCommandVariableValues} with the discriminator to narrow it.
 */
export type ScheduleVariableValues =
  | CommandVariableValues
  | WorkflowVariableValues;

/**
 * Outcome of the most recent fire. Superset of the streaming executor's
 * statuses — the scheduler distinguishes more cases. Mirrors the backend
 * `ScheduledRunStatus`.
 */
export type ScheduleRunStatus =
  | "success"
  | "error"
  | "cancelled"
  | "missingVariable"
  | "skipped";

/**
 * What to do with fire times that elapsed while the app was closed:
 *   - `none`: skip them (default);
 *   - `once`: run a single catch-up if any were missed;
 *   - `all`: run one catch-up per missed occurrence (capped server-side).
 */
export type CatchUpPolicy = "none" | "once" | "all";

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  targetKind: ScheduleTargetKind;
  /** Logical id of the target command / workflow. */
  targetId: string;
  /** 5-field Unix cron expression, evaluated in local time. */
  cron: string;
  variableValues: ScheduleVariableValues;
  /** Suppress a fire when the previous run of this schedule is still active. */
  skipIfRunning: boolean;
  /**
   * Persist the run's console output (and extracted result, if any) into the
   * schedule's history. Default `true`. Capture is commands-only in v1 —
   * workflow targets record no output regardless of this flag.
   */
  captureOutput: boolean;
  /** How to handle fire times missed while the app was closed. */
  catchUpPolicy: CatchUpPolicy;
  /**
   * Optional per-run timeout (seconds) for a command target, overriding the
   * command's own timeout. `undefined` keeps the command's timeout (or none).
   */
  timeoutSeconds?: number;
  /** Times to re-run the target after a failed attempt (0 = no retries). */
  maxRetries: number;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunStatus?: ScheduleRunStatus;
  /** Cached next fire time (ISO 8601, local) for display. */
  nextRunAt?: string;
  runCount: number;
}

/**
 * Narrow `variableValues` to the workflow (nested) shape. We discriminate on
 * the schedule's `targetKind` rather than inspecting the value, because an
 * empty object `{}` is ambiguous between the two shapes.
 */
export function isWorkflowVariableValues(
  schedule: Schedule,
): schedule is Schedule & { variableValues: WorkflowVariableValues } {
  return schedule.targetKind === "workflow";
}

/** Narrow `variableValues` to the command (flat) shape. */
export function isCommandVariableValues(
  schedule: Schedule,
): schedule is Schedule & { variableValues: CommandVariableValues } {
  return schedule.targetKind === "command";
}

/**
 * Target for the full-screen schedule editor view (`scheduler-editor`).
 * `mode` discriminates create vs. edit; `scheduleId` is the existing
 * `Schedule.id` to edit, or `null` when creating. We store the id (not the
 * whole schedule) so the editor view always resolves the freshest version
 * from the store — mirrors the `commandEditorTarget` contract for commands.
 */
export interface ScheduleEditorTarget {
  mode: "create" | "edit";
  scheduleId: string | null;
}

/** Input accepted when creating a new schedule — the store fills the rest. */
export interface NewScheduleInput {
  name: string;
  targetKind: ScheduleTargetKind;
  targetId: string;
  cron: string;
  variableValues: ScheduleVariableValues;
  skipIfRunning: boolean;
  captureOutput: boolean;
  catchUpPolicy: CatchUpPolicy;
  timeoutSeconds?: number;
  maxRetries: number;
  enabled: boolean;
}
