// IPC wrapper around the Rust-side history table.
//
// The Rust handlers (`list_history`, `get_history_event`,
// `record_history_event`, `update_run_history_event`,
// `delete_history_event`, `clear_history`) speak `HistoryEvent`, whose
// snapshot fields are `CommandRecord` — the wire shape using `null`
// for absent optionals. The TS UI works with `Command` (which uses
// `undefined`), so this module owns the `null <-> undefined`
// translation for the embedded snapshots. UI code only ever sees the
// `HistoryEvent` discriminated union from `types/history.ts`.
//
// Pure functions are exported so they can be unit-tested without
// running through `invoke`.
import { invoke } from "@tauri-apps/api/core";
import type {
  Command,
  ExecutionLogLine,
  ExtractedResult,
  HistoryEvent,
  HistoryFilter,
  HistoryLogLine,
  HistoryPage,
  RunStatus,
  ScheduledRunStatus,
  ScheduleTargetKind,
  SshHostAddedEvent,
  SshHostDiscoveredEvent,
  SshHostEditedEvent,
  SshHostEditedExternallyEvent,
  SshHostDeletedEvent,
  SshHostDeletedExternallyEvent,
} from "../types";
import {
  type CommandRecord,
  commandToRecord,
  recordToCommand,
} from "./commandRepository";
import {
  type WorkflowRecord,
  recordToWorkflow,
  workflowToRecord,
} from "./workflowRepository";
import { nullToUndef, omitWhenUndefined } from "./repositoryHelpers";

// Re-export so tests (and the rare consumer that needs the wire shape
// of a snapshot, e.g. eventToWire callers building a payload by hand)
// can reach the type without dual-importing from the entity repositories.
export type { CommandRecord, WorkflowRecord };

const SCHEDULED_RUN_STATUSES: ReadonlySet<ScheduledRunStatus> =
  new Set<ScheduledRunStatus>([
    "success",
    "error",
    "cancelled",
    "missingVariable",
    "skipped",
  ]);

/** Narrow a free-form scheduler status string; unknown values map to "error". */
function toScheduledRunStatus(value: string): ScheduledRunStatus {
  return SCHEDULED_RUN_STATUSES.has(value as ScheduledRunStatus)
    ? (value as ScheduledRunStatus)
    : "error";
}

/** Narrow a target-kind string; unknown values map to "command". */
function toScheduleTargetKind(value: string): ScheduleTargetKind {
  return value === "workflow" ? "workflow" : "command";
}

/**
 * Wire-format shape of a `HistoryEvent`. The discriminator (`kind`)
 * sits at the top level and the snapshot fields are `CommandRecord`
 * (null-for-absent), exactly mirroring the Rust `HistoryEvent`. We
 * use intersection-typed unions for the kind-specific variants so
 * the conversion functions below get full type-narrowing.
 */
type WireBase = {
  id: string;
  createdAt: string;
};

type WireCreated = WireBase & {
  kind: "commandCreated";
  commandId: string;
  commandName: string;
  snapshotAfter: CommandRecord;
};

type WireEdited = WireBase & {
  kind: "commandEdited";
  commandId: string;
  commandName: string;
  snapshotBefore: CommandRecord;
  snapshotAfter: CommandRecord;
};

type WireDeleted = WireBase & {
  kind: "commandDeleted";
  commandId: string;
  commandName: string;
  snapshotBefore: CommandRecord;
};

type WireRun = WireBase & {
  kind: "commandRun";
  commandId: string;
  commandName: string;
  executionId: string;
  // Rust uses `skip_serializing_if = "Option::is_none"` so the field
  // is *absent* when the run is still running, NOT serialised as
  // `null`. The JS side handles both `undefined` (absent) and
  // `null` (defensive) shapes — see {@link wireToEvent}.
  exitCode?: number | null;
  durationMs?: number | null;
  status: RunStatus;
  // Where the run executed. Absent (Rust `skip_serializing_if`) for a local
  // run; `{ kind: 'remote', alias }` for a remote run. `| null` defensive.
  target?: import("../types").ExecutionTarget | null;
  // Absent (not `null`) unless the run was killed by its timeout.
  timedOut?: boolean | null;
  // Persisted by `update_run_event` on completion; absent while running and
  // for rows recorded before output persistence existed. `| null` defensive.
  output?: HistoryLogLine[] | null;
  result?: ExtractedResult | null;
};

type WireRestored = WireBase & {
  kind: "commandRestored";
  commandId: string;
  commandName: string;
  originalEventId: string;
};

type WireReverted = WireBase & {
  kind: "commandReverted";
  commandId: string;
  commandName: string;
  originalEventId: string;
};

type WireWorkflowCreated = WireBase & {
  kind: "workflowCreated";
  workflowId: string;
  workflowName: string;
  snapshotAfter: WorkflowRecord;
};

type WireWorkflowEdited = WireBase & {
  kind: "workflowEdited";
  workflowId: string;
  workflowName: string;
  snapshotBefore: WorkflowRecord;
  snapshotAfter: WorkflowRecord;
};

type WireWorkflowDeleted = WireBase & {
  kind: "workflowDeleted";
  workflowId: string;
  workflowName: string;
  snapshotBefore: WorkflowRecord;
};

type WireWorkflowRun = WireBase & {
  kind: "workflowRun";
  workflowId: string;
  workflowName: string;
  executionId: string;
  // Rust uses `skip_serializing_if = "Option::is_none"` so the field is
  // *absent* while running, NOT serialised as `null`. Handle both shapes.
  exitCode?: number | null;
  durationMs?: number | null;
  status: RunStatus;
  timedOut?: boolean | null;
  // Aggregate captured output / result, persisted on completion. Absent while
  // running and for pre-persistence rows. `| null` defensive.
  output?: HistoryLogLine[] | null;
  result?: ExtractedResult | null;
};

type WireScheduledRun = WireBase & {
  kind: "scheduledRun";
  scheduleId: string;
  scheduleName: string;
  targetKind: string;
  targetId: string;
  // `true` for a manual "Run now" fire, absent (Rust skips `false`) for an
  // automatic cron / catch-up fire. Collapsed to a concrete boolean in
  // wireToEvent.
  manual?: boolean | null;
  // Free-form scheduler status string (success / error / missingVariable /
  // skipped / cancelled). Narrowed to `ScheduledRunStatus` in wireToEvent.
  status: string;
  // Rust uses `skip_serializing_if = "Option::is_none"` so these are *absent*
  // (not `null`) when no output was captured. `| null` is defensive.
  exitCode?: number | null;
  durationMs?: number | null;
  output?: HistoryLogLine[] | null;
  result?: ExtractedResult | null;
};

export type WireHistoryEvent =
  | WireCreated
  | WireEdited
  | WireDeleted
  | WireRun
  | WireRestored
  | WireReverted
  | WireWorkflowCreated
  | WireWorkflowEdited
  | WireWorkflowDeleted
  | WireWorkflowRun
  | WireScheduledRun
  // SSH events carry plain snapshots whose wire shape matches the UI shape
  // (no Command/Workflow-record conversion), so we reuse the UI event types
  // directly on the wire.
  | SshHostAddedEvent
  | SshHostDiscoveredEvent
  | SshHostEditedEvent
  | SshHostEditedExternallyEvent
  | SshHostDeletedEvent
  | SshHostDeletedExternallyEvent;

interface WireHistoryPage {
  items: WireHistoryEvent[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Convert a wire-format event to the UI-facing `HistoryEvent`.
 * Embedded snapshots go through `recordToCommand` so the rest of the
 * UI sees uniformly-undefined optionals.
 */
export function wireToEvent(w: WireHistoryEvent): HistoryEvent {
  switch (w.kind) {
    case "commandCreated":
      return {
        id: w.id,
        createdAt: w.createdAt,
        kind: w.kind,
        commandId: w.commandId,
        commandName: w.commandName,
        snapshotAfter: recordToCommand(w.snapshotAfter),
      };
    case "commandEdited":
      return {
        id: w.id,
        createdAt: w.createdAt,
        kind: w.kind,
        commandId: w.commandId,
        commandName: w.commandName,
        snapshotBefore: recordToCommand(w.snapshotBefore),
        snapshotAfter: recordToCommand(w.snapshotAfter),
      };
    case "commandDeleted":
      return {
        id: w.id,
        createdAt: w.createdAt,
        kind: w.kind,
        commandId: w.commandId,
        commandName: w.commandName,
        snapshotBefore: recordToCommand(w.snapshotBefore),
      };
    case "commandRun":
      return {
        id: w.id,
        createdAt: w.createdAt,
        kind: w.kind,
        commandId: w.commandId,
        commandName: w.commandName,
        executionId: w.executionId,
        // Collapse `null` (defensive) and `undefined` (Rust's
        // `skip_serializing_if`) to a single `undefined` so the UI
        // can check `event.exitCode === undefined` reliably.
        exitCode: nullToUndef(w.exitCode),
        durationMs: nullToUndef(w.durationMs),
        status: w.status,
        target: nullToUndef(w.target),
        timedOut: nullToUndef(w.timedOut),
        output: nullToUndef(w.output),
        result: nullToUndef(w.result),
      };
    case "commandRestored":
      return {
        id: w.id,
        createdAt: w.createdAt,
        kind: w.kind,
        commandId: w.commandId,
        commandName: w.commandName,
        originalEventId: w.originalEventId,
      };
    case "commandReverted":
      return {
        id: w.id,
        createdAt: w.createdAt,
        kind: w.kind,
        commandId: w.commandId,
        commandName: w.commandName,
        originalEventId: w.originalEventId,
      };
    case "workflowCreated":
      return {
        id: w.id,
        createdAt: w.createdAt,
        kind: w.kind,
        workflowId: w.workflowId,
        workflowName: w.workflowName,
        snapshotAfter: recordToWorkflow(w.snapshotAfter),
      };
    case "workflowEdited":
      return {
        id: w.id,
        createdAt: w.createdAt,
        kind: w.kind,
        workflowId: w.workflowId,
        workflowName: w.workflowName,
        snapshotBefore: recordToWorkflow(w.snapshotBefore),
        snapshotAfter: recordToWorkflow(w.snapshotAfter),
      };
    case "workflowDeleted":
      return {
        id: w.id,
        createdAt: w.createdAt,
        kind: w.kind,
        workflowId: w.workflowId,
        workflowName: w.workflowName,
        snapshotBefore: recordToWorkflow(w.snapshotBefore),
      };
    case "workflowRun":
      return {
        id: w.id,
        createdAt: w.createdAt,
        kind: w.kind,
        workflowId: w.workflowId,
        workflowName: w.workflowName,
        executionId: w.executionId,
        exitCode: nullToUndef(w.exitCode),
        durationMs: nullToUndef(w.durationMs),
        status: w.status,
        timedOut: nullToUndef(w.timedOut),
        output: nullToUndef(w.output),
        result: nullToUndef(w.result),
      };
    case "scheduledRun":
      return {
        id: w.id,
        createdAt: w.createdAt,
        kind: w.kind,
        scheduleId: w.scheduleId,
        scheduleName: w.scheduleName,
        targetKind: toScheduleTargetKind(w.targetKind),
        targetId: w.targetId,
        // Rust omits `manual` when `false`; a missing/`null` value is an
        // automatic fire.
        manual: w.manual === true,
        status: toScheduledRunStatus(w.status),
        // Collapse `null` (defensive) / `undefined` (Rust skip) to `undefined`.
        exitCode: nullToUndef(w.exitCode),
        durationMs: nullToUndef(w.durationMs),
        output: nullToUndef(w.output),
        result: nullToUndef(w.result),
      };
    case "sshHostAdded":
    case "sshHostDiscovered":
    case "sshHostEdited":
    case "sshHostEditedExternally":
    case "sshHostDeleted":
    case "sshHostDeletedExternally":
      // Wire shape equals UI shape (plain snapshots, `null` optionals match);
      // pass through unchanged.
      return w;
  }
}

/**
 * Convert a UI-facing `HistoryEvent` to the wire-format shape sent
 * to Rust. The embedded snapshots go through `commandToRecord` so
 * `undefined` optionals collapse to `null` as the Rust serde
 * `Option<T>` expects.
 *
 * Only `commandCreated`, `commandEdited`, `commandDeleted` and
 * `commandRun` are produced by the frontend (via `commandActions` and
 * `triggerCommandRun`). `commandRestored` and `commandReverted` are
 * also written by the frontend after a successful undo / restore.
 */
export function eventToWire(e: HistoryEvent): WireHistoryEvent {
  switch (e.kind) {
    case "commandCreated":
      return {
        id: e.id,
        createdAt: e.createdAt,
        kind: e.kind,
        commandId: e.commandId,
        commandName: e.commandName,
        snapshotAfter: commandToRecord(e.snapshotAfter),
      };
    case "commandEdited":
      return {
        id: e.id,
        createdAt: e.createdAt,
        kind: e.kind,
        commandId: e.commandId,
        commandName: e.commandName,
        snapshotBefore: commandToRecord(e.snapshotBefore),
        snapshotAfter: commandToRecord(e.snapshotAfter),
      };
    case "commandDeleted":
      return {
        id: e.id,
        createdAt: e.createdAt,
        kind: e.kind,
        commandId: e.commandId,
        commandName: e.commandName,
        snapshotBefore: commandToRecord(e.snapshotBefore),
      };
    case "commandRun":
      return {
        id: e.id,
        createdAt: e.createdAt,
        kind: e.kind,
        commandId: e.commandId,
        commandName: e.commandName,
        executionId: e.executionId,
        // Send `undefined` (key omitted) when the value is absent,
        // mirroring Rust's `skip_serializing_if`. JSON.stringify drops
        // `undefined` keys, so the on-wire shape matches exactly.
        ...omitWhenUndefined("exitCode", e.exitCode),
        ...omitWhenUndefined("durationMs", e.durationMs),
        status: e.status,
        ...omitWhenUndefined("target", e.target),
        ...omitWhenUndefined("timedOut", e.timedOut),
        ...omitWhenUndefined("output", e.output),
        ...omitWhenUndefined("result", e.result),
      };
    case "commandRestored":
      return {
        id: e.id,
        createdAt: e.createdAt,
        kind: e.kind,
        commandId: e.commandId,
        commandName: e.commandName,
        originalEventId: e.originalEventId,
      };
    case "commandReverted":
      return {
        id: e.id,
        createdAt: e.createdAt,
        kind: e.kind,
        commandId: e.commandId,
        commandName: e.commandName,
        originalEventId: e.originalEventId,
      };
    case "workflowCreated":
      return {
        id: e.id,
        createdAt: e.createdAt,
        kind: e.kind,
        workflowId: e.workflowId,
        workflowName: e.workflowName,
        snapshotAfter: workflowToRecord(e.snapshotAfter),
      };
    case "workflowEdited":
      return {
        id: e.id,
        createdAt: e.createdAt,
        kind: e.kind,
        workflowId: e.workflowId,
        workflowName: e.workflowName,
        snapshotBefore: workflowToRecord(e.snapshotBefore),
        snapshotAfter: workflowToRecord(e.snapshotAfter),
      };
    case "workflowDeleted":
      return {
        id: e.id,
        createdAt: e.createdAt,
        kind: e.kind,
        workflowId: e.workflowId,
        workflowName: e.workflowName,
        snapshotBefore: workflowToRecord(e.snapshotBefore),
      };
    case "workflowRun":
      return {
        id: e.id,
        createdAt: e.createdAt,
        kind: e.kind,
        workflowId: e.workflowId,
        workflowName: e.workflowName,
        executionId: e.executionId,
        // Send `undefined` (key omitted) when absent, mirroring Rust's
        // `skip_serializing_if`. JSON.stringify drops `undefined` keys.
        ...omitWhenUndefined("exitCode", e.exitCode),
        ...omitWhenUndefined("durationMs", e.durationMs),
        status: e.status,
        ...omitWhenUndefined("timedOut", e.timedOut),
        ...omitWhenUndefined("output", e.output),
        ...omitWhenUndefined("result", e.result),
      };
    case "scheduledRun":
      // The frontend never writes scheduledRun events (the backend
      // scheduler does), but the converter must be exhaustive so a
      // round-trip through `eventToWire`/`wireToEvent` is lossless. Optional
      // capture fields are omitted (key absent) when undefined, mirroring
      // Rust's `skip_serializing_if`.
      return {
        id: e.id,
        createdAt: e.createdAt,
        kind: e.kind,
        scheduleId: e.scheduleId,
        scheduleName: e.scheduleName,
        targetKind: e.targetKind,
        targetId: e.targetId,
        // Mirror Rust's `skip_serializing_if = is_false`: omit `manual` from
        // the wire when `false` so an automatic fire stays byte-identical.
        ...(e.manual ? { manual: true } : {}),
        status: e.status,
        ...omitWhenUndefined("exitCode", e.exitCode),
        ...omitWhenUndefined("durationMs", e.durationMs),
        ...omitWhenUndefined("output", e.output),
        ...omitWhenUndefined("result", e.result),
      };
    case "sshHostAdded":
    case "sshHostDiscovered":
    case "sshHostEdited":
    case "sshHostEditedExternally":
    case "sshHostDeleted":
    case "sshHostDeletedExternally":
      // SSH history events are produced entirely on the backend (the save/
      // delete commands and the config watcher) and are never written back
      // from the frontend, so this conversion is unreachable for them.
      throw new Error(`SSH history events are backend-only: ${e.kind}`);
  }
}

/**
 * Fetch one page of events. The Rust side clamps `page_size` to a
 * sensible upper bound and accepts an empty/missing filter — we
 * therefore forward the filter object as-is.
 */
export async function listHistoryFromDb(
  filter: HistoryFilter,
  page: number,
  pageSize: number,
): Promise<HistoryPage> {
  const raw = await invoke<WireHistoryPage>("list_history", {
    filter,
    page,
    pageSize,
  });
  return {
    items: raw.items.map(wireToEvent),
    total: raw.total,
    page: raw.page,
    pageSize: raw.pageSize,
  };
}

/**
 * Page size for the schedule-view History tab. We load the full window in
 * one request (the backend caps the table at HISTORY_LIMIT = 1000 rows) and
 * scroll, rather than paginating inside the modal.
 */
export const SCHEDULE_HISTORY_PAGE_SIZE = 200;

/**
 * Load all `scheduledRun` history events for a single schedule, newest first.
 * Used by the schedule view's История tab. Filters server-side on the
 * denormalised `scheduleId` column so deleted-target schedules still show
 * their full run history.
 */
export async function listScheduleHistoryFromDb(
  scheduleId: string,
): Promise<HistoryEvent[]> {
  const page = await listHistoryFromDb(
    { scheduleId, kinds: ["scheduledRun"] },
    1,
    SCHEDULE_HISTORY_PAGE_SIZE,
  );
  return page.items;
}

export async function getHistoryEventFromDb(
  id: string,
): Promise<HistoryEvent | null> {
  const raw = await invoke<WireHistoryEvent | null>("get_history_event", {
    id,
  });
  return raw === null ? null : wireToEvent(raw);
}

/**
 * Persist a new event. Returns the id the Rust side echoed back —
 * the caller can store this for follow-up actions like marking the
 * source event as consumed after undo / restore.
 */
export async function recordHistoryEventInDb(
  event: HistoryEvent,
): Promise<string> {
  return invoke<string>("record_history_event", {
    event: eventToWire(event),
  });
}

export async function updateRunHistoryEventInDb(
  executionId: string,
  exitCode: number | undefined,
  durationMs: number | undefined,
  status: RunStatus,
  timedOut?: boolean,
  output?: HistoryLogLine[],
  result?: ExtractedResult,
): Promise<void> {
  await invoke("update_run_history_event", {
    executionId,
    // Rust expects `Option<T>` — `undefined` maps to JSON `null` /
    // `None` via Tauri's serde_json bridge. Sending the key with
    // `undefined` works because @tauri-apps/api drops it before
    // serialisation; we use a discriminating ternary for clarity.
    exitCode: exitCode === undefined ? null : exitCode,
    durationMs: durationMs === undefined ? null : durationMs,
    status,
    // `false` and `undefined` both collapse to `null` so the Rust side
    // only ever stores `Some(true)` for a genuine timeout.
    timedOut: timedOut === true ? true : null,
    // Captured aggregate output / structured result for the History view.
    // `undefined` collapses to `null` (Rust `None`); the Rust side bounds
    // the output to MAX_HISTORY_OUTPUT_BYTES before persisting.
    output: output === undefined ? null : output,
    result: result === undefined ? null : result,
  });
}

export async function deleteHistoryEventInDb(id: string): Promise<void> {
  await invoke("delete_history_event", { id });
}

/**
 * Clear history rows. The UI computes ISO-8601 bound(s) from the chosen range
 * and passes exactly one:
 *   - `after`  → delete rows AT OR NEWER than the cutoff (recent records:
 *     last hour / today / last week).
 *   - `before` → delete rows OLDER than the cutoff (older than N days).
 *   - neither  → clear the whole table ("all time").
 */
export async function clearHistoryInDb(
  bounds: { after?: string; before?: string } = {},
): Promise<void> {
  // `null` maps to the Rust `Option<String>::None`. Passing both as null
  // clears everything — identical to the original no-arg behaviour.
  await invoke("clear_history", {
    after: bounds.after ?? null,
    before: bounds.before ?? null,
  });
}

/**
 * Tiny in-module helper kept exported so tests can verify the
 * snapshot conversion uses the existing `recordToCommand` path
 * (rather than rolling its own null-handling).
 */
export function decodeSnapshot(r: CommandRecord): Command {
  return recordToCommand(r);
}

/**
 * Convert an in-memory `Execution.log` (which carries a per-line `ts` the
 * persisted history never stores) into the wire-format `HistoryLogLine[]` used
 * by the run-history `output` field. Drops the timestamp and keeps only the
 * stream tag + text. Returns `undefined` for an empty log so the caller passes
 * `None` (and the row stays a plain, non-expandable entry) rather than an
 * empty pane. The Rust side applies the byte cap on persist.
 */
export function executionLogToHistoryOutput(
  log: ExecutionLogLine[],
): HistoryLogLine[] | undefined {
  if (log.length === 0) return undefined;
  return log.map((line) => ({ stream: line.stream, line: line.line }));
}
