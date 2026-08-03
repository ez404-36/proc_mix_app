// Action-history types — discriminated union mirroring the Rust
// `HistoryEventPayload` enum (see `src-tauri/src/storage/history.rs`).
//
// Each variant carries a `kind` discriminator AND a full `Command`
// snapshot for the variants that power undo (`commandEdited`) or
// restore (`commandDeleted`). The shapes are wire-format — they match
// the JSON sent over IPC exactly — so the repository module
// (`utils/historyRepository.ts`) does NOT translate field names, only
// `null` ↔ `undefined` for the few optional fields where the Rust
// side serialises `Option<T>::None` as JSON `null`.

import type { Command } from "./command";
import type { ExtractedResult } from "./execution";
import type { MiniApp } from "./miniapp";
import type { Workflow } from "./workflow";

/**
 * One captured console line persisted with a scheduled run. Mirrors the Rust
 * `HistoryLogLine`. `stream` distinguishes real child output (`stdout` /
 * `stderr`) from app-injected separators (`meta`, e.g. a truncation marker).
 */
export interface HistoryLogLine {
  stream: "stdout" | "stderr" | "meta";
  line: string;
}

export type HistoryEventKind =
  | "commandCreated"
  | "commandEdited"
  | "commandDeleted"
  | "commandRun"
  | "commandRestored"
  | "commandReverted"
  | "miniAppDeleted"
  | "miniAppRestored"
  | "workflowCreated"
  | "workflowEdited"
  | "workflowDeleted"
  | "workflowRun"
  | "scheduledRun"
  | "quickLaunch"
  | "sshHostAdded"
  | "sshHostDiscovered"
  | "sshHostEdited"
  | "sshHostEditedExternally"
  | "sshHostDeleted"
  | "sshHostDeletedExternally";

/**
 * Outcome of a scheduled (cron) fire. Mirrors the free-form status strings
 * the backend scheduler records on a `scheduledRun` event — a superset of
 * {@link RunStatus} because the scheduler distinguishes more cases.
 */
export type ScheduledRunStatus =
  | "success"
  | "error"
  | "missingVariable"
  | "skipped"
  | "cancelled";

/** The kind of target a schedule fires. */
export type ScheduleTargetKind = "command" | "workflow";

/**
 * Outcome of a quick-launch (tray "Favorites" submenu / OS shell integration).
 * Mirrors the free-form status strings `core::launch` records on a
 * `quickLaunch` event. `notFound` means the favorite was removed between the
 * menu being built and the launch firing.
 */
export type QuickLaunchStatus =
  | "success"
  | "error"
  | "missingVariable"
  | "notFound";

/** What triggered a quick-launch run. */
export type QuickLaunchSource = "tray" | "shell";

/**
 * Lifecycle status of a `commandRun` history record. Mirrors the
 * Rust `RunStatus` enum on the wire (lowercase).
 */
export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

interface HistoryEventBase {
  id: string;
  createdAt: string;
}

export interface CommandCreatedEvent extends HistoryEventBase {
  kind: "commandCreated";
  commandId: string;
  commandName: string;
  /** Snapshot of the command immediately AFTER creation. */
  snapshotAfter: Command;
}

export interface CommandEditedEvent extends HistoryEventBase {
  kind: "commandEdited";
  commandId: string;
  commandName: string;
  /** Snapshot taken BEFORE the edit was applied — used by undo. */
  snapshotBefore: Command;
  /** Snapshot taken AFTER the edit, for display purposes. */
  snapshotAfter: Command;
}

export interface CommandDeletedEvent extends HistoryEventBase {
  kind: "commandDeleted";
  commandId: string;
  commandName: string;
  /** Full snapshot of the deleted command — used by restore. */
  snapshotBefore: Command;
}

export interface CommandRunEvent extends HistoryEventBase {
  kind: "commandRun";
  commandId: string;
  commandName: string;
  executionId: string;
  /**
   * Process exit code reported by the executor. Absent while the run
   * is still in flight (`status: "running"`) or when the run was
   * cancelled before the OS could deliver an exit code.
   */
  exitCode?: number;
  /** Wall-clock duration in milliseconds. Absent while running. */
  durationMs?: number;
  status: RunStatus;
  /**
   * Where the run executed. Absent (or `{ kind: 'local' }`) for a local run;
   * `{ kind: 'remote', alias }` when the command ran over SSH. Captured at
   * run start so a past entry shows on which host it ran. Never `remotePrompt`
   * — the runner resolves that to a concrete host before recording.
   */
  target?: import("./command").ExecutionTarget;
  /**
   * True when the run was killed because it exceeded its configured
   * timeout. The executor reports a normal `finished` event with a
   * `timedOut` flag (exit code is usually absent because the process
   * was signal-killed), and the bridge forwards it here so History can
   * distinguish a timeout from an ordinary non-zero exit. Absent /
   * `false` for every other outcome.
   */
  timedOut?: boolean;
  /**
   * Captured console lines, persisted when the run reached a terminal state.
   * Absent while running and for rows recorded before output persistence
   * existed. May end with a `meta` truncation marker when the output exceeded
   * the persistence cap. Drives the expandable History row's output pane.
   */
  output?: HistoryLogLine[];
  /**
   * Structured extraction result, present when the command declared an output
   * schema and produced a result.
   */
  result?: ExtractedResult;
}

export interface CommandRestoredEvent extends HistoryEventBase {
  kind: "commandRestored";
  commandId: string;
  commandName: string;
  /** Id of the `commandDeleted` event this entry reverts. */
  originalEventId: string;
}

export interface CommandRevertedEvent extends HistoryEventBase {
  kind: "commandReverted";
  commandId: string;
  commandName: string;
  /** Id of the `commandEdited` event this entry undoes. */
  originalEventId: string;
}

export interface MiniAppDeletedEvent extends HistoryEventBase {
  kind: "miniAppDeleted";
  miniappId: string;
  miniappName: string;
  /** Full snapshot of the deleted mini-app — used by restore. */
  snapshotBefore: MiniApp;
}

export interface MiniAppRestoredEvent extends HistoryEventBase {
  kind: "miniAppRestored";
  miniappId: string;
  miniappName: string;
  /** Id of the `miniAppDeleted` event this entry reverts. */
  originalEventId: string;
}

export interface WorkflowCreatedEvent extends HistoryEventBase {
  kind: "workflowCreated";
  workflowId: string;
  workflowName: string;
  /** Snapshot of the workflow immediately AFTER creation. */
  snapshotAfter: Workflow;
}

export interface WorkflowEditedEvent extends HistoryEventBase {
  kind: "workflowEdited";
  workflowId: string;
  workflowName: string;
  /** Snapshot taken BEFORE the edit was applied — used by undo. */
  snapshotBefore: Workflow;
  /** Snapshot taken AFTER the edit, for display purposes. */
  snapshotAfter: Workflow;
}

export interface WorkflowDeletedEvent extends HistoryEventBase {
  kind: "workflowDeleted";
  workflowId: string;
  workflowName: string;
  /** Full snapshot of the deleted workflow — used by restore. */
  snapshotBefore: Workflow;
  /**
   * Snapshots of the workflow's `local`-scoped commands that were
   * cascade-deleted alongside it. Captured so a future restore can re-create
   * them with the workflow. Absent/empty when the workflow had no local
   * commands. Older delete events predate this field.
   */
  localCommands?: Command[];
}

export interface WorkflowRunEvent extends HistoryEventBase {
  kind: "workflowRun";
  workflowId: string;
  workflowName: string;
  /** Run id assigned when the workflow was triggered. */
  executionId: string;
  /**
   * Final exit code of the workflow run (the exit code of the last
   * executed node). Absent while the run is in flight or when cancelled
   * before any node produced an exit code.
   */
  exitCode?: number;
  /** Wall-clock duration in milliseconds. Absent while running. */
  durationMs?: number;
  status: RunStatus;
  /** True when the run's final node was killed by its timeout. */
  timedOut?: boolean;
  /**
   * Aggregate captured console lines for the whole workflow run, persisted
   * when the run reached a terminal state. Absent while running and for rows
   * recorded before output persistence existed. May end with a `meta`
   * truncation marker. Drives the expandable History row's output pane.
   */
  output?: HistoryLogLine[];
  /**
   * Structured extraction result for the workflow run, when available.
   */
  result?: ExtractedResult;
}

export interface ScheduledRunEvent extends HistoryEventBase {
  kind: "scheduledRun";
  /** Id of the schedule that fired. */
  scheduleId: string;
  /** Schedule display name at the moment of firing. */
  scheduleName: string;
  /** Whether the fired target was a command or a workflow. */
  targetKind: ScheduleTargetKind;
  /** Logical id of the fired command / workflow. */
  targetId: string;
  /**
   * `true` when the fire was triggered manually via "Run now", `false` for an
   * automatic cron / catch-up fire. Drives the History row label ("Manual
   * run …" vs "Scheduled run …"). Always concrete — the repository collapses a
   * missing wire value (legacy / automatic) to `false`.
   */
  manual: boolean;
  /** Final outcome of the fire. */
  status: ScheduledRunStatus;
  /**
   * Process exit code of the fired command. Present for command fires whose
   * outcome reported an exit code; absent for workflow fires and signal-killed
   * runs. (Captured regardless of `captureOutput`.)
   */
  exitCode?: number;
  /** Wall-clock duration in milliseconds. Absent for workflow fires. */
  durationMs?: number;
  /**
   * Captured console lines, present only when the schedule had
   * `captureOutput` enabled AND the target was a command. May end with a
   * `meta` truncation marker when the output exceeded the persistence cap.
   */
  output?: HistoryLogLine[];
  /**
   * Structured extraction result, present only when the fired command
   * declared an output schema and `captureOutput` was enabled.
   */
  result?: ExtractedResult;
}

/**
 * A favorite command / workflow fired out of band by a quick-launch entry
 * point — the tray icon's "Favorites" submenu (`source: "tray"`) or the OS
 * file-manager shell integration (`source: "shell"`). Mirrors the Rust
 * `HistoryEventPayload::QuickLaunch`. Recorded already-finalised, so all detail
 * lives on the event.
 */
export interface QuickLaunchEvent extends HistoryEventBase {
  kind: "quickLaunch";
  /** Whether the fired target was a command or a workflow. */
  targetKind: ScheduleTargetKind;
  /** Logical id of the fired command / workflow. */
  targetId: string;
  /** Display name of the fired target at the moment of firing. */
  targetName: string;
  /** What triggered the launch. Drives the History row label / badge. */
  source: QuickLaunchSource;
  /**
   * The right-clicked filesystem path passed by the shell integration. Absent
   * for a tray launch (the repository collapses a missing wire value to
   * `undefined`).
   */
  selectedPath?: string;
  /** Final outcome of the launch. */
  status: QuickLaunchStatus;
  /** Process exit code of the fired command. Absent for workflow fires. */
  exitCode?: number;
  /** Wall-clock duration in milliseconds. Absent for workflow fires. */
  durationMs?: number;
  /** Captured console lines, present only for command targets. */
  output?: HistoryLogLine[];
  /** Structured extraction result, present only when the command declared a schema. */
  result?: ExtractedResult;
}

/**
 * Compact snapshot of an SSH host/pattern stored with an SSH history event.
 * Mirrors the Rust `SshHostSnapshot`.
 */
export interface SshHostSnapshot {
  hostKey: string;
  name: string;
  source: string;
  hostName: string | null;
  user: string | null;
  port: number | null;
  identityFile: string | null;
  isPattern: boolean;
  rawText: string;
}

/** SSH host/pattern created inside ProcMix. */
export interface SshHostAddedEvent extends HistoryEventBase {
  kind: "sshHostAdded";
  hostKey: string;
  hostName: string;
  snapshotAfter: SshHostSnapshot;
}
/** SSH host/pattern first seen on disk (created outside ProcMix). */
export interface SshHostDiscoveredEvent extends HistoryEventBase {
  kind: "sshHostDiscovered";
  hostKey: string;
  hostName: string;
  snapshotAfter: SshHostSnapshot;
}
/** SSH host/pattern edited inside ProcMix. */
export interface SshHostEditedEvent extends HistoryEventBase {
  kind: "sshHostEdited";
  hostKey: string;
  hostName: string;
  snapshotBefore: SshHostSnapshot;
  snapshotAfter: SshHostSnapshot;
}
/** SSH host/pattern changed on disk outside ProcMix. */
export interface SshHostEditedExternallyEvent extends HistoryEventBase {
  kind: "sshHostEditedExternally";
  hostKey: string;
  hostName: string;
  snapshotBefore: SshHostSnapshot;
  snapshotAfter: SshHostSnapshot;
}
/** SSH host/pattern deleted inside ProcMix. */
export interface SshHostDeletedEvent extends HistoryEventBase {
  kind: "sshHostDeleted";
  hostKey: string;
  hostName: string;
  snapshotBefore: SshHostSnapshot;
}
/** SSH host/pattern that disappeared from disk (deleted outside ProcMix). */
export interface SshHostDeletedExternallyEvent extends HistoryEventBase {
  kind: "sshHostDeletedExternally";
  hostKey: string;
  hostName: string;
  snapshotBefore: SshHostSnapshot;
}

export type HistoryEvent =
  | CommandCreatedEvent
  | CommandEditedEvent
  | CommandDeletedEvent
  | CommandRunEvent
  | CommandRestoredEvent
  | CommandRevertedEvent
  | MiniAppDeletedEvent
  | MiniAppRestoredEvent
  | WorkflowCreatedEvent
  | WorkflowEditedEvent
  | WorkflowDeletedEvent
  | WorkflowRunEvent
  | ScheduledRunEvent
  | QuickLaunchEvent
  | SshHostAddedEvent
  | SshHostDiscoveredEvent
  | SshHostEditedEvent
  | SshHostEditedExternallyEvent
  | SshHostDeletedEvent
  | SshHostDeletedExternallyEvent;

/**
 * Display name of the entity a history event acts on — the command name
 * for `command*` variants, the workflow name for `workflow*` variants.
 * Centralised so UI code can render a row title without narrowing every
 * variant. Mirrors the Rust `HistoryEventPayload::command_name`
 * accessor (which feeds the denormalised SQL column).
 */
export function historyEventSubjectName(event: HistoryEvent): string {
  switch (event.kind) {
    case "commandCreated":
    case "commandEdited":
    case "commandDeleted":
    case "commandRun":
    case "commandRestored":
    case "commandReverted":
      return event.commandName;
    case "miniAppDeleted":
    case "miniAppRestored":
      return event.miniappName;
    case "workflowCreated":
    case "workflowEdited":
    case "workflowDeleted":
    case "workflowRun":
      return event.workflowName;
    case "scheduledRun":
      return event.scheduleName;
    case "quickLaunch":
      return event.targetName;
    case "sshHostAdded":
    case "sshHostDiscovered":
    case "sshHostEdited":
    case "sshHostEditedExternally":
    case "sshHostDeleted":
    case "sshHostDeletedExternally":
      return event.hostName;
  }
}

/**
 * Id of the entity a history event acts on — `commandId` for `command*`
 * variants, `workflowId` for `workflow*` variants. Lets the UI check
 * "does the subject still exist?" without a per-variant switch.
 */
export function historyEventSubjectId(event: HistoryEvent): string {
  switch (event.kind) {
    case "commandCreated":
    case "commandEdited":
    case "commandDeleted":
    case "commandRun":
    case "commandRestored":
    case "commandReverted":
      return event.commandId;
    case "miniAppDeleted":
    case "miniAppRestored":
      return event.miniappId;
    case "workflowCreated":
    case "workflowEdited":
    case "workflowDeleted":
    case "workflowRun":
      return event.workflowId;
    case "scheduledRun":
      // The subject is the schedule itself; its target id lives on
      // `targetId`. Returning the schedule id keeps "does the subject
      // exist?" checks meaningful for scheduled runs.
      return event.scheduleId;
    case "quickLaunch":
      // The subject is the fired command / workflow itself.
      return event.targetId;
    case "sshHostAdded":
    case "sshHostDiscovered":
    case "sshHostEdited":
    case "sshHostEditedExternally":
    case "sshHostDeleted":
    case "sshHostDeletedExternally":
      return event.hostKey;
  }
}

/**
 * Filter shape consumed by `list_history`. All fields are optional;
 * omitting a field (or passing an empty array for `kinds`) means
 * "no constraint".
 */
export interface HistoryFilter {
  kinds?: HistoryEventKind[];
  commandNameQuery?: string;
  /** Inclusive lower bound on `createdAt`, ISO 8601 string. */
  dateFrom?: string;
  /** Inclusive upper bound on `createdAt`, ISO 8601 string. */
  dateTo?: string;
  /**
   * Restrict to `scheduledRun` events for a single schedule. Matched against
   * the denormalised `schedule_id` column. Used by the schedule view's
   * History tab.
   */
  scheduleId?: string;
  /**
   * When `true`, only return run events that finished with an error
   * (`status: "failed"` for commandRun/workflowRun, `status: "error"` for
   * scheduledRun). Omit or `false` for no constraint.
   */
  failedOnly?: boolean;
}

export interface HistoryPage {
  items: HistoryEvent[];
  /** Total matching rows across the full filtered set. */
  total: number;
  page: number;
  pageSize: number;
}
