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
import {
  makeEnumGuard,
  nullToUndef,
  undefToNull,
} from "./repositoryHelpers";

const isTargetKind = makeEnumGuard<ScheduleTargetKind>(["command", "workflow"]);

const isRunStatus = makeEnumGuard<ScheduleRunStatus>([
  "success",
  "error",
  "cancelled",
  "missingVariable",
  "skipped",
]);

function toRunStatus(value: string | null): ScheduleRunStatus | undefined {
  if (value === null) return undefined;
  return isRunStatus(value) ? value : undefined;
}

const isCatchUpPolicy = makeEnumGuard<CatchUpPolicy>(["none", "once", "all"]);

/** Narrow a free-form policy string; an unknown value falls back to "none". */
function toCatchUpPolicy(value: string): CatchUpPolicy {
  return isCatchUpPolicy(value) ? value : "none";
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
    timeoutSeconds: undefToNull(s.timeoutSeconds),
    maxRetries: s.maxRetries,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    lastRunAt: undefToNull(s.lastRunAt),
    lastRunStatus: undefToNull(s.lastRunStatus),
    nextRunAt: undefToNull(s.nextRunAt),
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
    timeoutSeconds: nullToUndef(r.timeoutSeconds),
    maxRetries: r.maxRetries,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastRunAt: nullToUndef(r.lastRunAt),
    lastRunStatus: toRunStatus(r.lastRunStatus),
    nextRunAt: nullToUndef(r.nextRunAt),
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
