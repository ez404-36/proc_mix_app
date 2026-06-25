// Cron-driven scheduling for commands and workflows.
//
// The Scheduler is a single in-process Tokio task that fires each enabled
// `ScheduleRecord` when its cron expression becomes due. It runs ONLY while
// the app is running (including minimized to tray); there is no OS-level
// scheduler and no `#[cfg(windows)]` branch — the engine is pure Rust and
// identical on every platform.
//
// ENGINE: the `cron` crate is used for PARSING and computing the next fire
// time only. The scheduling loop itself is hand-written: it sleeps until the
// nearest due time (or until a reload signal), fires every schedule that is
// due, records the outcome in history + the schedules table, and recomputes.
//
// TIME: all cron evaluation uses chrono `Local`. The user types a classic
// 5-field Unix cron (`min hour dom month dow`); `cron_spec` normalises it to
// the 7-field form (`sec min hour dom month dow year`) the crate expects.
//
// MISSED RUNS: skipped. On startup `next_run` is recomputed from `now`, so an
// occurrence that elapsed while the app was closed is never replayed.
//
// HEADLESS: schedules store pre-resolved variable values (captured at
// creation), because a background fire cannot prompt. A command that needs a
// no-default variable with no stored value, or an elevated run with no stored
// sudo password, records a failed run in history and never panics.
//
// MODULE LAYOUT: this module is split along its responsibility seams:
//   - `cron_spec`         — pure cron parsing / next-fire helpers (no I/O).
//   - `run_loop`          — the tick loop, startup catch-up, next-run recompute.
//   - `fire`              — fire orchestration + history mapping + record.
//   - `secret_migration`  — the one-off startup plaintext-secret migration.
// The shared tick-evaluation types (`DueInput` / `DueOutcome` / `compute_due`),
// the managed `SchedulerState`, and the fire-status bookkeeping types live here
// and are imported by the submodules.

use std::collections::HashSet;
use std::sync::Arc;

use chrono::{DateTime, Local};
use tokio::sync::{Mutex, Notify};

use crate::storage::history::{HistoryExtractedResult, HistoryLogLine};

pub mod cron_spec;
mod fire;
mod run_loop;
mod secret_migration;

pub use fire::run_now;
pub use run_loop::{
    compute_next_run, recompute_next_run, recompute_next_run_by_id, spawn_scheduler_loop,
};
pub use secret_migration::migrate_plaintext_schedule_secrets;

/// Maximum time the loop will sleep before re-evaluating, even when the next
/// schedule is far in the future. Bounds clock-drift / wake-from-sleep
/// surprises: after at most this long the loop re-reads the schedules and
/// recomputes, so a system that was suspended for hours catches the next due
/// time promptly on resume rather than oversleeping. 60s is a good balance
/// between responsiveness and idle wakeups.
const MAX_SLEEP_SECS: u64 = 60;

/// Upper bound on catch-up runs fired for a single schedule on startup under
/// the `"all"` policy. Prevents a schedule that was missed for weeks from
/// spawning hundreds of runs at launch.
const MAX_CATCH_UP_RUNS: usize = 50;

// ---------------------------------------------------------------------------
// compute_due — pure tick evaluation (no DB, no clock state).
// ---------------------------------------------------------------------------

/// A schedule reduced to the fields the tick evaluator needs. Decoupled from
/// `ScheduleRecord` so [`compute_due`] is a pure function the tests can drive
/// without a database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueInput {
    pub id: String,
    pub enabled: bool,
    pub cron: String,
    /// The schedule's previously-computed next fire time, if known. The loop
    /// seeds this on startup (recomputed from `now`) and after each fire.
    pub next_run: Option<DateTime<Local>>,
}

/// Result of evaluating the schedule set against `now`: the ids that are due
/// to fire and the earliest future fire time across all schedules (used to
/// size the next sleep).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueOutcome {
    pub due_ids: Vec<String>,
    pub next_wake: Option<DateTime<Local>>,
}

/// Decide which schedules are due at `now` and when the loop should next
/// wake. Pure: a disabled schedule is never due and never contributes a wake
/// time; a schedule whose `next_run` is `<= now` (including one whose time
/// elapsed while the system slept) is due exactly once; an invalid cron is
/// skipped (it cannot contribute a wake time and is never due — the upsert
/// command validates cron, so this only guards a hand-edited DB).
pub fn compute_due(schedules: &[DueInput], now: DateTime<Local>) -> DueOutcome {
    let mut due_ids = Vec::new();
    let mut next_wake: Option<DateTime<Local>> = None;

    for s in schedules {
        if !s.enabled {
            continue;
        }
        // Determine this schedule's effective next fire time.
        let next = match s.next_run {
            Some(t) => Some(t),
            None => cron_spec::next_after(&s.cron, &now).ok().flatten(),
        };
        let Some(next) = next else {
            continue;
        };
        if next <= now {
            due_ids.push(s.id.clone());
            // The recomputed post-fire time is handled by the loop after the
            // fire; for wake-time purposes compute the following occurrence.
            if let Ok(Some(following)) = cron_spec::next_after(&s.cron, &now) {
                next_wake = Some(match next_wake {
                    Some(w) if w <= following => w,
                    _ => following,
                });
            }
        } else {
            next_wake = Some(match next_wake {
                Some(w) if w <= next => w,
                _ => next,
            });
        }
    }

    DueOutcome { due_ids, next_wake }
}

// ---------------------------------------------------------------------------
// SchedulerState — managed Tauri state with a reload signal.
// ---------------------------------------------------------------------------

/// Managed state for the scheduler. Holds a [`Notify`] the command layer
/// pulses whenever the schedule set changes (upsert / delete / enable) so the
/// loop re-reads the table and recomputes its sleep immediately instead of
/// waiting out its current sleep.
pub struct SchedulerState {
    reload: Arc<Notify>,
    /// Ids of schedules whose previous fire is still in flight. Consulted by
    /// the loop when `skip_if_running` is set so a long-running schedule is
    /// not started twice concurrently.
    in_flight: Arc<Mutex<HashSet<String>>>,
}

impl SchedulerState {
    pub fn new() -> Self {
        Self {
            reload: Arc::new(Notify::new()),
            in_flight: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// Signal the running loop that the schedule set changed. Cheap and
    /// non-blocking; if the loop is mid-fire it picks up the change on its
    /// next iteration.
    pub fn signal_reload(&self) {
        self.reload.notify_one();
    }

    fn reload_handle(&self) -> Arc<Notify> {
        self.reload.clone()
    }

    fn in_flight_handle(&self) -> Arc<Mutex<HashSet<String>>> {
        self.in_flight.clone()
    }
}

impl Default for SchedulerState {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Fire-status bookkeeping — shared by the loop and the fire path.
// ---------------------------------------------------------------------------

/// Status string recorded for a fire in `schedules.last_run_status` and on
/// the `scheduledRun` history event. Kept a small enum so the loop and the
/// history payload agree on the exact strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FireStatus {
    Success,
    Error,
    MissingVariable,
    Skipped,
}

impl FireStatus {
    fn as_str(self) -> &'static str {
        match self {
            FireStatus::Success => "success",
            FireStatus::Error => "error",
            FireStatus::MissingVariable => "missingVariable",
            FireStatus::Skipped => "skipped",
        }
    }
}

/// Outcome of firing a COMMAND target, carrying the recorded status plus the
/// optional captured detail (exit code, duration, console output, extraction
/// result) the history record persists. The capture fields are populated ONLY
/// when the schedule has `capture_output = true` AND a run actually produced an
/// outcome; otherwise they are `None` and the `ScheduledRun` record stays
/// minimal. Workflow targets now capture too: a scheduled (silent) workflow
/// fire is driven to completion by `workflow::execute_workflow_blocking`, whose
/// aggregate per-node log is mapped into `output` here (the `exit_code` /
/// `duration_ms` / `result` fields remain command-only).
#[derive(Debug, Default)]
struct CommandFireResult {
    status_exit_code: Option<i32>,
    duration_ms: Option<u64>,
    output: Option<Vec<HistoryLogLine>>,
    result: Option<HistoryExtractedResult>,
}

/// The status + optional captured detail a command fire reports back to
/// `record_outcome` / `record_history_only`. Bundles a [`FireStatus`] with the
/// [`CommandFireResult`] so the threading stays a single value.
struct CommandFire {
    status: FireStatus,
    capture: CommandFireResult,
}

#[cfg(test)]
mod compute_due_tests {
    use super::*;
    use chrono::TimeZone;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, mo, d, h, mi, s).unwrap()
    }

    #[test]
    fn disabled_schedule_is_never_due() {
        let now = at(2026, 6, 3, 10, 0, 0);
        let inputs = vec![DueInput {
            id: "a".into(),
            enabled: false,
            cron: "* * * * *".into(),
            next_run: Some(at(2026, 6, 3, 9, 0, 0)), // in the past
        }];
        let out = compute_due(&inputs, now);
        assert!(out.due_ids.is_empty());
        assert_eq!(out.next_wake, None);
    }

    #[test]
    fn next_run_in_the_past_fires_once() {
        // Simulates wake-from-sleep: next_run elapsed while suspended.
        let now = at(2026, 6, 3, 10, 0, 0);
        let inputs = vec![DueInput {
            id: "a".into(),
            enabled: true,
            cron: "0 2 * * *".into(),
            next_run: Some(at(2026, 6, 3, 2, 0, 0)), // 8h ago
        }];
        let out = compute_due(&inputs, now);
        assert_eq!(out.due_ids, vec!["a".to_string()]);
        // The following occurrence (tomorrow 02:00) becomes the next wake.
        assert_eq!(out.next_wake, Some(at(2026, 6, 4, 2, 0, 0)));
    }

    #[test]
    fn future_next_run_is_not_due_but_sets_wake() {
        let now = at(2026, 6, 3, 10, 0, 0);
        let inputs = vec![DueInput {
            id: "a".into(),
            enabled: true,
            cron: "0 2 * * *".into(),
            next_run: Some(at(2026, 6, 4, 2, 0, 0)),
        }];
        let out = compute_due(&inputs, now);
        assert!(out.due_ids.is_empty());
        assert_eq!(out.next_wake, Some(at(2026, 6, 4, 2, 0, 0)));
    }

    #[test]
    fn missing_next_run_is_computed_from_cron() {
        let now = at(2026, 6, 3, 10, 0, 0);
        let inputs = vec![DueInput {
            id: "a".into(),
            enabled: true,
            cron: "0 2 * * *".into(),
            next_run: None,
        }];
        let out = compute_due(&inputs, now);
        // 02:00 already passed today, so the computed next is tomorrow and
        // it is NOT due yet.
        assert!(out.due_ids.is_empty());
        assert_eq!(out.next_wake, Some(at(2026, 6, 4, 2, 0, 0)));
    }

    #[test]
    fn earliest_future_wake_wins_across_schedules() {
        let now = at(2026, 6, 3, 10, 0, 0);
        let inputs = vec![
            DueInput {
                id: "later".into(),
                enabled: true,
                cron: "0 5 * * *".into(),
                next_run: Some(at(2026, 6, 4, 5, 0, 0)),
            },
            DueInput {
                id: "sooner".into(),
                enabled: true,
                cron: "0 2 * * *".into(),
                next_run: Some(at(2026, 6, 4, 2, 0, 0)),
            },
        ];
        let out = compute_due(&inputs, now);
        assert!(out.due_ids.is_empty());
        assert_eq!(out.next_wake, Some(at(2026, 6, 4, 2, 0, 0)));
    }

    #[test]
    fn invalid_cron_is_skipped() {
        let now = at(2026, 6, 3, 10, 0, 0);
        let inputs = vec![DueInput {
            id: "bad".into(),
            enabled: true,
            cron: "nonsense".into(),
            next_run: None,
        }];
        let out = compute_due(&inputs, now);
        assert!(out.due_ids.is_empty());
        assert_eq!(out.next_wake, None);
    }

    #[test]
    fn fire_status_strings_are_stable() {
        assert_eq!(FireStatus::Success.as_str(), "success");
        assert_eq!(FireStatus::Error.as_str(), "error");
        assert_eq!(FireStatus::MissingVariable.as_str(), "missingVariable");
        assert_eq!(FireStatus::Skipped.as_str(), "skipped");
    }
}
