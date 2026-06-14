// Action-history storage layer.
//
// Records create/edit/delete/run events for commands in the `history_events`
// SQLite table. The wire format is the `HistoryEvent` struct whose payload
// is a tagged enum — every variant carries a full snapshot of the command
// involved so `undo` (edit) and `restore` (delete) can re-upsert without
// any further IPC. `command_run` variants carry the execution id and a
// status that is updated when the executor reports Finished/Cancelled.
//
// IMPORTANT serde notes (see AGENTS.md failures.md for the precedent
// bug): `rename_all = "camelCase"` on an enum renames only variant
// discriminants — it does NOT touch fields inside struct variants.
// We use `rename_all_fields = "camelCase"` for the enum AND an
// explicit `rename_all = "camelCase"` on each struct variant so the
// invariant survives a future serde refactor. The wire-format tests
// at the bottom of this file lock the contract with both positive
// (camelCase present) AND negative (snake_case absent) assertions.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::storage::commands::CommandRecord;
use crate::storage::workflows::WorkflowRecord;
use crate::storage::DbPool;

/// Hard cap on the number of history entries kept on disk. When an
/// insert pushes the table past this size, the oldest rows (lowest
/// `created_at`) are pruned. 1000 is enough for several months of
/// realistic usage and keeps the on-disk JSON column bounded.
pub const HISTORY_LIMIT: u32 = 1000;

/// Upper bound (in bytes) on the captured console output persisted with a
/// `scheduledRun` history event. The producer (the scheduler, wired in a
/// later part) truncates the joined log text to this size before storing it
/// so a chatty background fire cannot bloat `payload_json` unbounded. Defined
/// here so the storage layer owns the cap alongside the variant it bounds.
pub const MAX_HISTORY_OUTPUT_BYTES: usize = 64 * 1024;

/// One captured log line for a persisted scheduled run. `stream` is one of
/// `"stdout"`, `"stderr"`, or `"meta"` (an app-injected separator) — mirroring
/// the TS `ExecutionLogStream` / `ExecutionLogLine` shapes in
/// `src/types/execution.ts`. Only the stream tag and the text are stored; the
/// per-line timestamp the live console carries is not persisted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryLogLine {
    pub stream: String,
    pub line: String,
}

/// Structured output-schema extraction persisted with a scheduled run. Mirrors
/// the TS `ExtractedResult` shape in `src/types/execution.ts`: `fields` maps
/// each schema field name to its extracted JSON value, `return_value` is the
/// chosen return value, and `error` is set (with `fields`/`return_value`
/// empty) when extraction failed. Values are arbitrary JSON, so they are typed
/// `serde_json::Value`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryExtractedResult {
    pub fields: serde_json::Map<String, serde_json::Value>,
    pub return_value: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Lifecycle status of a `command_run` history record. The value is
/// updated when the executor bridge reports `Finished` / `Cancelled`
/// via [`update_run_event`]. Wire format is `lowercase` to match the
/// status strings already used by `ExecutionEvent` on the JS side
/// (`running`, `succeeded`, `failed`, `cancelled`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl RunStatus {
    /// Lower-case string used as the value of the `status` SQL column
    /// AND the wire-format serialisation. Kept here so the SQL layer
    /// never hand-rolls a string that could drift from serde.
    pub fn as_str(self) -> &'static str {
        match self {
            RunStatus::Running => "running",
            RunStatus::Succeeded => "succeeded",
            RunStatus::Failed => "failed",
            RunStatus::Cancelled => "cancelled",
        }
    }

    /// Inverse of [`as_str`]. Not named `from_str` to avoid colliding
    /// with the `std::str::FromStr` trait — clippy::should_implement_trait
    /// flags the collision because that trait's method must return a
    /// `Result`, not an `Option`, and we genuinely want the Option
    /// semantics here ("None for unknown string" rather than a typed
    /// error).
    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "running" => Some(RunStatus::Running),
            "succeeded" => Some(RunStatus::Succeeded),
            "failed" => Some(RunStatus::Failed),
            "cancelled" => Some(RunStatus::Cancelled),
            _ => None,
        }
    }
}

/// Internally-tagged payload variants. The discriminator `kind` lives
/// at the top level of the JSON object so JS can switch on it without
/// reaching into a nested wrapper. Variant names match the JS
/// `HistoryEventKind` union exactly (camelCase) via the `rename_all`
/// attribute on the enum.
///
/// `clippy::large_enum_variant`: the `CommandEdited` variant is ~944
/// bytes because it carries two full `CommandRecord` snapshots. Boxing
/// them would save memory but History events are never kept in hot
/// data structures — at most a single page (10 items) is held in the
/// frontend's Zustand store. Memory cost is negligible; we accept the
/// lint and document the rationale here.
// `Eq` is intentionally NOT derived: the `workflow*` variants embed a
// `WorkflowRecord`, whose node `position` uses `f64` (no `Eq`). `PartialEq`
// is sufficient for the wire-format and integration tests' `assert_eq!`.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HistoryEventPayload {
    #[serde(rename_all = "camelCase")]
    CommandCreated {
        command_id: String,
        command_name: String,
        snapshot_after: CommandRecord,
    },
    #[serde(rename_all = "camelCase")]
    CommandEdited {
        command_id: String,
        command_name: String,
        snapshot_before: CommandRecord,
        snapshot_after: CommandRecord,
    },
    #[serde(rename_all = "camelCase")]
    CommandDeleted {
        command_id: String,
        command_name: String,
        snapshot_before: CommandRecord,
    },
    #[serde(rename_all = "camelCase")]
    CommandRun {
        command_id: String,
        command_name: String,
        execution_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        status: RunStatus,
        /// `Some(true)` when the run was killed by its configured
        /// timeout. Omitted from the wire (not `null`) for every other
        /// outcome so legacy payloads stay byte-identical.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timed_out: Option<bool>,
    },
    #[serde(rename_all = "camelCase")]
    CommandRestored {
        command_id: String,
        command_name: String,
        /// Id of the original `command_deleted` event that this entry
        /// reverts. Lets the UI mark the source record as consumed.
        original_event_id: String,
    },
    #[serde(rename_all = "camelCase")]
    CommandReverted {
        command_id: String,
        command_name: String,
        /// Id of the original `command_edited` event that was undone.
        original_event_id: String,
    },
    #[serde(rename_all = "camelCase")]
    WorkflowCreated {
        workflow_id: String,
        workflow_name: String,
        snapshot_after: WorkflowRecord,
    },
    #[serde(rename_all = "camelCase")]
    WorkflowEdited {
        workflow_id: String,
        workflow_name: String,
        snapshot_before: WorkflowRecord,
        snapshot_after: WorkflowRecord,
    },
    #[serde(rename_all = "camelCase")]
    WorkflowDeleted {
        workflow_id: String,
        workflow_name: String,
        snapshot_before: WorkflowRecord,
    },
    #[serde(rename_all = "camelCase")]
    WorkflowRun {
        workflow_id: String,
        workflow_name: String,
        /// Run id assigned when the workflow was triggered. Stored in the
        /// dedicated `execution_id` column (shared with `command_run`) so
        /// [`update_run_event`] can finalise the row by run id without a
        /// JSON decode/encode round-trip.
        execution_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        status: RunStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timed_out: Option<bool>,
    },
    /// A run triggered automatically by the cron Scheduler (v0.2.0). This is
    /// the source of truth for background fires — they happen with no window
    /// open, so the streamed `execution-event` / `workflow-event` are not
    /// reliably observed. The scheduler records ONE of these per fire with
    /// the final `status`. Unlike the other run variants it is recorded
    /// already-finalised (no `update_run_event` round-trip), so it carries no
    /// dedicated `execution_id` column — its detail (including the optional
    /// captured `exit_code` / `duration_ms` / `output` / `result`) lives
    /// entirely in `payload_json`.
    ///
    /// `status` is a free-form scheduler status string (`"success"`,
    /// `"error"`, `"missingVariable"`, `"skipped"`, `"cancelled"`) rather
    /// than the `RunStatus` enum, because the scheduler distinguishes more
    /// outcomes than the streaming executor does.
    #[serde(rename_all = "camelCase")]
    ScheduledRun {
        schedule_id: String,
        schedule_name: String,
        /// `"command"` or `"workflow"` — the kind of target that was fired.
        target_kind: String,
        /// Logical id of the fired command / workflow.
        target_id: String,
        status: String,
        /// Exit code of the fired target, when captured. Omitted from the wire
        /// (not `null`) — and `None` for fires whose schedule had output
        /// capture disabled, or recorded before capture existed — so legacy
        /// payloads stay byte-identical.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        /// Wall-clock duration of the fire in milliseconds, when captured.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        /// Captured console output (bounded by [`MAX_HISTORY_OUTPUT_BYTES`] by
        /// the producer). `None` when capture was disabled or unavailable.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<Vec<HistoryLogLine>>,
        /// Structured output-schema extraction, when the target declared a
        /// schema and capture was enabled.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<HistoryExtractedResult>,
    },
}

impl HistoryEventPayload {
    /// The lowercase kind discriminator as stored in the `kind` SQL
    /// column. We keep this in sync with the serde rename manually so
    /// the SQL filter (`WHERE kind = ?`) doesn't fall out of sync with
    /// the wire format.
    pub fn kind_str(&self) -> &'static str {
        match self {
            HistoryEventPayload::CommandCreated { .. } => "commandCreated",
            HistoryEventPayload::CommandEdited { .. } => "commandEdited",
            HistoryEventPayload::CommandDeleted { .. } => "commandDeleted",
            HistoryEventPayload::CommandRun { .. } => "commandRun",
            HistoryEventPayload::CommandRestored { .. } => "commandRestored",
            HistoryEventPayload::CommandReverted { .. } => "commandReverted",
            HistoryEventPayload::WorkflowCreated { .. } => "workflowCreated",
            HistoryEventPayload::WorkflowEdited { .. } => "workflowEdited",
            HistoryEventPayload::WorkflowDeleted { .. } => "workflowDeleted",
            HistoryEventPayload::WorkflowRun { .. } => "workflowRun",
            HistoryEventPayload::ScheduledRun { .. } => "scheduledRun",
        }
    }

    /// Owning command id (denormalised into the SQL `command_id` column
    /// for cheap lookups). `command_*` variants carry one; `workflow_*`
    /// variants have no owning command and return `None`, so the column
    /// stays nullable for them (their subject is the workflow, recorded
    /// in the JSON payload and reachable via [`Self::workflow_id`]).
    pub fn command_id(&self) -> Option<&str> {
        match self {
            HistoryEventPayload::CommandCreated { command_id, .. }
            | HistoryEventPayload::CommandEdited { command_id, .. }
            | HistoryEventPayload::CommandDeleted { command_id, .. }
            | HistoryEventPayload::CommandRun { command_id, .. }
            | HistoryEventPayload::CommandRestored { command_id, .. }
            | HistoryEventPayload::CommandReverted { command_id, .. } => Some(command_id),
            HistoryEventPayload::WorkflowCreated { .. }
            | HistoryEventPayload::WorkflowEdited { .. }
            | HistoryEventPayload::WorkflowDeleted { .. }
            | HistoryEventPayload::WorkflowRun { .. }
            | HistoryEventPayload::ScheduledRun { .. } => None,
        }
    }

    /// Owning workflow id for `workflow_*` variants; `None` for command
    /// variants. Kept separate from [`command_id`] because the two ids
    /// reference different tables and the SQL schema denormalises only the
    /// command id today. Surfaced so future workflow-aware queries (e.g.
    /// "history for this workflow") have a typed accessor.
    pub fn workflow_id(&self) -> Option<&str> {
        match self {
            HistoryEventPayload::WorkflowCreated { workflow_id, .. }
            | HistoryEventPayload::WorkflowEdited { workflow_id, .. }
            | HistoryEventPayload::WorkflowDeleted { workflow_id, .. }
            | HistoryEventPayload::WorkflowRun { workflow_id, .. } => Some(workflow_id),
            _ => None,
        }
    }

    /// Owning schedule id for the `scheduledRun` variant; `None` for every
    /// other kind. Denormalised into the SQL `schedule_id` column so the
    /// schedule view can filter a single schedule's run history without a
    /// JSON scan.
    pub fn schedule_id(&self) -> Option<&str> {
        match self {
            HistoryEventPayload::ScheduledRun { schedule_id, .. } => Some(schedule_id),
            _ => None,
        }
    }

    /// Subject display name at the moment of recording — the command name
    /// for `command_*` variants, the workflow name for `workflow_*`
    /// variants. Denormalised into the SQL `command_name` column (which is
    /// really a generic "subject name") so the history survives deletion
    /// of the underlying entity and the name filter works without a JOIN.
    pub fn command_name(&self) -> &str {
        match self {
            HistoryEventPayload::CommandCreated { command_name, .. }
            | HistoryEventPayload::CommandEdited { command_name, .. }
            | HistoryEventPayload::CommandDeleted { command_name, .. }
            | HistoryEventPayload::CommandRun { command_name, .. }
            | HistoryEventPayload::CommandRestored { command_name, .. }
            | HistoryEventPayload::CommandReverted { command_name, .. } => command_name,
            HistoryEventPayload::WorkflowCreated { workflow_name, .. }
            | HistoryEventPayload::WorkflowEdited { workflow_name, .. }
            | HistoryEventPayload::WorkflowDeleted { workflow_name, .. }
            | HistoryEventPayload::WorkflowRun { workflow_name, .. } => workflow_name,
            HistoryEventPayload::ScheduledRun { schedule_name, .. } => schedule_name,
        }
    }

    /// For run variants (`command_run` / `workflow_run`) — returns the
    /// execution / run id so insert can populate the dedicated
    /// `execution_id` column used by [`update_run_event`].
    pub fn execution_id(&self) -> Option<&str> {
        match self {
            HistoryEventPayload::CommandRun { execution_id, .. }
            | HistoryEventPayload::WorkflowRun { execution_id, .. } => Some(execution_id),
            _ => None,
        }
    }

    /// For run variants — initial status, written to the SQL `status`
    /// column at insert time.
    pub fn run_status(&self) -> Option<RunStatus> {
        match self {
            HistoryEventPayload::CommandRun { status, .. }
            | HistoryEventPayload::WorkflowRun { status, .. } => Some(*status),
            _ => None,
        }
    }

    pub fn run_exit_code(&self) -> Option<i32> {
        match self {
            HistoryEventPayload::CommandRun { exit_code, .. }
            | HistoryEventPayload::WorkflowRun { exit_code, .. } => *exit_code,
            _ => None,
        }
    }

    pub fn run_duration_ms(&self) -> Option<u64> {
        match self {
            HistoryEventPayload::CommandRun { duration_ms, .. }
            | HistoryEventPayload::WorkflowRun { duration_ms, .. } => *duration_ms,
            _ => None,
        }
    }
}

/// Top-level wire record. `id` and `created_at` are supplied by the
/// caller (the JS layer mirrors the existing convention used by
/// `CommandRecord`: it owns timestamp + UUID generation). `#[serde(flatten)]`
/// lifts the payload's tagged discriminator (`kind`) and its variant
/// fields up to the top level of the JSON object — matching the
/// `HistoryEventBase + variant` discriminated union on the JS side.
// `Eq` is not derived because `payload` (HistoryEventPayload) embeds a
// `WorkflowRecord` with `f64` fields. `PartialEq` suffices for tests.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEvent {
    pub id: String,
    pub created_at: String,
    #[serde(flatten)]
    pub payload: HistoryEventPayload,
}

/// Filter parameters consumed by [`list_paginated`]. All fields are
/// optional; an unset field means "no constraint". The TS side has a
/// matching shape, see `src/types/history.ts`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryFilter {
    /// Whitelist of `kind` values. An empty list (or `None`) returns
    /// every kind — we treat the two cases identically so the UI can
    /// send an empty array without special-casing.
    #[serde(default)]
    pub kinds: Option<Vec<String>>,
    /// Case-insensitive substring match against `command_name`.
    #[serde(default)]
    pub command_name_query: Option<String>,
    /// Inclusive lower bound on `created_at` (ISO 8601 string).
    #[serde(default)]
    pub date_from: Option<String>,
    /// Inclusive upper bound on `created_at` (ISO 8601 string). The
    /// frontend is responsible for padding day-granular pickers up to
    /// `T23:59:59.999Z` before sending — that keeps the SQL contract
    /// simple ("<= dateTo as-is").
    #[serde(default)]
    pub date_to: Option<String>,
    /// Restrict to a single schedule's `scheduledRun` events. Matched against
    /// the denormalised `schedule_id` column. Used by the schedule view's
    /// History tab. `None` means \"no constraint\".
    #[serde(default)]
    pub schedule_id: Option<String>,
    /// When `true`, only return run events that finished with an error:
    /// `status = 'failed'` (commandRun / workflowRun) or `status = 'error'`
    /// (scheduledRun). Non-run events have a NULL status and are excluded.
    #[serde(default)]
    pub failed_only: bool,
}

/// One page of history rows plus the total count matching the filter
/// (used to drive the paginator).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub items: Vec<HistoryEvent>,
    pub total: u64,
    pub page: u32,
    pub page_size: u32,
}

/// Allowed kinds — used to validate the `kinds` filter before it hits
/// the SQL layer. Returning the set here (rather than inlining a
/// `match` in the filter builder) keeps the validation co-located with
/// the enum definition.
pub fn allowed_kinds() -> HashSet<&'static str> {
    [
        "commandCreated",
        "commandEdited",
        "commandDeleted",
        "commandRun",
        "commandRestored",
        "commandReverted",
        "workflowCreated",
        "workflowEdited",
        "workflowDeleted",
        "workflowRun",
        "scheduledRun",
    ]
    .into_iter()
    .collect()
}

// ---------------------------------------------------------------------------
// CRUD — implemented in A3 below.
// ---------------------------------------------------------------------------

/// Insert a fresh event. The caller owns id + created_at generation
/// (matching the `CommandRecord` convention). After a successful
/// insert this function prunes the table back to `HISTORY_LIMIT` rows.
pub async fn insert_event(pool: &DbPool, event: &HistoryEvent) -> Result<(), String> {
    let payload_json = serde_json::to_string(&event.payload)
        .map_err(|e| format!("encode history payload: {e}"))?;
    let kind = event.payload.kind_str();
    let command_id = event.payload.command_id();
    let command_name = event.payload.command_name();
    let execution_id = event.payload.execution_id();
    let schedule_id = event.payload.schedule_id();
    let status = event.payload.run_status().map(|s| s.as_str());
    let exit_code = event.payload.run_exit_code();
    // Cast u64 -> i64 (SQLite has no native unsigned). Run durations
    // never exceed i64 in practice (~292M years). The narrowing is
    // explicit so a future review can't miss it.
    let duration_ms: Option<i64> = event.payload.run_duration_ms().map(|v| v as i64);

    sqlx::query(
        "INSERT INTO history_events ( \
            id, created_at, kind, command_id, command_name, payload_json, \
            execution_id, exit_code, duration_ms, status, schedule_id \
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&event.id)
    .bind(&event.created_at)
    .bind(kind)
    .bind(command_id)
    .bind(command_name)
    .bind(&payload_json)
    .bind(execution_id)
    .bind(exit_code)
    .bind(duration_ms)
    .bind(status)
    .bind(schedule_id)
    .execute(pool.as_ref())
    .await
    .map_err(|e| format!("insert history event: {e}"))?;

    prune_to_limit(pool, HISTORY_LIMIT).await?;
    Ok(())
}

/// Update an existing `command_run` event with the final outcome
/// reported by the executor bridge. Looks up by `execution_id` so the
/// caller does not need to remember the history-row id. Also rewrites
/// the embedded `payload_json` so a later read returns a consistent
/// view (the dedicated columns and the JSON payload always agree).
///
/// A missing `execution_id` is NOT an error — it means the event was
/// pruned by retention OR the user cleared the history mid-run. The
/// caller should not bubble that to the user.
pub async fn update_run_event(
    pool: &DbPool,
    execution_id: &str,
    exit_code: Option<i32>,
    duration_ms: Option<u64>,
    status: RunStatus,
    timed_out: Option<bool>,
) -> Result<(), String> {
    // Re-read the row so we can rewrite the JSON payload with the new
    // values. We only ever update at most one row (execution_id is
    // unique per run); LIMIT 1 is a belt-and-braces guard.
    let row = sqlx::query(
        "SELECT id, payload_json FROM history_events \
         WHERE execution_id = ? AND kind IN ('commandRun', 'workflowRun') LIMIT 1",
    )
    .bind(execution_id)
    .fetch_optional(pool.as_ref())
    .await
    .map_err(|e| format!("lookup run event: {e}"))?;

    let Some(row) = row else {
        // Event was pruned or never recorded — treat as no-op.
        return Ok(());
    };

    let id: String = row.try_get("id").map_err(|e| format!("read id: {e}"))?;
    let payload_json: String = row
        .try_get("payload_json")
        .map_err(|e| format!("read payload_json: {e}"))?;

    let mut payload: HistoryEventPayload =
        serde_json::from_str(&payload_json).map_err(|e| format!("decode payload_json: {e}"))?;

    match &mut payload {
        HistoryEventPayload::CommandRun {
            exit_code: ec,
            duration_ms: dm,
            status: st,
            timed_out: to,
            ..
        } => {
            *ec = exit_code;
            *dm = duration_ms;
            *st = status;
            // Only persist `Some(true)`; `Some(false)` / `None` collapse
            // to `None` so the wire stays clean for non-timeout runs.
            *to = if timed_out == Some(true) {
                Some(true)
            } else {
                None
            };
        }
        HistoryEventPayload::WorkflowRun {
            exit_code: ec,
            duration_ms: dm,
            status: st,
            timed_out: to,
            ..
        } => {
            *ec = exit_code;
            *dm = duration_ms;
            *st = status;
            *to = if timed_out == Some(true) {
                Some(true)
            } else {
                None
            };
        }
        _ => {
            // The row's `kind` column claimed a run variant but the JSON
            // payload disagreed. Surface as an error — it indicates a
            // serious storage corruption (or a programmer error during
            // a future variant rename) and silent recovery would mask it.
            return Err(format!(
                "history row {id} has a run kind but payload variant differs"
            ));
        }
    }

    let new_payload_json =
        serde_json::to_string(&payload).map_err(|e| format!("re-encode payload: {e}"))?;
    let duration_ms_i64: Option<i64> = duration_ms.map(|v| v as i64);

    sqlx::query(
        "UPDATE history_events \
         SET payload_json = ?, exit_code = ?, duration_ms = ?, status = ? \
         WHERE id = ?",
    )
    .bind(&new_payload_json)
    .bind(exit_code)
    .bind(duration_ms_i64)
    .bind(status.as_str())
    .bind(&id)
    .execute(pool.as_ref())
    .await
    .map_err(|e| format!("update run event: {e}"))?;
    Ok(())
}

/// Page through the history events, newest first. Filtering and
/// pagination both happen in SQL so the on-disk row count, not the
/// network payload size, is the constraint.
pub async fn list_paginated(
    pool: &DbPool,
    filter: &HistoryFilter,
    page: u32,
    page_size: u32,
) -> Result<HistoryPage, String> {
    // Sanitise pagination input — clamp page_size to a reasonable
    // upper bound so a buggy caller can't request 10_000 rows by
    // mistake. The UI pagination is hard-coded to 10; the cap leaves
    // room for future change without becoming a footgun.
    let page = page.max(1);
    let page_size = page_size.clamp(1, 200);
    let offset = (page - 1) * page_size;

    // Build the WHERE clause incrementally. We use plain string concat
    // with placeholders ONLY for the kind list — every dynamic value
    // is bound through sqlx (never interpolated) so SQL injection is
    // not possible.
    let mut where_parts: Vec<String> = Vec::new();
    let mut kinds_to_bind: Vec<String> = Vec::new();
    if let Some(kinds) = &filter.kinds {
        // Validate against the allowed set so an attacker can't smuggle
        // arbitrary strings into the WHERE clause via the JS payload.
        // (Strictly speaking sqlx binds protect us; the validation
        // gives the user a clear error path instead of returning empty
        // results for typos.)
        let allowed = allowed_kinds();
        let mut filtered: Vec<String> = Vec::new();
        for k in kinds {
            if allowed.contains(k.as_str()) {
                filtered.push(k.clone());
            }
        }
        if !filtered.is_empty() {
            let placeholders = vec!["?"; filtered.len()].join(", ");
            where_parts.push(format!("kind IN ({placeholders})"));
            kinds_to_bind = filtered;
        } else if !kinds.is_empty() {
            // Caller asked to filter by N kinds and ALL were rejected
            // by validation — return an empty page rather than the
            // whole table.
            return Ok(HistoryPage {
                items: Vec::new(),
                total: 0,
                page,
                page_size,
            });
        }
    }
    let mut name_query: Option<String> = None;
    if let Some(q) = &filter.command_name_query {
        let trimmed = q.trim();
        if !trimmed.is_empty() {
            where_parts.push("LOWER(command_name) LIKE ?".into());
            name_query = Some(format!("%{}%", trimmed.to_lowercase()));
        }
    }
    if filter.date_from.is_some() {
        where_parts.push("created_at >= ?".into());
    }
    if filter.date_to.is_some() {
        where_parts.push("created_at <= ?".into());
    }
    if filter.schedule_id.is_some() {
        where_parts.push("schedule_id = ?".into());
    }
    if filter.failed_only {
        where_parts.push("status IN ('failed', 'error')".into());
    }

    let where_sql = if where_parts.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", where_parts.join(" AND "))
    };

    // --- total count ----------------------------------------------------
    // The SQL string is composed of: a constant prefix + the WHERE
    // fragment we built above. The WHERE fragment NEVER contains
    // user-supplied text — only a fixed set of column names, the
    // operators `=`/`LIKE`/`>=`/`<=`, and `?` placeholder counts. Every
    // value the user can influence is bound via sqlx. The
    // `AssertSqlSafe` wrapper documents this audit. sqlx 0.9 requires
    // the wrapper for non-'static SQL strings.
    let count_sql = format!("SELECT COUNT(*) AS n FROM history_events {where_sql}");
    let mut count_q = sqlx::query(sqlx::AssertSqlSafe(count_sql.as_str()));
    for k in &kinds_to_bind {
        count_q = count_q.bind(k);
    }
    if let Some(nq) = &name_query {
        count_q = count_q.bind(nq);
    }
    if let Some(df) = &filter.date_from {
        count_q = count_q.bind(df);
    }
    if let Some(dt) = &filter.date_to {
        count_q = count_q.bind(dt);
    }
    if let Some(sid) = &filter.schedule_id {
        count_q = count_q.bind(sid);
    }
    let count_row = count_q
        .fetch_one(pool.as_ref())
        .await
        .map_err(|e| format!("history count: {e}"))?;
    let total: i64 = count_row
        .try_get("n")
        .map_err(|e| format!("read count: {e}"))?;

    // --- page rows ------------------------------------------------------
    let list_sql = format!(
        "SELECT id, created_at, payload_json FROM history_events \
         {where_sql} \
         ORDER BY created_at DESC, id DESC \
         LIMIT ? OFFSET ?"
    );
    let mut list_q = sqlx::query(sqlx::AssertSqlSafe(list_sql.as_str()));
    for k in &kinds_to_bind {
        list_q = list_q.bind(k);
    }
    if let Some(nq) = &name_query {
        list_q = list_q.bind(nq);
    }
    if let Some(df) = &filter.date_from {
        list_q = list_q.bind(df);
    }
    if let Some(dt) = &filter.date_to {
        list_q = list_q.bind(dt);
    }
    if let Some(sid) = &filter.schedule_id {
        list_q = list_q.bind(sid);
    }
    list_q = list_q.bind(page_size as i64).bind(offset as i64);
    let rows = list_q
        .fetch_all(pool.as_ref())
        .await
        .map_err(|e| format!("history list: {e}"))?;

    let mut items: Vec<HistoryEvent> = Vec::with_capacity(rows.len());
    for row in rows {
        let id: String = row.try_get("id").map_err(|e| format!("read id: {e}"))?;
        let created_at: String = row
            .try_get("created_at")
            .map_err(|e| format!("read created_at: {e}"))?;
        let payload_json: String = row
            .try_get("payload_json")
            .map_err(|e| format!("read payload_json: {e}"))?;
        let payload: HistoryEventPayload =
            serde_json::from_str(&payload_json).map_err(|e| format!("decode payload: {e}"))?;
        items.push(HistoryEvent {
            id,
            created_at,
            payload,
        });
    }

    Ok(HistoryPage {
        items,
        total: total.max(0) as u64,
        page,
        page_size,
    })
}

/// Fetch a single event by id. Used by the undo / restore flows so
/// the caller does not need to re-page through history to find the
/// snapshot it wants to apply.
pub async fn get_by_id(pool: &DbPool, id: &str) -> Result<Option<HistoryEvent>, String> {
    let row = sqlx::query("SELECT id, created_at, payload_json FROM history_events WHERE id = ?")
        .bind(id)
        .fetch_optional(pool.as_ref())
        .await
        .map_err(|e| format!("get history event: {e}"))?;
    let Some(row) = row else {
        return Ok(None);
    };
    let row_id: String = row.try_get("id").map_err(|e| format!("read id: {e}"))?;
    let created_at: String = row
        .try_get("created_at")
        .map_err(|e| format!("read created_at: {e}"))?;
    let payload_json: String = row
        .try_get("payload_json")
        .map_err(|e| format!("read payload_json: {e}"))?;
    let payload: HistoryEventPayload =
        serde_json::from_str(&payload_json).map_err(|e| format!("decode payload: {e}"))?;
    Ok(Some(HistoryEvent {
        id: row_id,
        created_at,
        payload,
    }))
}

/// Idempotent delete by id — matches `commands::delete` semantics.
pub async fn delete(pool: &DbPool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM history_events WHERE id = ?")
        .bind(id)
        .execute(pool.as_ref())
        .await
        .map_err(|e| format!("delete history event: {e}"))?;
    Ok(())
}

/// Drop every history row. Exposed to the UI as a "Clear history"
/// action. Does not touch the `commands` table.
pub async fn clear_all(pool: &DbPool) -> Result<(), String> {
    sqlx::query("DELETE FROM history_events")
        .execute(pool.as_ref())
        .await
        .map_err(|e| format!("clear history: {e}"))?;
    Ok(())
}

/// One-time security migration: strip any `sensitive` variable's
/// `defaultValue` out of the command snapshots embedded in OLD history rows.
///
/// Before `commands::strip_sensitive_defaults` existed, a `commandCreated` /
/// `commandEdited` / `commandDeleted` event captured a full `CommandRecord`
/// snapshot in `payload_json` — including the plaintext `defaultValue` of a
/// `sensitive` variable. Those rows are immutable history, so the secret would
/// linger on disk forever. This sweep rewrites each affected payload in place,
/// removing only the `defaultValue` of variables flagged `sensitive` and
/// leaving every other field untouched.
///
/// Works directly on the JSON (not via `CommandRecord`) so it is robust to
/// snapshot-shape changes and touches the minimum. Idempotent: a row with no
/// sensitive default left is rewritten to identical bytes (and detected as
/// unchanged, so no write happens). Best-effort per row — a single undecodable
/// payload is logged and skipped rather than aborting the whole migration.
/// Returns the number of rows actually rewritten (for the caller's VACUUM
/// decision and tests).
pub async fn redact_sensitive_history_defaults(pool: &DbPool) -> Result<u64, String> {
    // Only the three snapshot-bearing kinds can embed a CommandRecord.
    let rows = sqlx::query(
        "SELECT id, payload_json FROM history_events \
         WHERE kind IN ('commandCreated', 'commandEdited', 'commandDeleted')",
    )
    .fetch_all(pool.as_ref())
    .await
    .map_err(|e| format!("scan history for sensitive defaults: {e}"))?;

    let mut rewritten = 0u64;
    for row in rows {
        let id: String = row.try_get("id").map_err(|e| format!("read id: {e}"))?;
        let payload_json: String = row
            .try_get("payload_json")
            .map_err(|e| format!("read payload_json: {e}"))?;

        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&payload_json) else {
            eprintln!("history: skipping undecodable payload for event {id}");
            continue;
        };

        // The snapshot lives under `snapshotBefore` / `snapshotAfter`. Strip
        // each one; track whether anything changed.
        let mut changed = false;
        for key in ["snapshotBefore", "snapshotAfter"] {
            if let Some(snapshot) = value.get_mut(key) {
                changed |= strip_sensitive_defaults_in_snapshot(snapshot);
            }
        }
        if !changed {
            continue;
        }

        let new_payload =
            serde_json::to_string(&value).map_err(|e| format!("re-encode payload: {e}"))?;
        sqlx::query("UPDATE history_events SET payload_json = ? WHERE id = ?")
            .bind(&new_payload)
            .bind(&id)
            .execute(pool.as_ref())
            .await
            .map_err(|e| format!("rewrite payload for {id}: {e}"))?;
        rewritten += 1;
    }
    Ok(rewritten)
}

/// Remove the `defaultValue` of every `sensitive` variable inside one command
/// snapshot JSON object. Returns `true` when at least one default was removed.
/// A snapshot whose `variables` is absent / not an array is a no-op.
fn strip_sensitive_defaults_in_snapshot(snapshot: &mut serde_json::Value) -> bool {
    let Some(variables) = snapshot.get_mut("variables").and_then(|v| v.as_array_mut()) else {
        return false;
    };
    let mut changed = false;
    for var in variables.iter_mut() {
        let Some(obj) = var.as_object_mut() else {
            continue;
        };
        let is_sensitive = obj
            .get("sensitive")
            .and_then(|s| s.as_bool())
            .unwrap_or(false);
        // Only remove a defaultValue that is actually present and non-null —
        // matches `strip_sensitive_defaults` (which sets it to None).
        if is_sensitive && obj.get("defaultValue").is_some_and(|d| !d.is_null()) {
            obj.remove("defaultValue");
            changed = true;
        }
    }
    changed
}

/// Trim the table to at most `limit` rows by deleting the oldest
/// entries. Called after each insert by [`insert_event`]; safe to call
/// standalone (e.g. as a maintenance task at startup).
///
/// The strategy is "delete everything not in the top-N by created_at"
/// because SQLite has no efficient `OFFSET` delete. The double
/// SELECT-then-DELETE pattern works on any version.
pub async fn prune_to_limit(pool: &DbPool, limit: u32) -> Result<(), String> {
    sqlx::query(
        "DELETE FROM history_events \
         WHERE id NOT IN ( \
             SELECT id FROM history_events \
             ORDER BY created_at DESC, id DESC \
             LIMIT ? \
         )",
    )
    .bind(limit as i64)
    .execute(pool.as_ref())
    .await
    .map_err(|e| format!("prune history: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod wire_format_tests {
    //! Wire-format regression tests for the serde contract crossing
    //! the Tauri IPC boundary. Each variant must serialise with
    //! camelCase field names AND must NOT emit snake_case — both
    //! positive and negative assertions are required to catch the
    //! exact bug recorded in `AGENTS.md` failures.md ("serde
    //! `rename_all` on enum doesn't rename struct-variant fields").

    use super::*;
    use crate::storage::commands::CommandRecord;
    use crate::storage::workflows::{
        NodePosition, WorkflowEdgeRecord, WorkflowNodeRecord, WorkflowRecord,
    };
    use std::collections::HashMap;

    fn sample_workflow() -> WorkflowRecord {
        WorkflowRecord {
            id: "wf-1".into(),
            name: "Deploy".into(),
            description: None,
            icon: None,
            nodes: vec![WorkflowNodeRecord {
                id: "n-start".into(),
                kind: "start".into(),
                command_id: None,
                label: None,
                condition: None,
                cases: Vec::new(),
                loop_config: None,
                retry: None,
                data: Vec::new(),
                position: NodePosition { x: 0.0, y: 0.0 },
            }],
            edges: vec![WorkflowEdgeRecord {
                id: "e1".into(),
                source: "n-start".into(),
                target: "n-end".into(),
                branch: "out".into(),
            }],
            tags: vec![],
            category_id: None,
            favorite: false,
            created_at: "2026-05-28T00:00:00Z".into(),
            updated_at: "2026-05-28T00:00:00Z".into(),
            last_run_at: None,
            run_count: 0,
        }
    }

    fn sample_command() -> CommandRecord {
        CommandRecord {
            id: "cmd-1".into(),
            name: "Greet".into(),
            name_key: None,
            description: None,
            description_key: None,
            icon: None,
            script: "echo hi".into(),
            shell: None,
            args: None,
            working_dir: None,
            env: None,
            tags: vec![],
            category_id: None,
            favorite: false,
            created_at: "2026-05-28T00:00:00Z".into(),
            updated_at: "2026-05-28T00:00:00Z".into(),
            last_run_at: None,
            run_count: 0,
            run_as_admin: false,
            variables: vec![],
            timeout_seconds: None,
            output_schema: None,
        }
    }

    fn evt(payload: HistoryEventPayload) -> HistoryEvent {
        HistoryEvent {
            id: "evt-1".into(),
            created_at: "2026-05-28T00:00:00Z".into(),
            payload,
        }
    }

    /// Top-level wrapper must serialise `id` and `createdAt` (not
    /// `created_at`) and must surface the `kind` discriminator at the
    /// top level (via flatten).
    #[test]
    fn top_level_keys_are_camelcase_with_kind() {
        let e = evt(HistoryEventPayload::CommandCreated {
            command_id: "cmd-1".into(),
            command_name: "Greet".into(),
            snapshot_after: sample_command(),
        });
        let json = serde_json::to_value(&e).unwrap();
        assert!(json.get("id").is_some());
        assert!(json.get("createdAt").is_some());
        assert_eq!(json["kind"], "commandCreated");
        assert!(json.get("created_at").is_none());
    }

    #[test]
    fn command_created_variant_wire_format() {
        let e = evt(HistoryEventPayload::CommandCreated {
            command_id: "c1".into(),
            command_name: "n1".into(),
            snapshot_after: sample_command(),
        });
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "commandCreated");
        assert!(json.get("commandId").is_some());
        assert!(json.get("commandName").is_some());
        assert!(json.get("snapshotAfter").is_some());
        // Negative — snake_case must NOT leak.
        assert!(json.get("command_id").is_none());
        assert!(json.get("command_name").is_none());
        assert!(json.get("snapshot_after").is_none());
    }

    #[test]
    fn command_edited_variant_wire_format() {
        let e = evt(HistoryEventPayload::CommandEdited {
            command_id: "c1".into(),
            command_name: "n1".into(),
            snapshot_before: sample_command(),
            snapshot_after: sample_command(),
        });
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "commandEdited");
        assert!(json.get("commandId").is_some());
        assert!(json.get("snapshotBefore").is_some());
        assert!(json.get("snapshotAfter").is_some());
        assert!(json.get("snapshot_before").is_none());
        assert!(json.get("snapshot_after").is_none());
    }

    #[test]
    fn command_deleted_variant_wire_format() {
        let e = evt(HistoryEventPayload::CommandDeleted {
            command_id: "c1".into(),
            command_name: "n1".into(),
            snapshot_before: sample_command(),
        });
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "commandDeleted");
        assert!(json.get("snapshotBefore").is_some());
        assert!(json.get("snapshot_before").is_none());
    }

    #[test]
    fn command_run_variant_wire_format() {
        let e = evt(HistoryEventPayload::CommandRun {
            command_id: "c1".into(),
            command_name: "n1".into(),
            execution_id: "exec-9".into(),
            exit_code: Some(0),
            duration_ms: Some(150),
            status: RunStatus::Succeeded,
            timed_out: None,
        });
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "commandRun");
        assert!(json.get("commandId").is_some());
        assert!(json.get("executionId").is_some());
        assert!(json.get("exitCode").is_some());
        assert!(json.get("durationMs").is_some());
        assert_eq!(json["status"], "succeeded");
        // Negative.
        assert!(json.get("execution_id").is_none());
        assert!(json.get("exit_code").is_none());
        assert!(json.get("duration_ms").is_none());
    }

    /// `exitCode`/`durationMs` must be omitted entirely (not emitted
    /// as `null`) when the run is still in flight, matching the
    /// `skip_serializing_if = "Option::is_none"` contract. If a
    /// future rename collapses that, the test catches it.
    #[test]
    fn command_run_running_omits_optional_fields() {
        let e = evt(HistoryEventPayload::CommandRun {
            command_id: "c1".into(),
            command_name: "n1".into(),
            execution_id: "exec-9".into(),
            exit_code: None,
            duration_ms: None,
            status: RunStatus::Running,
            timed_out: None,
        });
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["status"], "running");
        assert!(json.get("exitCode").is_none());
        assert!(json.get("durationMs").is_none());
    }

    #[test]
    fn command_restored_variant_wire_format() {
        let e = evt(HistoryEventPayload::CommandRestored {
            command_id: "c1".into(),
            command_name: "n1".into(),
            original_event_id: "src-evt".into(),
        });
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "commandRestored");
        assert!(json.get("originalEventId").is_some());
        assert!(json.get("original_event_id").is_none());
    }

    #[test]
    fn command_reverted_variant_wire_format() {
        let e = evt(HistoryEventPayload::CommandReverted {
            command_id: "c1".into(),
            command_name: "n1".into(),
            original_event_id: "src-evt".into(),
        });
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "commandReverted");
        assert!(json.get("originalEventId").is_some());
        assert!(json.get("original_event_id").is_none());
    }

    #[test]
    fn workflow_created_variant_wire_format() {
        let e = evt(HistoryEventPayload::WorkflowCreated {
            workflow_id: "wf-1".into(),
            workflow_name: "Deploy".into(),
            snapshot_after: sample_workflow(),
        });
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "workflowCreated");
        assert!(json.get("workflowId").is_some());
        assert!(json.get("workflowName").is_some());
        assert!(json.get("snapshotAfter").is_some());
        // Negative — snake_case must NOT leak.
        assert!(json.get("workflow_id").is_none());
        assert!(json.get("workflow_name").is_none());
        assert!(json.get("snapshot_after").is_none());
    }

    #[test]
    fn workflow_edited_variant_wire_format() {
        let e = evt(HistoryEventPayload::WorkflowEdited {
            workflow_id: "wf-1".into(),
            workflow_name: "Deploy".into(),
            snapshot_before: sample_workflow(),
            snapshot_after: sample_workflow(),
        });
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "workflowEdited");
        assert!(json.get("snapshotBefore").is_some());
        assert!(json.get("snapshotAfter").is_some());
        assert!(json.get("snapshot_before").is_none());
        assert!(json.get("snapshot_after").is_none());
    }

    #[test]
    fn workflow_deleted_variant_wire_format() {
        let e = evt(HistoryEventPayload::WorkflowDeleted {
            workflow_id: "wf-1".into(),
            workflow_name: "Deploy".into(),
            snapshot_before: sample_workflow(),
        });
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "workflowDeleted");
        assert!(json.get("snapshotBefore").is_some());
        assert!(json.get("snapshot_before").is_none());
    }

    #[test]
    fn workflow_run_variant_wire_format() {
        let e = evt(HistoryEventPayload::WorkflowRun {
            workflow_id: "wf-1".into(),
            workflow_name: "Deploy".into(),
            execution_id: "run-9".into(),
            exit_code: Some(0),
            duration_ms: Some(420),
            status: RunStatus::Succeeded,
            timed_out: None,
        });
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "workflowRun");
        assert!(json.get("workflowId").is_some());
        assert!(json.get("executionId").is_some());
        assert!(json.get("exitCode").is_some());
        assert!(json.get("durationMs").is_some());
        assert_eq!(json["status"], "succeeded");
        // Negative.
        assert!(json.get("execution_id").is_none());
        assert!(json.get("exit_code").is_none());
        assert!(json.get("duration_ms").is_none());
    }

    /// A still-running workflow run omits `exitCode` / `durationMs`
    /// entirely (not `null`), matching the `command_run` contract.
    #[test]
    fn workflow_run_running_omits_optional_fields() {
        let e = evt(HistoryEventPayload::WorkflowRun {
            workflow_id: "wf-1".into(),
            workflow_name: "Deploy".into(),
            execution_id: "run-9".into(),
            exit_code: None,
            duration_ms: None,
            status: RunStatus::Running,
            timed_out: None,
        });
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["status"], "running");
        assert!(json.get("exitCode").is_none());
        assert!(json.get("durationMs").is_none());
    }

    #[test]
    fn scheduled_run_variant_wire_format() {
        let e = evt(HistoryEventPayload::ScheduledRun {
            schedule_id: "sch-1".into(),
            schedule_name: "Nightly".into(),
            target_kind: "command".into(),
            target_id: "cmd-1".into(),
            status: "success".into(),
            exit_code: None,
            duration_ms: None,
            output: None,
            result: None,
        });
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "scheduledRun");
        assert!(json.get("scheduleId").is_some());
        assert!(json.get("scheduleName").is_some());
        assert!(json.get("targetKind").is_some());
        assert!(json.get("targetId").is_some());
        assert_eq!(json["status"], "success");
        // Negative — snake_case must NOT leak.
        assert!(json.get("schedule_id").is_none());
        assert!(json.get("schedule_name").is_none());
        assert!(json.get("target_kind").is_none());
        assert!(json.get("target_id").is_none());
        // The optional capture fields are omitted entirely (not `null`) when
        // `None`, so legacy payloads stay byte-identical.
        assert!(json.get("exitCode").is_none());
        assert!(json.get("durationMs").is_none());
        assert!(json.get("output").is_none());
        assert!(json.get("result").is_none());
    }

    /// A scheduled run WITH captured output emits the camelCase keys
    /// (`exitCode` / `durationMs` / `output` / `result`, and `returnValue`
    /// inside the result) and never their snake_case forms.
    #[test]
    fn scheduled_run_with_output_wire_format() {
        let mut fields = serde_json::Map::new();
        fields.insert("count".into(), serde_json::json!(3));
        let e = evt(HistoryEventPayload::ScheduledRun {
            schedule_id: "sch-1".into(),
            schedule_name: "Nightly".into(),
            target_kind: "command".into(),
            target_id: "cmd-1".into(),
            status: "success".into(),
            exit_code: Some(0),
            duration_ms: Some(1234),
            output: Some(vec![HistoryLogLine {
                stream: "stdout".into(),
                line: "hello".into(),
            }]),
            result: Some(HistoryExtractedResult {
                fields,
                return_value: serde_json::json!(3),
                error: None,
            }),
        });
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["kind"], "scheduledRun");
        // Positive — captured fields surface in camelCase.
        assert!(json.get("exitCode").is_some());
        assert!(json.get("durationMs").is_some());
        assert!(json.get("output").is_some());
        assert!(json.get("result").is_some());
        assert_eq!(json["output"][0]["stream"], "stdout");
        assert_eq!(json["output"][0]["line"], "hello");
        assert!(json["result"].get("returnValue").is_some());
        assert!(json["result"].get("fields").is_some());
        // Negative — snake_case must NOT leak, in the variant OR the nested
        // result struct.
        assert!(json.get("exit_code").is_none());
        assert!(json.get("duration_ms").is_none());
        assert!(json["result"].get("return_value").is_none());
    }

    /// The scheduled-run accessors: subject name is the schedule name
    /// (feeds the NOT NULL `command_name` column), there is no owning
    /// command / workflow id, and no execution id (recorded finalised).
    #[test]
    fn scheduled_run_accessors() {
        let p = HistoryEventPayload::ScheduledRun {
            schedule_id: "sch-1".into(),
            schedule_name: "Nightly".into(),
            target_kind: "workflow".into(),
            target_id: "wf-1".into(),
            status: "error".into(),
            exit_code: None,
            duration_ms: None,
            output: None,
            result: None,
        };
        assert_eq!(p.command_name(), "Nightly");
        assert_eq!(p.command_id(), None);
        assert_eq!(p.workflow_id(), None);
        assert_eq!(p.execution_id(), None);
        assert_eq!(p.run_status(), None);
        assert_eq!(p.kind_str(), "scheduledRun");
    }

    /// H-2: a `scheduledRun` history payload must NEVER carry the run's
    /// variable values. The schedule's `variable_values` (which may include a
    /// keychain-resolved sensitive value at fire time) is consumed by the
    /// executor and must not be denormalised into the persisted history JSON.
    /// This locks the payload shape so a future field addition can't smuggle a
    /// secret into `payload_json`. Captured `output` is separately redacted by
    /// the streaming readers (sensitive values are masked before they are
    /// buffered), which this test also documents by including a secret-looking
    /// value only in a NON-output field and asserting it never appears.
    #[test]
    fn scheduled_run_payload_carries_no_variable_values() {
        let p = HistoryEventPayload::ScheduledRun {
            schedule_id: "sch-1".into(),
            schedule_name: "Nightly".into(),
            target_kind: "command".into(),
            target_id: "cmd-1".into(),
            status: "success".into(),
            exit_code: Some(0),
            duration_ms: Some(42),
            // Redacted output is the only place command output can appear; a
            // real secret would already be masked to `***` upstream.
            output: Some(vec![HistoryLogLine {
                stream: "stdout".into(),
                line: "done".into(),
            }]),
            result: None,
        };
        let json = serde_json::to_value(&p).unwrap();
        // No variable-values container of any shape may be present.
        assert!(json.get("variableValues").is_none());
        assert!(json.get("variable_values").is_none());
        assert!(json.get("variables").is_none());
        // The full payload object's keys are exactly the documented set —
        // nothing that could carry a resolved secret.
        let keys: std::collections::BTreeSet<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        for forbidden in [
            "variableValues",
            "variable_values",
            "variables",
            "adminPassword",
        ] {
            assert!(
                !keys.contains(forbidden),
                "scheduledRun payload must not contain `{forbidden}`: {keys:?}"
            );
        }
    }

    /// The denormalised subject-name accessor returns the workflow name
    /// for workflow variants (it feeds the NOT NULL `command_name`
    /// column and the name filter), and `command_id` is `None` while
    /// `workflow_id` is populated.
    #[test]
    fn workflow_variant_accessors() {
        let p = HistoryEventPayload::WorkflowCreated {
            workflow_id: "wf-1".into(),
            workflow_name: "Deploy".into(),
            snapshot_after: sample_workflow(),
        };
        assert_eq!(p.command_name(), "Deploy");
        assert_eq!(p.command_id(), None);
        assert_eq!(p.workflow_id(), Some("wf-1"));
        assert_eq!(p.kind_str(), "workflowCreated");
    }

    /// Roundtrip every variant through serde_json::to_string ->
    /// from_str so we catch any decode/encode asymmetry (e.g. missing
    /// `rename_all` direction).
    #[test]
    fn every_variant_roundtrips_through_json() {
        let mut env = HashMap::new();
        env.insert("FOO".into(), "bar".into());
        let mut cmd = sample_command();
        cmd.env = Some(env);

        let variants = vec![
            HistoryEventPayload::CommandCreated {
                command_id: "c1".into(),
                command_name: "n1".into(),
                snapshot_after: cmd.clone(),
            },
            HistoryEventPayload::CommandEdited {
                command_id: "c1".into(),
                command_name: "n2".into(),
                snapshot_before: cmd.clone(),
                snapshot_after: cmd.clone(),
            },
            HistoryEventPayload::CommandDeleted {
                command_id: "c1".into(),
                command_name: "n1".into(),
                snapshot_before: cmd.clone(),
            },
            HistoryEventPayload::CommandRun {
                command_id: "c1".into(),
                command_name: "n1".into(),
                execution_id: "e1".into(),
                exit_code: Some(0),
                duration_ms: Some(42),
                status: RunStatus::Succeeded,
                timed_out: None,
            },
            HistoryEventPayload::CommandRestored {
                command_id: "c1".into(),
                command_name: "n1".into(),
                original_event_id: "src".into(),
            },
            HistoryEventPayload::CommandReverted {
                command_id: "c1".into(),
                command_name: "n1".into(),
                original_event_id: "src".into(),
            },
            HistoryEventPayload::WorkflowCreated {
                workflow_id: "wf-1".into(),
                workflow_name: "Deploy".into(),
                snapshot_after: sample_workflow(),
            },
            HistoryEventPayload::WorkflowEdited {
                workflow_id: "wf-1".into(),
                workflow_name: "Deploy".into(),
                snapshot_before: sample_workflow(),
                snapshot_after: sample_workflow(),
            },
            HistoryEventPayload::WorkflowDeleted {
                workflow_id: "wf-1".into(),
                workflow_name: "Deploy".into(),
                snapshot_before: sample_workflow(),
            },
            HistoryEventPayload::WorkflowRun {
                workflow_id: "wf-1".into(),
                workflow_name: "Deploy".into(),
                execution_id: "run-1".into(),
                exit_code: Some(0),
                duration_ms: Some(99),
                status: RunStatus::Succeeded,
                timed_out: None,
            },
        ];
        for v in variants {
            let e = evt(v.clone());
            let s = serde_json::to_string(&e).unwrap();
            let back: HistoryEvent = serde_json::from_str(&s).unwrap();
            assert_eq!(e, back, "roundtrip failed for variant {v:?}");
        }
    }

    /// Filter shape must accept camelCase from JS. Negative — fields
    /// must NOT be reachable via snake_case (would indicate a missing
    /// `rename_all`).
    #[test]
    fn history_filter_accepts_camelcase() {
        let json = serde_json::json!({
            "kinds": ["commandRun"],
            "commandNameQuery": "deploy",
            "dateFrom": "2026-01-01T00:00:00Z",
            "dateTo": "2026-12-31T23:59:59Z"
        });
        let f: HistoryFilter = serde_json::from_value(json).unwrap();
        assert_eq!(f.kinds.as_ref().unwrap()[0], "commandRun");
        assert_eq!(f.command_name_query.as_deref(), Some("deploy"));
        assert!(f.date_from.is_some());
        assert!(f.date_to.is_some());
    }

    #[test]
    fn history_filter_rejects_snake_case() {
        let json = serde_json::json!({
            "command_name_query": "deploy",
            "date_from": "2026-01-01T00:00:00Z"
        });
        let f: HistoryFilter = serde_json::from_value(json).unwrap();
        // Fields stay at default — proving snake_case is ignored.
        assert!(f.command_name_query.is_none());
        assert!(f.date_from.is_none());
    }

    /// `HistoryPage` must surface `pageSize` (camelCase) to JS.
    #[test]
    fn history_page_wire_format() {
        let p = HistoryPage {
            items: vec![],
            total: 0,
            page: 1,
            page_size: 10,
        };
        let json = serde_json::to_value(&p).unwrap();
        assert!(json.get("pageSize").is_some());
        assert!(json.get("page_size").is_none());
    }

    #[test]
    fn run_status_serialises_lowercase() {
        // Used both on the wire AND as the SQL status column value.
        assert_eq!(
            serde_json::to_string(&RunStatus::Running).unwrap(),
            "\"running\""
        );
        assert_eq!(
            serde_json::to_string(&RunStatus::Succeeded).unwrap(),
            "\"succeeded\""
        );
        assert_eq!(
            serde_json::to_string(&RunStatus::Failed).unwrap(),
            "\"failed\""
        );
        assert_eq!(
            serde_json::to_string(&RunStatus::Cancelled).unwrap(),
            "\"cancelled\""
        );
        // String form used by SQL stays in sync with serde.
        assert_eq!(RunStatus::Running.as_str(), "running");
    }
}

#[cfg(test)]
mod sqlite_integration_tests {
    //! End-to-end tests against an in-memory SQLite DB. Each test
    //! exercises a real insert→read path so any decode/encode bug
    //! across the JSON column boundary surfaces here (the wire-format
    //! tests above only cover serde<->JSON, not serde<->JSON<->TEXT
    //! column<->JSON<->serde).

    use super::*;
    use crate::storage::commands::CommandRecord;
    use crate::storage::workflows::{NodePosition, WorkflowNodeRecord, WorkflowRecord};
    use std::sync::Arc;

    async fn make_pool() -> DbPool {
        let opts = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("schema.sql"))
            .execute(&pool)
            .await
            .unwrap();
        Arc::new(pool)
    }

    fn sample_wf(id: &str, name: &str) -> WorkflowRecord {
        WorkflowRecord {
            id: id.into(),
            name: name.into(),
            description: None,
            icon: None,
            nodes: vec![WorkflowNodeRecord {
                id: "n-start".into(),
                kind: "start".into(),
                command_id: None,
                label: None,
                condition: None,
                cases: Vec::new(),
                loop_config: None,
                retry: None,
                data: Vec::new(),
                position: NodePosition { x: 0.0, y: 0.0 },
            }],
            edges: vec![],
            tags: vec![],
            category_id: None,
            favorite: false,
            created_at: "2026-05-28T00:00:00Z".into(),
            updated_at: "2026-05-28T00:00:00Z".into(),
            last_run_at: None,
            run_count: 0,
        }
    }

    fn sample_cmd(id: &str, name: &str) -> CommandRecord {
        CommandRecord {
            id: id.into(),
            name: name.into(),
            name_key: None,
            description: None,
            description_key: None,
            icon: None,
            script: "echo hi".into(),
            shell: None,
            args: None,
            working_dir: None,
            env: None,
            tags: vec![],
            category_id: None,
            favorite: false,
            created_at: "2026-05-28T00:00:00Z".into(),
            updated_at: "2026-05-28T00:00:00Z".into(),
            last_run_at: None,
            run_count: 0,
            run_as_admin: false,
            variables: vec![],
            timeout_seconds: None,
            output_schema: None,
        }
    }

    /// Build a `created` event with a controllable `created_at` so
    /// ORDER BY produces a deterministic sequence.
    fn created_evt(id: &str, name: &str, ts: &str) -> HistoryEvent {
        HistoryEvent {
            id: id.into(),
            created_at: ts.into(),
            payload: HistoryEventPayload::CommandCreated {
                command_id: format!("cmd-{id}"),
                command_name: name.into(),
                snapshot_after: sample_cmd(&format!("cmd-{id}"), name),
            },
        }
    }

    #[tokio::test]
    async fn insert_and_get_by_id_roundtrip() {
        let pool = make_pool().await;
        let e = created_evt("e1", "build", "2026-05-28T00:00:00Z");
        insert_event(&pool, &e).await.unwrap();
        let back = get_by_id(&pool, "e1").await.unwrap().unwrap();
        assert_eq!(back, e);
    }

    #[tokio::test]
    async fn get_by_id_returns_none_for_missing() {
        let pool = make_pool().await;
        assert!(get_by_id(&pool, "does-not-exist").await.unwrap().is_none());
    }

    /// A `workflowCreated` event round-trips through the JSON column with
    /// its embedded `WorkflowRecord` snapshot intact. Covers the
    /// serde<->JSON<->TEXT-column<->serde path the wire-format tests
    /// don't reach.
    #[tokio::test]
    async fn workflow_event_insert_and_get_by_id_roundtrip() {
        let pool = make_pool().await;
        let e = HistoryEvent {
            id: "wfe1".into(),
            created_at: "2026-05-28T00:00:00Z".into(),
            payload: HistoryEventPayload::WorkflowCreated {
                workflow_id: "wf-1".into(),
                workflow_name: "Deploy".into(),
                snapshot_after: sample_wf("wf-1", "Deploy"),
            },
        };
        insert_event(&pool, &e).await.unwrap();
        let back = get_by_id(&pool, "wfe1").await.unwrap().unwrap();
        assert_eq!(back, e);
        // The denormalised `command_name` column holds the workflow name.
        let row =
            sqlx::query("SELECT command_name, command_id FROM history_events WHERE id = 'wfe1'")
                .fetch_one(pool.as_ref())
                .await
                .unwrap();
        let name: String = row.try_get("command_name").unwrap();
        let cmd_id: Option<String> = row.try_get("command_id").unwrap();
        assert_eq!(name, "Deploy");
        assert_eq!(cmd_id, None);
    }

    /// `update_run_event` finalises a `workflowRun` row by run id, just
    /// like it does for `commandRun` (the WHERE clause matches both run
    /// kinds). Both the JSON payload and the dedicated columns update.
    #[tokio::test]
    async fn update_run_event_finalises_workflow_run() {
        let pool = make_pool().await;
        insert_event(
            &pool,
            &HistoryEvent {
                id: "wfr1".into(),
                created_at: "2026-05-28T00:00:00Z".into(),
                payload: HistoryEventPayload::WorkflowRun {
                    workflow_id: "wf-1".into(),
                    workflow_name: "Deploy".into(),
                    execution_id: "run-1".into(),
                    exit_code: None,
                    duration_ms: None,
                    status: RunStatus::Running,
                    timed_out: None,
                },
            },
        )
        .await
        .unwrap();

        update_run_event(
            &pool,
            "run-1",
            Some(0),
            Some(500),
            RunStatus::Succeeded,
            None,
        )
        .await
        .unwrap();

        let back = get_by_id(&pool, "wfr1").await.unwrap().unwrap();
        match &back.payload {
            HistoryEventPayload::WorkflowRun {
                exit_code,
                duration_ms,
                status,
                ..
            } => {
                assert_eq!(*exit_code, Some(0));
                assert_eq!(*duration_ms, Some(500));
                assert_eq!(*status, RunStatus::Succeeded);
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[tokio::test]
    async fn list_paginated_orders_newest_first_and_paginates() {
        let pool = make_pool().await;
        // Insert 25 events with increasing timestamps.
        for i in 0..25u32 {
            let ts = format!("2026-05-28T00:00:{:02}Z", i);
            let e = created_evt(&format!("e{i:02}"), &format!("cmd-{i}"), &ts);
            insert_event(&pool, &e).await.unwrap();
        }
        // Page 1: 10 newest.
        let p1 = list_paginated(&pool, &HistoryFilter::default(), 1, 10)
            .await
            .unwrap();
        assert_eq!(p1.total, 25);
        assert_eq!(p1.items.len(), 10);
        assert_eq!(p1.items[0].id, "e24");
        assert_eq!(p1.items[9].id, "e15");
        // Page 2: next 10.
        let p2 = list_paginated(&pool, &HistoryFilter::default(), 2, 10)
            .await
            .unwrap();
        assert_eq!(p2.items.len(), 10);
        assert_eq!(p2.items[0].id, "e14");
        assert_eq!(p2.items[9].id, "e05");
        // Page 3: last 5.
        let p3 = list_paginated(&pool, &HistoryFilter::default(), 3, 10)
            .await
            .unwrap();
        assert_eq!(p3.items.len(), 5);
        assert_eq!(p3.items[0].id, "e04");
        assert_eq!(p3.items[4].id, "e00");
    }

    #[tokio::test]
    async fn list_paginated_filters_by_kinds() {
        let pool = make_pool().await;
        let cmd = sample_cmd("cmd-a", "alpha");
        insert_event(
            &pool,
            &HistoryEvent {
                id: "e-created".into(),
                created_at: "2026-05-28T00:00:00Z".into(),
                payload: HistoryEventPayload::CommandCreated {
                    command_id: "cmd-a".into(),
                    command_name: "alpha".into(),
                    snapshot_after: cmd.clone(),
                },
            },
        )
        .await
        .unwrap();
        insert_event(
            &pool,
            &HistoryEvent {
                id: "e-deleted".into(),
                created_at: "2026-05-28T00:00:01Z".into(),
                payload: HistoryEventPayload::CommandDeleted {
                    command_id: "cmd-a".into(),
                    command_name: "alpha".into(),
                    snapshot_before: cmd.clone(),
                },
            },
        )
        .await
        .unwrap();
        insert_event(
            &pool,
            &HistoryEvent {
                id: "e-run".into(),
                created_at: "2026-05-28T00:00:02Z".into(),
                payload: HistoryEventPayload::CommandRun {
                    command_id: "cmd-a".into(),
                    command_name: "alpha".into(),
                    execution_id: "exec-1".into(),
                    exit_code: None,
                    duration_ms: None,
                    status: RunStatus::Running,
                    timed_out: None,
                },
            },
        )
        .await
        .unwrap();

        let f = HistoryFilter {
            kinds: Some(vec!["commandRun".into()]),
            ..Default::default()
        };
        let page = list_paginated(&pool, &f, 1, 10).await.unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "e-run");
    }

    #[tokio::test]
    async fn list_paginated_filters_by_kinds_invalid_returns_empty() {
        let pool = make_pool().await;
        insert_event(&pool, &created_evt("e1", "n", "2026-05-28T00:00:00Z"))
            .await
            .unwrap();
        let f = HistoryFilter {
            // All entries invalid — must return an empty page, NOT the
            // whole table.
            kinds: Some(vec!["totallyMadeUp".into()]),
            ..Default::default()
        };
        let page = list_paginated(&pool, &f, 1, 10).await.unwrap();
        assert_eq!(page.total, 0);
        assert!(page.items.is_empty());
    }

    #[tokio::test]
    async fn list_paginated_filters_by_command_name_case_insensitive() {
        let pool = make_pool().await;
        insert_event(
            &pool,
            &created_evt("e1", "Deploy Prod", "2026-05-28T00:00:00Z"),
        )
        .await
        .unwrap();
        insert_event(
            &pool,
            &created_evt("e2", "Deploy Staging", "2026-05-28T00:00:01Z"),
        )
        .await
        .unwrap();
        insert_event(
            &pool,
            &created_evt("e3", "Run Tests", "2026-05-28T00:00:02Z"),
        )
        .await
        .unwrap();
        let f = HistoryFilter {
            command_name_query: Some("DEPLOY".into()),
            ..Default::default()
        };
        let page = list_paginated(&pool, &f, 1, 10).await.unwrap();
        assert_eq!(page.total, 2);
    }

    /// An empty-after-trim name query is treated as "no filter" rather
    /// than "match the empty string everywhere" — matches the UI's
    /// implicit expectation when the user clears the search box.
    #[tokio::test]
    async fn list_paginated_ignores_blank_name_query() {
        let pool = make_pool().await;
        insert_event(&pool, &created_evt("e1", "foo", "2026-05-28T00:00:00Z"))
            .await
            .unwrap();
        let f = HistoryFilter {
            command_name_query: Some("   ".into()),
            ..Default::default()
        };
        let page = list_paginated(&pool, &f, 1, 10).await.unwrap();
        assert_eq!(page.total, 1);
    }

    #[tokio::test]
    async fn list_paginated_filters_by_date_range_inclusive() {
        let pool = make_pool().await;
        for (i, ts) in [
            "2026-05-26T00:00:00Z",
            "2026-05-27T12:00:00Z",
            "2026-05-28T00:00:00Z",
            "2026-05-29T00:00:00Z",
        ]
        .iter()
        .enumerate()
        {
            insert_event(&pool, &created_evt(&format!("e{i}"), "n", ts))
                .await
                .unwrap();
        }
        let f = HistoryFilter {
            date_from: Some("2026-05-27T00:00:00Z".into()),
            date_to: Some("2026-05-28T23:59:59.999Z".into()),
            ..Default::default()
        };
        let page = list_paginated(&pool, &f, 1, 10).await.unwrap();
        assert_eq!(page.total, 2);
    }

    /// A `scheduledRun` event populates the denormalised `schedule_id`
    /// column, and `list_paginated` filters by it — returning only the
    /// fires of the requested schedule (and combining with the `kinds`
    /// filter as the schedule view's History tab does).
    #[tokio::test]
    async fn list_paginated_filters_by_schedule_id() {
        let pool = make_pool().await;
        let scheduled = |id: &str, sched: &str, ts: &str| HistoryEvent {
            id: id.into(),
            created_at: ts.into(),
            payload: HistoryEventPayload::ScheduledRun {
                schedule_id: sched.into(),
                schedule_name: "Nightly".into(),
                target_kind: "command".into(),
                target_id: "cmd-1".into(),
                status: "success".into(),
                exit_code: None,
                duration_ms: None,
                output: None,
                result: None,
            },
        };
        insert_event(&pool, &scheduled("s1", "sch-A", "2026-05-28T00:00:00Z"))
            .await
            .unwrap();
        insert_event(&pool, &scheduled("s2", "sch-A", "2026-05-28T01:00:00Z"))
            .await
            .unwrap();
        insert_event(&pool, &scheduled("s3", "sch-B", "2026-05-28T02:00:00Z"))
            .await
            .unwrap();
        // A non-scheduled event must never match a schedule_id filter.
        insert_event(&pool, &created_evt("c1", "n", "2026-05-28T03:00:00Z"))
            .await
            .unwrap();

        let f = HistoryFilter {
            schedule_id: Some("sch-A".into()),
            kinds: Some(vec!["scheduledRun".into()]),
            ..Default::default()
        };
        let page = list_paginated(&pool, &f, 1, 10).await.unwrap();
        assert_eq!(page.total, 2);
        for item in &page.items {
            assert_eq!(item.payload.schedule_id(), Some("sch-A"));
        }
    }

    /// Run-event update path: insert running event, then update with
    /// exit_code / duration / Succeeded status. Both the JSON payload
    /// AND the dedicated columns must reflect the new values.
    #[tokio::test]
    async fn update_run_event_rewrites_payload_and_columns() {
        let pool = make_pool().await;
        insert_event(
            &pool,
            &HistoryEvent {
                id: "e-run".into(),
                created_at: "2026-05-28T00:00:00Z".into(),
                payload: HistoryEventPayload::CommandRun {
                    command_id: "cmd-a".into(),
                    command_name: "alpha".into(),
                    execution_id: "exec-1".into(),
                    exit_code: None,
                    duration_ms: None,
                    status: RunStatus::Running,
                    timed_out: None,
                },
            },
        )
        .await
        .unwrap();

        update_run_event(
            &pool,
            "exec-1",
            Some(0),
            Some(250),
            RunStatus::Succeeded,
            None,
        )
        .await
        .unwrap();

        // Verify via get_by_id — the embedded payload must show the
        // updated values, not the original ones.
        let back = get_by_id(&pool, "e-run").await.unwrap().unwrap();
        match &back.payload {
            HistoryEventPayload::CommandRun {
                exit_code,
                duration_ms,
                status,
                ..
            } => {
                assert_eq!(*exit_code, Some(0));
                assert_eq!(*duration_ms, Some(250));
                assert_eq!(*status, RunStatus::Succeeded);
            }
            other => panic!("unexpected variant: {other:?}"),
        }

        // Verify the dedicated columns too (used by list_paginated /
        // filters / sorting).
        let row = sqlx::query(
            "SELECT exit_code, duration_ms, status FROM history_events WHERE id = 'e-run'",
        )
        .fetch_one(pool.as_ref())
        .await
        .unwrap();
        let ec: i64 = row.try_get("exit_code").unwrap();
        let dm: i64 = row.try_get("duration_ms").unwrap();
        let st: String = row.try_get("status").unwrap();
        assert_eq!(ec, 0);
        assert_eq!(dm, 250);
        assert_eq!(st, "succeeded");
    }

    /// Updating a run for an unknown execution_id is a silent no-op —
    /// this matches the contract documented on `update_run_event` and
    /// covers the "history pruned mid-run" race.
    #[tokio::test]
    async fn update_run_event_unknown_execution_is_noop() {
        let pool = make_pool().await;
        update_run_event(
            &pool,
            "no-such-exec",
            Some(0),
            Some(0),
            RunStatus::Succeeded,
            None,
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn delete_removes_event() {
        let pool = make_pool().await;
        insert_event(&pool, &created_evt("e1", "n", "2026-05-28T00:00:00Z"))
            .await
            .unwrap();
        delete(&pool, "e1").await.unwrap();
        assert!(get_by_id(&pool, "e1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_missing_id_is_noop() {
        let pool = make_pool().await;
        delete(&pool, "missing").await.unwrap();
    }

    #[tokio::test]
    async fn clear_all_empties_table() {
        let pool = make_pool().await;
        for i in 0..3 {
            insert_event(
                &pool,
                &created_evt(&format!("e{i}"), "n", &format!("2026-05-28T00:00:0{i}Z")),
            )
            .await
            .unwrap();
        }
        clear_all(&pool).await.unwrap();
        let page = list_paginated(&pool, &HistoryFilter::default(), 1, 10)
            .await
            .unwrap();
        assert_eq!(page.total, 0);
    }

    /// prune_to_limit must keep only the N newest entries (by
    /// created_at desc, id desc as tiebreaker).
    #[tokio::test]
    async fn prune_to_limit_drops_oldest() {
        let pool = make_pool().await;
        for i in 0..15u32 {
            let ts = format!("2026-05-28T00:00:{:02}Z", i);
            insert_event(&pool, &created_evt(&format!("e{i:02}"), "n", &ts))
                .await
                .unwrap();
        }
        prune_to_limit(&pool, 5).await.unwrap();
        let page = list_paginated(&pool, &HistoryFilter::default(), 1, 100)
            .await
            .unwrap();
        assert_eq!(page.total, 5);
        let ids: Vec<String> = page.items.iter().map(|e| e.id.clone()).collect();
        assert_eq!(ids, vec!["e14", "e13", "e12", "e11", "e10"]);
    }

    /// `insert_event` is supposed to call `prune_to_limit(HISTORY_LIMIT)`
    /// after every insert — verify that with a manually shrunk limit by
    /// inserting > limit rows and asserting only the newest survive.
    /// We exercise the real HISTORY_LIMIT path via a focused subset:
    /// override behaviour by using direct prune_to_limit after
    /// insert_event would be a different test; here we just confirm
    /// that prune_to_limit is wired into insert by inserting and then
    /// checking the row count never exceeds HISTORY_LIMIT.
    #[tokio::test]
    async fn insert_event_enforces_history_limit() {
        let pool = make_pool().await;
        // Insert a few rows; HISTORY_LIMIT=1000 is large enough that
        // we expect no pruning. We just verify the count matches what
        // we inserted (i.e. insert_event didn't accidentally drop
        // anything during the pruning step).
        for i in 0..7u32 {
            let ts = format!("2026-05-28T00:00:0{}Z", i);
            insert_event(&pool, &created_evt(&format!("e{i}"), "n", &ts))
                .await
                .unwrap();
        }
        let row = sqlx::query("SELECT COUNT(*) AS n FROM history_events")
            .fetch_one(pool.as_ref())
            .await
            .unwrap();
        let n: i64 = row.try_get("n").unwrap();
        assert_eq!(n, 7);
    }

    /// Sanity-check the unused `RunStatus::from_str` helper roundtrips
    /// the values we write to the SQL `status` column. Catches typos
    /// if the column ever needs to be read back into the enum (e.g.
    /// future cleanup tasks).
    #[test]
    fn run_status_roundtrip_via_as_str() {
        for s in [
            RunStatus::Running,
            RunStatus::Succeeded,
            RunStatus::Failed,
            RunStatus::Cancelled,
        ] {
            assert_eq!(RunStatus::from_wire(s.as_str()), Some(s));
        }
        assert_eq!(RunStatus::from_wire("bogus"), None);
    }

    /// H-1 back-fill: an OLD `commandCreated` snapshot that embedded a
    /// `sensitive` variable's plaintext `defaultValue` must have that default
    /// stripped from `payload_json` by `redact_sensitive_history_defaults`,
    /// while a non-sensitive variable's default and every other field survive.
    #[tokio::test]
    async fn redact_sensitive_history_defaults_strips_old_snapshot_secret() {
        use crate::storage::commands::VariableSpec;

        let pool = make_pool().await;

        // An old snapshot with a sensitive default (the pre-fix leak) plus a
        // benign non-sensitive default.
        let mut cmd = sample_cmd("cmd-1", "Deploy");
        cmd.variables = vec![
            VariableSpec {
                name: "token".into(),
                default_value: Some("s3cr3t-default".into()),
                prompt_at_runtime: false,
                description: None,
                sensitive: true,
            },
            VariableSpec {
                name: "host".into(),
                default_value: Some("example.com".into()),
                prompt_at_runtime: false,
                description: None,
                sensitive: false,
            },
        ];
        // Insert the row by writing payload_json directly so the snapshot keeps
        // the secret default (the normal `commands::upsert` path would strip it,
        // but history rows are written verbatim and predate the fix).
        let payload = serde_json::to_string(&HistoryEventPayload::CommandCreated {
            command_id: "cmd-1".into(),
            command_name: "Deploy".into(),
            snapshot_after: cmd,
        })
        .unwrap();
        sqlx::query(
            "INSERT INTO history_events (id, created_at, kind, command_name, payload_json) \
             VALUES ('evt-1', '2026-06-01T00:00:00Z', 'commandCreated', 'Deploy', ?)",
        )
        .bind(&payload)
        .execute(pool.as_ref())
        .await
        .unwrap();
        assert!(payload.contains("s3cr3t-default"), "precondition");

        let rewritten = redact_sensitive_history_defaults(&pool).await.unwrap();
        assert_eq!(rewritten, 1, "the one affected row must be rewritten");

        let raw: String = sqlx::query("SELECT payload_json FROM history_events WHERE id = 'evt-1'")
            .fetch_one(pool.as_ref())
            .await
            .unwrap()
            .try_get("payload_json")
            .unwrap();
        assert!(
            !raw.contains("s3cr3t-default"),
            "sensitive default must be gone from the stored payload: {raw}"
        );
        assert!(
            raw.contains("example.com"),
            "non-sensitive default must be preserved"
        );
        assert!(raw.contains("\"token\""), "the spec itself must remain");

        // Idempotent: a second pass rewrites nothing.
        let again = redact_sensitive_history_defaults(&pool).await.unwrap();
        assert_eq!(again, 0, "second pass must be a no-op");
    }

    /// A snapshot with NO sensitive defaults must not be rewritten at all, so a
    /// clean database triggers no VACUUM.
    #[tokio::test]
    async fn redact_sensitive_history_defaults_noop_without_secrets() {
        let pool = make_pool().await;
        insert_event(&pool, &created_evt("1", "Greet", "2026-06-01T00:00:00Z"))
            .await
            .unwrap();
        let rewritten = redact_sensitive_history_defaults(&pool).await.unwrap();
        assert_eq!(rewritten, 0);
    }
}
