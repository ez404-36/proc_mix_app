//! The scheduling driver: the single in-process tick loop, startup catch-up,
//! and the next-run recompute helpers. The loop sleeps until the nearest due
//! time (or a reload signal), fires every due schedule in its own task, and
//! recomputes.

use std::collections::HashSet;
use std::sync::Arc;

use chrono::{DateTime, Local};
use tauri::{AppHandle, Runtime};
use tokio::sync::{Mutex, Notify};

use crate::core::executor::ExecutorState;
use crate::core::workflow::WorkflowExecutorState;
use crate::storage::schedules::{self as storage_schedules, ScheduleRecord};
use crate::storage::DbPool;

use super::fire::{fire_schedule, record_outcome};
use super::{
    compute_due, cron_spec, CommandFireResult, DueInput, FireStatus, SchedulerState,
    MAX_CATCH_UP_RUNS, MAX_SLEEP_SECS,
};

/// Spawn the scheduler loop on Tauri's managed Tokio runtime. Returns
/// immediately; the loop runs until the process exits. Called once from the
/// Tauri `setup` hook after the pool and license state are ready.
///
/// Uses `tauri::async_runtime::spawn` rather than a bare `tokio::spawn`: the
/// `setup` hook runs on the main thread with NO ambient Tokio runtime, so
/// `tokio::spawn` there panics with "there is no reactor running". The Tauri
/// async runtime is the same one every `#[tauri::command]` and the executor
/// run on, so the spawned loop shares their reactor.
pub fn spawn_scheduler_loop<R: Runtime>(
    app: AppHandle<R>,
    state: Arc<SchedulerState>,
    pool: DbPool,
    executor_state: Arc<ExecutorState>,
    workflow_state: Arc<WorkflowExecutorState>,
) {
    let reload = state.reload_handle();
    let in_flight = state.in_flight_handle();
    tauri::async_runtime::spawn(async move {
        run_loop(app, reload, in_flight, pool, executor_state, workflow_state).await;
    });
}

async fn run_loop<R: Runtime>(
    app: AppHandle<R>,
    reload: Arc<Notify>,
    in_flight: Arc<Mutex<HashSet<String>>>,
    pool: DbPool,
    executor_state: Arc<ExecutorState>,
    workflow_state: Arc<WorkflowExecutorState>,
) {
    // Startup catch-up: for schedules whose catch_up_policy is not "none",
    // replay occurrences missed while the app was closed (one run for "once",
    // up to MAX_CATCH_UP_RUNS for "all"). Schedules with policy "none" are
    // untouched here — their missed runs are simply skipped.
    catch_up_on_startup(&app, &pool, &executor_state, &workflow_state).await;

    // Then recompute every enabled schedule's next_run from now so the cached
    // display value is accurate and the loop's first tick does not re-fire a
    // just-replayed occurrence.
    if let Err(e) = recompute_all_next_runs(&pool).await {
        eprintln!("scheduler: failed to recompute next runs on startup: {e}");
    }

    loop {
        let now = Local::now();
        let schedules = match storage_schedules::list_all(&pool).await {
            Ok(list) => list,
            Err(e) => {
                eprintln!("scheduler: failed to list schedules: {e}");
                // Back off briefly, then retry rather than spinning.
                tokio::time::sleep(std::time::Duration::from_secs(MAX_SLEEP_SECS)).await;
                continue;
            }
        };

        let inputs: Vec<DueInput> = schedules
            .iter()
            .map(|s| DueInput {
                id: s.id.clone(),
                enabled: s.enabled,
                cron: s.cron.clone(),
                next_run: parse_local(s.next_run_at.as_deref()),
            })
            .collect();

        let outcome = compute_due(&inputs, now);

        // Fire each due schedule. We re-find the full record by id so the
        // fire path has the cron / target / variable values. Each fire runs
        // in its OWN task so a long-running command never blocks the loop
        // (which must stay responsive to other schedules and reload signals).
        for id in &outcome.due_ids {
            let Some(rec) = schedules.iter().find(|s| &s.id == id).cloned() else {
                continue;
            };

            // skip_if_running: if the previous fire of this schedule is still
            // in flight, record a `skipped` run and do not start another.
            let mut guard = in_flight.lock().await;
            if rec.skip_if_running && guard.contains(&rec.id) {
                drop(guard);
                let now_iso = Local::now().to_rfc3339();
                let next_run = cron_spec::next_after(&rec.cron, &Local::now())
                    .ok()
                    .flatten()
                    .map(|dt| dt.to_rfc3339());
                record_outcome(
                    &pool,
                    &rec,
                    &now_iso,
                    FireStatus::Skipped,
                    next_run.as_deref(),
                    &CommandFireResult::default(),
                )
                .await;
                continue;
            }
            guard.insert(rec.id.clone());
            drop(guard);

            // Advance the persisted next_run_at BEFORE spawning the fire so
            // the next loop iteration does not re-fire this same schedule
            // while the fire is still in flight (the fire task records the
            // final outcome, which also rewrites next_run_at to the same
            // value — idempotent).
            let next_run = cron_spec::next_after(&rec.cron, &Local::now())
                .ok()
                .flatten()
                .map(|dt| dt.to_rfc3339());
            if let Err(e) =
                storage_schedules::set_next_run(&pool, &rec.id, next_run.as_deref()).await
            {
                eprintln!("scheduler: failed to advance next_run for {}: {e}", rec.id);
            }

            let app = app.clone();
            let pool = pool.clone();
            let executor_state = executor_state.clone();
            let workflow_state = workflow_state.clone();
            let in_flight = in_flight.clone();
            tokio::spawn(async move {
                // Planned (cron) fire: silent — no live console stream. The
                // history record (with captured output, when enabled) is the
                // source of truth.
                fire_schedule(&app, &pool, &executor_state, &workflow_state, &rec, true).await;
                in_flight.lock().await.remove(&rec.id);
            });
        }

        // Compute the sleep duration: until the earliest future fire time,
        // clamped to MAX_SLEEP_SECS so wake-from-sleep is handled promptly.
        let sleep_for = match outcome.next_wake {
            Some(wake) => {
                let delta = wake - Local::now();
                let secs = delta.num_seconds();
                if secs <= 0 {
                    // The next wake is already due (fired this tick or clock
                    // skew) — loop again immediately after a tiny yield.
                    std::time::Duration::from_millis(200)
                } else {
                    std::time::Duration::from_secs((secs as u64).min(MAX_SLEEP_SECS))
                }
            }
            // No enabled schedules: sleep the max, waiting for a reload.
            None => std::time::Duration::from_secs(MAX_SLEEP_SECS),
        };

        // Wake on whichever comes first: the timer or a reload signal.
        tokio::select! {
            _ = tokio::time::sleep(sleep_for) => {}
            _ = reload.notified() => {}
        }
    }
}

/// Compute the cached `next_run_at` value for a schedule from `now`: the next
/// fire time (RFC 3339 local) for an enabled schedule, or `None` when the
/// schedule is disabled or has no future occurrence. Pure (no I/O) so the
/// derivation is unit-testable and shared by startup recompute, the loop, and
/// the upsert command.
pub fn compute_next_run(enabled: bool, cron: &str, now: &DateTime<Local>) -> Option<String> {
    if !enabled {
        return None;
    }
    cron_spec::next_after(cron, now)
        .ok()
        .flatten()
        .map(|dt| dt.to_rfc3339())
}

/// Recompute and persist `next_run_at` for a single schedule from the current
/// time, derived from the just-saved record. Called after an upsert so the
/// cached display value (shown on the schedule tile) reflects the saved cron /
/// enabled state instead of the stale value the frontend supplied in the
/// record.
pub async fn recompute_next_run(pool: &DbPool, sched: &ScheduleRecord) -> Result<(), String> {
    let now = Local::now();
    let next = compute_next_run(sched.enabled, &sched.cron, &now);
    storage_schedules::set_next_run(pool, &sched.id, next.as_deref()).await
}

/// Recompute and persist `next_run_at` for a schedule identified by `id`,
/// reading the stored record first. Used by the enable-toggle path (which only
/// has the id) so disabling clears the cached time and enabling refreshes it.
/// A missing id is a no-op.
pub async fn recompute_next_run_by_id(pool: &DbPool, id: &str) -> Result<(), String> {
    let Some(sched) = storage_schedules::get(pool, id).await? else {
        return Ok(());
    };
    recompute_next_run(pool, &sched).await
}

/// Recompute and persist `next_run_at` for every enabled schedule from the
/// current time. Disabled schedules get `next_run_at = NULL`. Used on startup
/// (missed-run = skip) so the cached display value is accurate and the loop's
/// first tick does not replay a stale occurrence.
async fn recompute_all_next_runs(pool: &DbPool) -> Result<(), String> {
    let now = Local::now();
    let schedules = storage_schedules::list_all(pool).await?;
    for s in &schedules {
        let next = compute_next_run(s.enabled, &s.cron, &now);
        storage_schedules::set_next_run(pool, &s.id, next.as_deref()).await?;
    }
    Ok(())
}

/// Decide how many catch-up runs to fire for one schedule, given its policy
/// and the count of occurrences missed while closed. Pure (no I/O) so the
/// decision is unit-testable:
///   - `"once"` → at most 1 (only if at least one occurrence was missed);
///   - `"all"`  → every missed occurrence (already capped by the caller);
///   - anything else (`"none"` / unknown) → 0.
fn catch_up_run_count(policy: &str, missed: usize) -> usize {
    match policy {
        "once" if missed > 0 => 1,
        "all" => missed,
        _ => 0,
    }
}

/// On startup, replay missed occurrences for enabled schedules whose
/// `catch_up_policy` is `"once"` or `"all"`. The anchor for "what was missed"
/// is the last actual run (`last_run_at`); if the schedule never ran we fall
/// back to the cached `next_run_at` (the soonest occurrence that was already
/// due while closed). Runs are fired sequentially and awaited so they don't
/// all start at once. Schedules with policy `"none"` are ignored here.
async fn catch_up_on_startup<R: Runtime>(
    app: &AppHandle<R>,
    pool: &DbPool,
    executor_state: &Arc<ExecutorState>,
    workflow_state: &Arc<WorkflowExecutorState>,
) {
    let now = Local::now();
    let schedules = match storage_schedules::list_all(pool).await {
        Ok(list) => list,
        Err(e) => {
            eprintln!("scheduler: catch-up failed to list schedules: {e}");
            return;
        }
    };

    for rec in &schedules {
        if !rec.enabled || rec.catch_up_policy == "none" {
            continue;
        }
        // Anchor: prefer the last actual run; else the cached next_run_at (the
        // occurrence that was already due before launch). No anchor → the
        // schedule has never had a known due time, so nothing to catch up.
        let anchor = parse_local(rec.last_run_at.as_deref())
            .or_else(|| parse_local(rec.next_run_at.as_deref()));
        let Some(anchor) = anchor else {
            continue;
        };

        let missed = cron_spec::missed_occurrences(&rec.cron, &anchor, &now, MAX_CATCH_UP_RUNS);
        let runs = catch_up_run_count(&rec.catch_up_policy, missed);
        for _ in 0..runs {
            // Each catch-up uses the normal fire path so it records history +
            // bumps run_count exactly like a live fire. Awaited sequentially.
            // Catch-up replays a MISSED planned occurrence, so it is silent —
            // it must not stream to a console the user is watching at launch.
            fire_schedule(app, pool, executor_state, workflow_state, rec, true).await;
        }
    }
}

/// Parse a stored ISO 8601 timestamp into a local `DateTime`. Returns `None`
/// for `None` input or an unparseable string (treated as "unknown next run",
/// which makes the loop recompute it).
fn parse_local(s: Option<&str>) -> Option<DateTime<Local>> {
    let s = s?;
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.with_timezone(&Local))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, mo, d, h, mi, s).unwrap()
    }

    #[test]
    fn compute_next_run_enabled_returns_future_occurrence() {
        let now = at(2026, 6, 3, 10, 0, 0);
        // Daily at 02:00 — already passed today, so next is tomorrow 02:00.
        let next = compute_next_run(true, "0 2 * * *", &now).expect("a future time");
        assert_eq!(next, at(2026, 6, 4, 2, 0, 0).to_rfc3339());
    }

    #[test]
    fn compute_next_run_disabled_is_none() {
        let now = at(2026, 6, 3, 10, 0, 0);
        assert_eq!(compute_next_run(false, "0 2 * * *", &now), None);
    }

    #[test]
    fn compute_next_run_invalid_cron_is_none() {
        let now = at(2026, 6, 3, 10, 0, 0);
        assert_eq!(compute_next_run(true, "nonsense", &now), None);
    }

    #[test]
    fn catch_up_run_count_respects_policy() {
        // "none" / unknown → never replays.
        assert_eq!(catch_up_run_count("none", 5), 0);
        assert_eq!(catch_up_run_count("weird", 5), 0);
        // "once" → at most one, and only when something was missed.
        assert_eq!(catch_up_run_count("once", 5), 1);
        assert_eq!(catch_up_run_count("once", 0), 0);
        // "all" → one per missed occurrence (caller already capped).
        assert_eq!(catch_up_run_count("all", 5), 5);
        assert_eq!(catch_up_run_count("all", 0), 0);
    }
}
