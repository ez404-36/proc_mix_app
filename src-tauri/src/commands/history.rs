//! History commands.
//!
//! All six handlers wrap the corresponding `storage::history` function.
//! IPC payload shapes are defined by the serde-derived structs in
//! `storage::history`; the wire-format tests in that module lock the
//! camelCase contract on both directions. UI callers go through
//! `src/utils/historyRepository.ts` rather than `invoke()` directly.

use tauri::State;

use crate::storage::history as storage_history;
use crate::storage::DbPool;

/// Page through history events. Empty/missing filter fields mean "no
/// constraint". Returns a `HistoryPage` containing the page items, the
/// total matching-row count for the paginator, and the resolved page +
/// page_size after clamping.
#[tauri::command]
pub async fn list_history(
    pool: State<'_, DbPool>,
    filter: storage_history::HistoryFilter,
    page: u32,
    page_size: u32,
) -> Result<storage_history::HistoryPage, String> {
    storage_history::list_paginated(pool.inner(), &filter, page, page_size).await
}

/// Fetch a single event by id. Used by undo/restore — the UI knows the
/// id of the source event and needs only the snapshot.
#[tauri::command]
pub async fn get_history_event(
    pool: State<'_, DbPool>,
    id: String,
) -> Result<Option<storage_history::HistoryEvent>, String> {
    storage_history::get_by_id(pool.inner(), &id).await
}

/// Persist a new event. The caller (frontend) generates `id` and
/// `createdAt` — same convention used by `upsert_command`. Returns the
/// id back so the caller has a single source of truth in case it wants
/// to display the freshly-inserted row.
#[tauri::command]
pub async fn record_history_event(
    pool: State<'_, DbPool>,
    event: storage_history::HistoryEvent,
) -> Result<String, String> {
    let id = event.id.clone();
    storage_history::insert_event(pool.inner(), &event).await?;
    Ok(id)
}

/// Update an in-flight `command_run` / `workflow_run` event with the final
/// outcome. Called by `useExecutionBridge` / `useWorkflowBridge` when a run
/// reaches a terminal state. `output` / `result` carry the captured aggregate
/// console output and any structured extraction so the History view can replay
/// a finished run (bounded by `MAX_HISTORY_OUTPUT_BYTES` in the storage layer).
/// A missing `execution_id` is a no-op (see the storage-layer docstring).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_run_history_event(
    pool: State<'_, DbPool>,
    execution_id: String,
    exit_code: Option<i32>,
    duration_ms: Option<u64>,
    status: storage_history::RunStatus,
    timed_out: Option<bool>,
    output: Option<Vec<storage_history::HistoryLogLine>>,
    result: Option<storage_history::HistoryExtractedResult>,
) -> Result<(), String> {
    storage_history::update_run_event(
        pool.inner(),
        &execution_id,
        exit_code,
        duration_ms,
        status,
        timed_out,
        output,
        result,
    )
    .await
}

/// Delete a single event by id. Idempotent.
#[tauri::command]
pub async fn delete_history_event(pool: State<'_, DbPool>, id: String) -> Result<(), String> {
    storage_history::delete(pool.inner(), &id).await
}

/// Drop history rows. Backs the "Clear history" UI action. The UI computes
/// an ISO-8601 cutoff from the chosen range and passes exactly one bound:
///
///   * `after = Some(iso)`  → delete rows AT OR NEWER than the cutoff
///     (`created_at >= after`). Used by the recency-window options
///     (last hour / today / last week) which clear the most recent records.
///   * `before = Some(iso)` → delete rows OLDER than the cutoff
///     (`created_at < before`). Used by "older than N days".
///   * both `None`          → clear the whole table ("all time").
///
/// `after` takes precedence if both are somehow set.
#[tauri::command]
pub async fn clear_history(
    pool: State<'_, DbPool>,
    after: Option<String>,
    before: Option<String>,
) -> Result<(), String> {
    match (after, before) {
        (Some(cutoff), _) => storage_history::clear_after(pool.inner(), &cutoff).await,
        (None, Some(cutoff)) => storage_history::clear_before(pool.inner(), &cutoff).await,
        (None, None) => storage_history::clear_all(pool.inner()).await,
    }
}
