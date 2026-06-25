//! Scheduler (cron) commands — v0.2.0.
//!
//! Schedules fire commands / workflows automatically while the app is
//! running (see core::scheduler). Every mutation signals the running loop to
//! reload so the change takes effect immediately. Schedules are deliberately
//! NOT part of export/import — they are local to a machine's clock.

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::core::executor::ExecutorState;
use crate::core::scheduler::{self, SchedulerState};
use crate::core::workflow::WorkflowExecutorState;
use crate::storage::commands as storage_commands;
use crate::storage::schedules as storage_schedules;
use crate::storage::DbPool;

#[tauri::command]
pub async fn list_schedules(
    pool: State<'_, DbPool>,
) -> Result<Vec<storage_schedules::ScheduleRecord>, String> {
    storage_schedules::list_all(pool.inner()).await
}

/// Insert-or-update a schedule. The cron expression is validated before any
/// write (returns `INVALID_CRON` on a syntax error). After a successful write
/// the running scheduler loop is signalled to reload so the change is picked
/// up immediately.
/// Collect the names of every `sensitive` variable declared by the command
/// `command_id`. Used by `upsert_schedule` to tell the storage layer which
/// scheduled values to move into the OS keychain. A missing command (or a load
/// failure) yields an empty set — the upsert then persists nothing as a secret,
/// which is the safe default (no value is wrongly treated as secret, and the
/// command-not-found case surfaces later as a `missingVariable`/error fire).
async fn resolve_sensitive_var_names(
    pool: &DbPool,
    command_id: &str,
) -> std::collections::BTreeSet<String> {
    let Ok(commands) = storage_commands::list_all(pool).await else {
        return std::collections::BTreeSet::new();
    };
    commands
        .into_iter()
        .find(|c| c.id == command_id)
        .map(|c| {
            c.variables
                .iter()
                .filter(|spec| spec.sensitive)
                .map(|spec| spec.name.clone())
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn upsert_schedule(
    pool: State<'_, DbPool>,
    scheduler_state: State<'_, Arc<SchedulerState>>,
    schedule: storage_schedules::ScheduleRecord,
) -> Result<(), String> {
    // Validate the cron expression up front so a bad value never reaches the
    // table (where the loop would silently skip it).
    scheduler::cron_spec::validate(&schedule.cron).map_err(|_| "INVALID_CRON".to_string())?;

    // Resolve which of the target command's variables are `sensitive` so the
    // storage layer can move their values into the OS keychain instead of
    // persisting them as plaintext in the `variable_values` JSON column. Only
    // applies to `command` targets — workflow targets do not flow sensitive
    // schedule prompts in v1 (the nested value shape has no single command spec
    // to consult), so they pass an empty set and round-trip unchanged.
    let sensitive_vars = if schedule.target_kind == "command" {
        resolve_sensitive_var_names(pool.inner(), &schedule.target_id).await
    } else {
        std::collections::BTreeSet::new()
    };

    storage_schedules::upsert(pool.inner(), &schedule, &sensitive_vars).await?;
    // The record carries the frontend's (now stale) `next_run_at`; recompute it
    // from the just-saved cron so the schedule tile's cached display value
    // reflects the edit instead of the old time.
    scheduler::recompute_next_run(pool.inner(), &schedule).await?;
    scheduler_state.inner().signal_reload();
    Ok(())
}

#[tauri::command]
pub async fn delete_schedule(
    pool: State<'_, DbPool>,
    scheduler_state: State<'_, Arc<SchedulerState>>,
    id: String,
) -> Result<(), String> {
    storage_schedules::delete(pool.inner(), &id).await?;
    scheduler_state.inner().signal_reload();
    Ok(())
}

/// Toggle a schedule's `enabled` flag. The frontend supplies `updated_at`
/// (matching the JS-owned timestamp convention). Reloads the loop so an
/// enabled schedule starts firing (or a disabled one stops) immediately.
#[tauri::command]
pub async fn set_schedule_enabled(
    pool: State<'_, DbPool>,
    scheduler_state: State<'_, Arc<SchedulerState>>,
    id: String,
    enabled: bool,
    updated_at: String,
) -> Result<(), String> {
    storage_schedules::set_enabled(pool.inner(), &id, enabled, &updated_at).await?;
    // Refresh the cached `next_run_at` so the tile reflects the new state:
    // disabling clears it (shows "never"); enabling recomputes the next fire.
    scheduler::recompute_next_run_by_id(pool.inner(), &id).await?;
    scheduler_state.inner().signal_reload();
    Ok(())
}

/// Manually fire a schedule's target NOW, out of band. Runs through the same
/// headless fire path as a cron tick (honouring timeout / retries / stored
/// variables) and records a `scheduledRun` history event, but does NOT touch
/// the schedule's stats or `next_run_at` — the cron timing is unaffected.
#[tauri::command]
pub async fn run_schedule_now(
    app: AppHandle,
    executor_state: State<'_, Arc<ExecutorState>>,
    workflow_state: State<'_, Arc<WorkflowExecutorState>>,
    pool: State<'_, DbPool>,
    id: String,
) -> Result<(), String> {
    scheduler::run_now(
        &app,
        pool.inner(),
        executor_state.inner(),
        workflow_state.inner(),
        &id,
    )
    .await
}

/// Preview the next `count` fire times for a cron expression WITHOUT saving
/// anything. Drives the live preview in the schedule form. Returns the
/// times as RFC 3339 local-time strings, or `INVALID_CRON` when the
/// expression does not parse.
#[tauri::command]
pub fn preview_next_runs(cron: String, count: u32) -> Result<Vec<String>, String> {
    scheduler::cron_spec::validate(&cron).map_err(|_| "INVALID_CRON".to_string())?;
    let count = count.clamp(1, 20) as usize;
    let mut out = Vec::with_capacity(count);
    let mut cursor = chrono::Local::now();
    for _ in 0..count {
        match scheduler::cron_spec::next_after(&cron, &cursor) {
            Ok(Some(next)) => {
                out.push(next.to_rfc3339());
                cursor = next;
            }
            // No further occurrences (e.g. a one-off year in the past) —
            // stop early rather than erroring.
            Ok(None) => break,
            Err(_) => return Err("INVALID_CRON".to_string()),
        }
    }
    Ok(out)
}
