// IPC wrapper around the Rust-side `schedules` table.
//
// The Rust handlers (`list_schedules`, `upsert_schedule`, `delete_schedule`,
// `set_schedule_enabled`, `preview_next_runs`) speak `ScheduleRecord`, a
// wire-format struct that uses `null` for absent optional fields. The TS
// `Schedule` type uses `undefined`, so this module owns the `null <->
// undefined` translation as a single boundary — exactly like
// `workflowRepository` does for `Workflow`. UI code only ever sees `Schedule`.
//
// Schedules are deliberately NOT part of export/import — there is no
// corresponding entry in the export bundle and `importData` never touches
// them (see `dataImport.ts`).

import { invoke } from "@tauri-apps/api/core";
import type {
  CatchUpPolicy,
  Schedule,
  ScheduleRunStatus,
  ScheduleTargetKind,
  ScheduleVariableValues,
} from "../types";

const KNOWN_TARGET_KINDS: ReadonlySet<ScheduleTargetKind> =
  new Set<ScheduleTargetKind>(["command", "workflow"]);

function isTargetKind(value: string): value is ScheduleTargetKind {
  return KNOWN_TARGET_KINDS.has(value as ScheduleTargetKind);
}

const KNOWN_RUN_STATUSES: ReadonlySet<ScheduleRunStatus> =
  new Set<ScheduleRunStatus>([
    "success",
    "error",
    "cancelled",
    "missingVariable",
    "skipped",
  ]);

function toRunStatus(value: string | null): ScheduleRunStatus | undefined {
  if (value === null) return undefined;
  return KNOWN_RUN_STATUSES.has(value as ScheduleRunStatus)
    ? (value as ScheduleRunStatus)
    : undefined;
}

const KNOWN_CATCH_UP_POLICIES: ReadonlySet<CatchUpPolicy> =
  new Set<CatchUpPolicy>(["none", "once", "all"]);

/** Narrow a free-form policy string; an unknown value falls back to "none". */
function toCatchUpPolicy(value: string): CatchUpPolicy {
  return KNOWN_CATCH_UP_POLICIES.has(value as CatchUpPolicy)
    ? (value as CatchUpPolicy)
    : "none";
}

/**
 * Wire format matching the Rust `ScheduleRecord`. Optional fields are
 * `T | null` because serde serialises `Option::None` as JSON `null`.
 * `variableValues` is an opaque JSON object the backend round-trips
 * unchanged; its shape is validated by the form, not here.
 */
export interface ScheduleRecord {
  id: string;
  name: string;
  enabled: boolean;
  targetKind: string;
  targetId: string;
  cron: string;
  variableValues: ScheduleVariableValues;
  skipIfRunning: boolean;
  captureOutput: boolean;
  catchUpPolicy: string;
  timeoutSeconds: number | null;
  maxRetries: number;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  nextRunAt: string | null;
  runCount: number;
}

/** Convert a UI `Schedule` into the wire-format record sent to Rust. */
export function scheduleToRecord(s: Schedule): ScheduleRecord {
  return {
    id: s.id,
    name: s.name,
    enabled: s.enabled,
    targetKind: s.targetKind,
    targetId: s.targetId,
    cron: s.cron,
    variableValues: s.variableValues,
    skipIfRunning: s.skipIfRunning,
    captureOutput: s.captureOutput,
    catchUpPolicy: s.catchUpPolicy,
    timeoutSeconds: s.timeoutSeconds ?? null,
    maxRetries: s.maxRetries,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    lastRunAt: s.lastRunAt ?? null,
    lastRunStatus: s.lastRunStatus ?? null,
    nextRunAt: s.nextRunAt ?? null,
    runCount: s.runCount,
  };
}

/**
 * Decode a wire-format record into a UI `Schedule`. Null collapses to
 * `undefined`; an unknown `targetKind` falls back to `"command"` so a
 * hand-edited row never crashes the decoder.
 */
export function recordToSchedule(r: ScheduleRecord): Schedule {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    targetKind: isTargetKind(r.targetKind) ? r.targetKind : "command",
    targetId: r.targetId,
    cron: r.cron,
    variableValues: r.variableValues,
    skipIfRunning: r.skipIfRunning,
    captureOutput: r.captureOutput,
    catchUpPolicy: toCatchUpPolicy(r.catchUpPolicy),
    timeoutSeconds: r.timeoutSeconds ?? undefined,
    maxRetries: r.maxRetries,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastRunAt: r.lastRunAt ?? undefined,
    lastRunStatus: toRunStatus(r.lastRunStatus),
    nextRunAt: r.nextRunAt ?? undefined,
    runCount: r.runCount,
  };
}

/** Load every persisted schedule from SQLite, oldest first. */
export async function listSchedulesFromDb(): Promise<Schedule[]> {
  const records = await invoke<ScheduleRecord[]>("list_schedules");
  return records.map(recordToSchedule);
}

/** Insert-or-update a single schedule. */
export async function upsertScheduleInDb(schedule: Schedule): Promise<void> {
  await invoke("upsert_schedule", { schedule: scheduleToRecord(schedule) });
}

/** Remove a schedule by id. Idempotent — missing ids are not an error. */
export async function deleteScheduleInDb(id: string): Promise<void> {
  await invoke("delete_schedule", { id });
}

/** Toggle a schedule's enabled flag, stamping a fresh `updatedAt`. */
export async function setScheduleEnabledInDb(
  id: string,
  enabled: boolean,
): Promise<void> {
  await invoke("set_schedule_enabled", {
    id,
    enabled,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Manually fire a schedule's target NOW, out of band. Records a history entry
 * but does NOT change the schedule's stats or next-run time (the cron timing
 * is unaffected).
 */
export async function runScheduleNowInDb(id: string): Promise<void> {
  await invoke("run_schedule_now", { id });
}

/**
 * Preview the next `count` fire times for a cron expression WITHOUT saving.
 * Returns RFC 3339 local-time strings. Rejects with `"INVALID_CRON"` when the
 * expression does not parse.
 */
export async function previewNextRuns(
  cron: string,
  count: number,
): Promise<string[]> {
  return invoke<string[]>("preview_next_runs", { cron, count });
}
