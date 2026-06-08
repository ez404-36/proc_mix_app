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

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use chrono::{DateTime, Local};
use tauri::{AppHandle, Runtime};
use tokio::sync::{Mutex, Notify};

use crate::core::executor::{self, ExecuteRequest, ExecutorState, NodeOutcome, TerminalStatus};
use crate::core::workflow::{self, WorkflowExecutorState};
use crate::storage::commands::{self as storage_commands, CommandRecord};
use crate::storage::history::{
    self as storage_history, HistoryEvent, HistoryEventPayload, HistoryExtractedResult,
    HistoryLogLine, MAX_HISTORY_OUTPUT_BYTES,
};
use crate::storage::schedules::{self as storage_schedules, ScheduleRecord};
use crate::storage::workflows as storage_workflows;
use crate::storage::DbPool;

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
// cron_spec — pure cron parsing / next-fire helpers (no DB, no clock state).
// ---------------------------------------------------------------------------

pub mod cron_spec {
    //! Pure helpers for normalising and evaluating cron expressions. Kept
    //! free of any I/O so they can be unit-tested without a database or a
    //! real clock (callers pass `now` explicitly).

    use std::str::FromStr;

    use chrono::{DateTime, Local};
    use cron::Schedule;

    /// Normalise a user-typed cron expression into the 7-field form the
    /// `cron` crate expects (`sec min hour dom month dow year`).
    ///
    /// Accepts:
    ///   - 5 fields (classic Unix `min hour dom month dow`) → prepend `0`
    ///     seconds and append `*` year.
    ///   - 6 fields (`sec min hour dom month dow`) → append `*` year.
    ///   - 7 fields → used as-is.
    ///
    /// Returns the normalised 7-field string. Errors with a human-readable
    /// message when the field count is unsupported. This does NOT validate
    /// the field syntax — call [`next_after`] (or `Schedule::from_str` on the
    /// result) for that.
    pub fn normalize_five_to_seven(expr: &str) -> Result<String, String> {
        let mut fields: Vec<String> = expr.split_whitespace().map(str::to_owned).collect();
        // The day-of-week field index differs by field count:
        //   5 fields: min hour dom month [dow]            -> index 4
        //   6 fields: sec min hour dom month [dow]        -> index 5
        //   7 fields: sec min hour dom month [dow] year   -> index 5
        let dow_index = match fields.len() {
            5 => 4,
            6 | 7 => 5,
            n => {
                return Err(format!(
                    "cron expression must have 5, 6, or 7 fields (got {n})"
                ));
            }
        };
        // The `cron` crate (Quartz-style) numbers weekdays 1-7 = Sun-Sat,
        // whereas the user types classic Unix numbering 0-6 = Sun-Sat (with 7
        // also meaning Sunday). Shift the numeric tokens of the dow field at
        // this boundary so a UI-built `... 6` (Saturday) means Saturday, not
        // Friday. Without this every weekday schedule fires one day early.
        if let Some(dow) = fields.get(dow_index) {
            fields[dow_index] = shift_weekday_field(dow);
        }
        match fields.len() {
            5 => Ok(format!("0 {} *", fields.join(" "))),
            6 => Ok(format!("{} *", fields.join(" "))),
            7 => Ok(fields.join(" ")),
            // Unreachable: field count already validated above.
            _ => unreachable!("field count validated above"),
        }
    }

    /// Map every numeric token in a day-of-week field from Unix numbering
    /// (0-6 = Sun-Sat, 7 = Sun) to the `cron` crate's Quartz numbering
    /// (1-7 = Sun-Sat). Non-numeric tokens (`*`, `?`, `SUN`..`SAT`, and the
    /// `/`, `-`, `,` separators) pass through unchanged. Numeric step
    /// divisors (the part after `/`) are NOT day values and are left as-is.
    fn shift_weekday_field(field: &str) -> String {
        // Split on commas (lists), preserving each element; within an element
        // handle ranges (`a-b`) and steps (`base/step`). Only the day-value
        // positions (single value, range endpoints, step base) are shifted.
        field
            .split(',')
            .map(shift_weekday_element)
            .collect::<Vec<_>>()
            .join(",")
    }

    fn shift_weekday_element(element: &str) -> String {
        // Step syntax: `<base>/<divisor>`. Only the base is a day value.
        if let Some((base, step)) = element.split_once('/') {
            return format!("{}/{}", shift_weekday_range(base), step);
        }
        shift_weekday_range(element)
    }

    fn shift_weekday_range(range: &str) -> String {
        // Range syntax: `<from>-<to>`. Shift both endpoints when numeric.
        if let Some((from, to)) = range.split_once('-') {
            return format!("{}-{}", shift_weekday_value(from), shift_weekday_value(to));
        }
        shift_weekday_value(range)
    }

    fn shift_weekday_value(value: &str) -> String {
        match value.parse::<u8>() {
            // 7 is Sunday in Unix; Quartz Sunday is 1.
            Ok(7) => "1".to_owned(),
            // 0-6 (Sun-Sat) -> 1-7 (Sun-Sat).
            Ok(n) if n <= 6 => (n + 1).to_string(),
            // Out-of-range numbers or non-numeric tokens (`*`, `?`, names)
            // pass through; the crate validates them downstream.
            _ => value.to_owned(),
        }
    }

    /// Parse `expr` (any supported field count) and return the next fire time
    /// strictly after `after`, in local time. Returns `Ok(None)` when the
    /// schedule has no future occurrence (e.g. a one-off year in the past).
    /// Returns `Err` when the expression is syntactically invalid.
    pub fn next_after(
        expr: &str,
        after: &DateTime<Local>,
    ) -> Result<Option<DateTime<Local>>, String> {
        let normalized = normalize_five_to_seven(expr)?;
        let schedule =
            Schedule::from_str(&normalized).map_err(|e| format!("invalid cron expression: {e}"))?;
        Ok(schedule.after(after).next())
    }

    /// Validate that `expr` parses as a cron expression. Returns the
    /// normalised 7-field form on success so callers can store / re-use it.
    pub fn validate(expr: &str) -> Result<String, String> {
        let normalized = normalize_five_to_seven(expr)?;
        Schedule::from_str(&normalized).map_err(|e| format!("invalid cron expression: {e}"))?;
        Ok(normalized)
    }

    /// Count occurrences of `expr` strictly after `after` and at or before
    /// `now` — i.e. fire times that were MISSED while the app was closed.
    /// Capped at `cap` to avoid a thundering herd when a schedule was missed
    /// for a very long time. Returns 0 for an invalid expression (the loop
    /// will surface the error elsewhere) or when `after >= now`.
    pub fn missed_occurrences(
        expr: &str,
        after: &DateTime<Local>,
        now: &DateTime<Local>,
        cap: usize,
    ) -> usize {
        if after >= now {
            return 0;
        }
        let normalized = match normalize_five_to_seven(expr) {
            Ok(n) => n,
            Err(_) => return 0,
        };
        let schedule = match Schedule::from_str(&normalized) {
            Ok(s) => s,
            Err(_) => return 0,
        };
        let mut count = 0usize;
        for occ in schedule.after(after) {
            if &occ > now {
                break;
            }
            count += 1;
            if count >= cap {
                break;
            }
        }
        count
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use chrono::TimeZone;

        #[test]
        fn five_field_gets_seconds_and_year() {
            assert_eq!(
                normalize_five_to_seven("0 2 * * *").unwrap(),
                "0 0 2 * * * *"
            );
        }

        #[test]
        fn six_field_gets_year_only() {
            assert_eq!(
                normalize_five_to_seven("30 0 2 * * *").unwrap(),
                "30 0 2 * * * *"
            );
        }

        #[test]
        fn seven_field_passes_through() {
            assert_eq!(
                normalize_five_to_seven("0 0 2 * * * *").unwrap(),
                "0 0 2 * * * *"
            );
        }

        #[test]
        fn extra_whitespace_is_collapsed() {
            assert_eq!(
                normalize_five_to_seven("  0   2 *  * *  ").unwrap(),
                "0 0 2 * * * *"
            );
        }

        #[test]
        fn wrong_field_count_errors() {
            assert!(normalize_five_to_seven("* * *").is_err());
            assert!(normalize_five_to_seven("* * * * * * * *").is_err());
            assert!(normalize_five_to_seven("").is_err());
        }

        #[test]
        fn invalid_syntax_errors_in_next_after() {
            let now = Local.with_ymd_and_hms(2026, 6, 3, 10, 0, 0).unwrap();
            // 99 is out of range for the minute field.
            assert!(next_after("99 * * * *", &now).is_err());
        }

        #[test]
        fn five_and_seven_field_are_equivalent() {
            let now = Local.with_ymd_and_hms(2026, 6, 3, 10, 0, 0).unwrap();
            let from_five = next_after("0 2 * * *", &now).unwrap();
            let from_seven = next_after("0 0 2 * * * *", &now).unwrap();
            assert_eq!(from_five, from_seven);
        }

        #[test]
        fn daily_at_two_am_next_is_tomorrow() {
            // 10:00 on the 3rd → next "0 2 * * *" is 02:00 on the 4th.
            let now = Local.with_ymd_and_hms(2026, 6, 3, 10, 0, 0).unwrap();
            let next = next_after("0 2 * * *", &now).unwrap().unwrap();
            assert_eq!(next, Local.with_ymd_and_hms(2026, 6, 4, 2, 0, 0).unwrap());
        }

        #[test]
        fn unix_weekday_is_shifted_to_quartz() {
            // Unix dow 6 = Saturday. The `cron` crate uses 1-7 = Sun-Sat, so
            // the field is shifted 6 -> 7. `* * * * 6` (Saturday) must keep
            // `dom`/`month`/year wildcards and become `... 7`.
            assert_eq!(
                normalize_five_to_seven("0 9 * * 6").unwrap(),
                "0 0 9 * * 7 *"
            );
            // Unix 0 = Sunday -> Quartz 1.
            assert_eq!(
                normalize_five_to_seven("0 9 * * 0").unwrap(),
                "0 0 9 * * 1 *"
            );
            // Unix 7 also = Sunday -> Quartz 1.
            assert_eq!(
                normalize_five_to_seven("0 9 * * 7").unwrap(),
                "0 0 9 * * 1 *"
            );
            // Weekday list 1,3,5 (Mon,Wed,Fri) -> 2,4,6.
            assert_eq!(
                normalize_five_to_seven("0 9 * * 1,3,5").unwrap(),
                "0 0 9 * * 2,4,6 *"
            );
            // Range 1-5 (Mon-Fri) -> 2-6.
            assert_eq!(
                normalize_five_to_seven("0 9 * * 1-5").unwrap(),
                "0 0 9 * * 2-6 *"
            );
            // Wildcard dow is untouched.
            assert_eq!(
                normalize_five_to_seven("0 2 * * *").unwrap(),
                "0 0 2 * * * *"
            );
        }

        #[test]
        fn missed_occurrences_counts_window_and_caps() {
            // Hourly schedule. Anchor 10:00, now 15:30 on the same day → the
            // 11,12,13,14,15:00 fires were missed = 5.
            let anchor = Local.with_ymd_and_hms(2026, 6, 3, 10, 0, 0).unwrap();
            let now = Local.with_ymd_and_hms(2026, 6, 3, 15, 30, 0).unwrap();
            assert_eq!(missed_occurrences("0 * * * *", &anchor, &now, 50), 5);
            // Cap is honoured.
            assert_eq!(missed_occurrences("0 * * * *", &anchor, &now, 3), 3);
            // anchor >= now → nothing missed.
            assert_eq!(missed_occurrences("0 * * * *", &now, &anchor, 50), 0);
        }

        #[test]
        fn saturday_nine_am_resolves_to_saturday() {
            // 2026-06-03 is a Wednesday; the next Saturday is the 6th. With the
            // weekday shift, `0 9 * * 6` (Unix Saturday) must fire on the 6th,
            // NOT the 5th (Friday) as the unshifted crate numbering would.
            let now = Local.with_ymd_and_hms(2026, 6, 3, 10, 0, 0).unwrap();
            let next = next_after("0 9 * * 6", &now).unwrap().unwrap();
            assert_eq!(next, Local.with_ymd_and_hms(2026, 6, 6, 9, 0, 0).unwrap());
        }

        #[test]
        fn every_minute_preset_parses() {
            let now = Local.with_ymd_and_hms(2026, 6, 3, 10, 0, 30).unwrap();
            let next = next_after("* * * * *", &now).unwrap().unwrap();
            assert_eq!(next, Local.with_ymd_and_hms(2026, 6, 3, 10, 1, 0).unwrap());
        }

        #[test]
        fn validate_returns_normalized() {
            assert_eq!(validate("*/5 * * * *").unwrap(), "0 */5 * * * * *");
            assert!(validate("nonsense").is_err());
        }
    }
}

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
// The loop + fire logic.
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
/// minimal. Workflow targets do NOT capture in v1 — `fire_workflow` returns a
/// bare `FireStatus` and the workflow's `ScheduledRun` keeps all capture fields
/// `None` (documented limitation).
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

/// Map an executor [`NodeOutcome`]'s captured lines into the history layer's
/// [`HistoryLogLine`] shape, applying the [`MAX_HISTORY_OUTPUT_BYTES`] cap.
/// When the joined line bytes exceed the cap, the lines are truncated and a
/// final `meta`-stream `"…(truncated)"` marker is appended. Returns `None` when
/// the outcome carried no captured output (capture disabled).
fn map_captured_output(outcome: &NodeOutcome) -> Option<Vec<HistoryLogLine>> {
    let lines = outcome.output.as_ref()?;
    let mut out: Vec<HistoryLogLine> = Vec::with_capacity(lines.len());
    let mut bytes = 0usize;
    let mut truncated = false;
    for line in lines {
        if bytes.saturating_add(line.line.len()) > MAX_HISTORY_OUTPUT_BYTES {
            truncated = true;
            break;
        }
        bytes += line.line.len();
        out.push(HistoryLogLine {
            stream: line.stream.as_str().to_string(),
            line: line.line.clone(),
        });
    }
    if truncated {
        out.push(HistoryLogLine {
            stream: "meta".to_string(),
            line: "…(truncated)".to_string(),
        });
    }
    Some(out)
}

/// Map an executor [`NodeOutcome`]'s structured extraction into the history
/// layer's [`HistoryExtractedResult`] shape. Returns `None` when the outcome
/// carried no extraction (no schema, or extraction failed). The
/// `BTreeMap<String, Value>` fields convert into a `serde_json::Map`.
fn map_extracted_result(outcome: &NodeOutcome) -> Option<HistoryExtractedResult> {
    let extracted = outcome.extracted.as_ref()?;
    let fields = extracted
        .fields
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    Some(HistoryExtractedResult {
        fields,
        return_value: extracted.return_value.clone(),
        error: None,
    })
}

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

/// Fire a single schedule: resolve its target, run it headlessly, then record
/// the outcome in history and the schedules table. Never panics; every
/// failure mode maps to a recorded status.
///
/// `silent` controls whether the run streams to the live console. The PLANNED
/// (cron / catch-up) path passes `silent = true` so a background fire does NOT
/// stream `execution-event` / `workflow-event` — the history record (with
/// captured output, when enabled) is the source of truth. Manual "Run now"
/// (`run_now`) fires with `silent = false` so it still streams.
async fn fire_schedule<R: Runtime>(
    app: &AppHandle<R>,
    pool: &DbPool,
    executor_state: &Arc<ExecutorState>,
    workflow_state: &Arc<WorkflowExecutorState>,
    rec: &ScheduleRecord,
    silent: bool,
) {
    let now = Local::now();
    let now_iso = now.to_rfc3339();

    // Recompute the next fire time so the cached display value advances even
    // when the run itself fails.
    let next_run = cron_spec::next_after(&rec.cron, &now)
        .ok()
        .flatten()
        .map(|dt| dt.to_rfc3339());

    match rec.target_kind.as_str() {
        "command" => {
            let fire = fire_command(app, pool, executor_state, rec, silent).await;
            record_outcome(
                pool,
                rec,
                &now_iso,
                fire.status,
                next_run.as_deref(),
                &fire.capture,
            )
            .await;
        }
        "workflow" => {
            // v1: workflow targets do not capture output — record the minimal
            // event.
            let status =
                fire_workflow(app, pool, executor_state, workflow_state, rec, silent).await;
            record_outcome(
                pool,
                rec,
                &now_iso,
                status,
                next_run.as_deref(),
                &CommandFireResult::default(),
            )
            .await;
        }
        other => {
            eprintln!(
                "scheduler: schedule {} has unknown target_kind {other}",
                rec.id
            );
            record_outcome(
                pool,
                rec,
                &now_iso,
                FireStatus::Error,
                next_run.as_deref(),
                &CommandFireResult::default(),
            )
            .await;
        }
    }
}

/// Resolve and run a command target. Returns the status to record plus the
/// optional captured detail (when the schedule enabled `capture_output`).
///
/// `silent` is forwarded to the executor: a planned fire suppresses the live
/// console stream while still running, capturing, and reporting its outcome.
async fn fire_command<R: Runtime>(
    app: &AppHandle<R>,
    pool: &DbPool,
    executor_state: &Arc<ExecutorState>,
    rec: &ScheduleRecord,
    silent: bool,
) -> CommandFire {
    let cmd = match load_command(pool, &rec.target_id).await {
        Ok(Some(cmd)) => cmd,
        Ok(None) => {
            eprintln!(
                "scheduler: schedule {} references missing command {}",
                rec.id, rec.target_id
            );
            return CommandFire {
                status: FireStatus::Error,
                capture: CommandFireResult::default(),
            };
        }
        Err(e) => {
            eprintln!(
                "scheduler: failed to load command for schedule {}: {e}",
                rec.id
            );
            return CommandFire {
                status: FireStatus::Error,
                capture: CommandFireResult::default(),
            };
        }
    };

    let variable_values = command_variable_values(&rec.variable_values);
    let timeout_override = schedule_timeout_override(rec.timeout_seconds);
    let capture_output = rec.capture_output;

    // Total attempts = 1 initial + max_retries. A run succeeds as soon as one
    // attempt exits cleanly; a deterministic missing-variable failure is NOT
    // retried (it would fail identically every time).
    let attempts = 1 + rec.max_retries.max(0) as usize;
    let mut last = FireStatus::Error;
    // Capture detail of the MOST RECENT attempt that produced an outcome, so a
    // succeeding (or final-failing) run's output is what gets persisted.
    let mut capture = CommandFireResult::default();
    for attempt in 0..attempts {
        let execution_id = uuid::Uuid::new_v4().to_string();
        let req = build_command_request(
            &cmd,
            execution_id,
            variable_values.clone(),
            timeout_override,
            capture_output,
            silent,
        );

        let (tx, rx) = tokio::sync::oneshot::channel::<NodeOutcome>();
        if let Err(e) = executor::spawn_execution_with_completion(
            app.clone(),
            executor_state.clone(),
            req,
            Some(tx),
        )
        .await
        {
            // A missing-variable / missing-admin-password failure surfaces
            // here as the executor's typed error before any child is spawned.
            // Missing-variable is deterministic — return immediately, no retry.
            if e.contains("missingVariable") {
                return CommandFire {
                    status: FireStatus::MissingVariable,
                    capture: CommandFireResult::default(),
                };
            }
            eprintln!(
                "scheduler: command spawn failed for schedule {} (attempt {}): {e}",
                rec.id,
                attempt + 1
            );
            last = FireStatus::Error;
            continue;
        }

        // Await the terminal outcome so the recorded status reflects the real
        // result (success only on a clean zero exit).
        match rx.await {
            Ok(outcome) => {
                last = classify_outcome(&outcome);
                // Always carry duration + exit code; the captured output /
                // extraction are only present when capture was enabled.
                capture = CommandFireResult {
                    status_exit_code: outcome.exit_code,
                    duration_ms: Some(outcome.duration_ms),
                    output: if capture_output {
                        map_captured_output(&outcome)
                    } else {
                        None
                    },
                    result: if capture_output {
                        map_extracted_result(&outcome)
                    } else {
                        None
                    },
                };
            }
            Err(_) => {
                last = FireStatus::Error;
                capture = CommandFireResult::default();
            }
        };
        if last == FireStatus::Success {
            break;
        }
    }
    CommandFire {
        status: last,
        capture,
    }
}

/// Resolve and launch a workflow target. Unlike a command, the workflow
/// runner streams its own progress on `workflow-event` and runs in its own
/// task; we record `success` once it launches and `error` if resolution /
/// launch fails. The per-node failures surface through the workflow's own
/// event stream and aggregated process.
async fn fire_workflow<R: Runtime>(
    app: &AppHandle<R>,
    pool: &DbPool,
    executor_state: &Arc<ExecutorState>,
    workflow_state: &Arc<WorkflowExecutorState>,
    rec: &ScheduleRecord,
    silent: bool,
) -> FireStatus {
    let wf = match storage_workflows::list_all(pool).await {
        Ok(list) => match list.into_iter().find(|w| w.id == rec.target_id) {
            Some(wf) => wf,
            None => {
                eprintln!(
                    "scheduler: schedule {} references missing workflow {}",
                    rec.id, rec.target_id
                );
                return FireStatus::Error;
            }
        },
        Err(e) => {
            eprintln!(
                "scheduler: failed to load workflows for schedule {}: {e}",
                rec.id
            );
            return FireStatus::Error;
        }
    };

    let all_commands = match storage_commands::list_all(pool).await {
        Ok(list) => list,
        Err(e) => {
            eprintln!(
                "scheduler: failed to load commands for schedule {}: {e}",
                rec.id
            );
            return FireStatus::Error;
        }
    };
    let commands: HashMap<String, CommandRecord> = all_commands
        .into_iter()
        .map(|c| (c.id.clone(), c))
        .collect();

    let node_variable_values = workflow_variable_values(&rec.variable_values);

    match workflow::execute_workflow(
        app.clone(),
        executor_state.clone(),
        workflow_state.clone(),
        wf,
        commands,
        node_variable_values,
        silent,
    )
    .await
    {
        Ok(_run_id) => FireStatus::Success,
        Err(e) => {
            eprintln!(
                "scheduler: workflow launch failed for schedule {}: {e}",
                rec.id
            );
            FireStatus::Error
        }
    }
}

/// Map a command's terminal outcome to a recorded fire status. A clean exit 0
/// is success; any non-zero exit, signal kill, or error is recorded as error
/// (the history row carries the detail).
fn classify_outcome(outcome: &NodeOutcome) -> FireStatus {
    match outcome.status {
        TerminalStatus::Finished if outcome.exit_code == Some(0) => FireStatus::Success,
        _ => FireStatus::Error,
    }
}

/// Build an `ExecuteRequest` for a scheduled command run. Mirrors
/// `workflow::build_request` (shell, args, working dir, env, variables,
/// elevated flag) so a scheduled run behaves identically to a direct library
/// run. `workflow_run_id` is `None` — a scheduled command is a standalone run.
fn build_command_request(
    cmd: &CommandRecord,
    execution_id: String,
    variable_values: std::collections::BTreeMap<String, String>,
    timeout_override: Option<u64>,
    capture_output: bool,
    silent: bool,
) -> ExecuteRequest {
    let env = cmd
        .env
        .as_ref()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect());
    ExecuteRequest {
        script: cmd.script.clone(),
        shell: cmd.shell.clone(),
        args: cmd.args.clone(),
        working_dir: cmd.working_dir.as_ref().map(Into::into),
        env,
        command_id: Some(cmd.id.clone()),
        execution_id: Some(execution_id),
        // Resolve elevation exactly like the UI/library path
        // (`executor.ts`): the persisted flag OR a script whose LEADING
        // command is an inline-escalation tool (`sudo`/`doas`/`pkexec`).
        // Without the inline-escalation detection, a `sudo …` script with
        // `run_as_admin = false` ran on the NON-elevated path (plain shell,
        // `Stdio::null()` stdin, no TTY) and the inline `sudo` died with
        // "a terminal is required to read the password" — the exact failure
        // seen for scheduled runs. `admin_password: None` lets the executor
        // fall back to the OS keychain (the scheduler has no UI to prompt;
        // if the keychain is empty the executor surfaces the typed
        // ADMIN_PASSWORD_REQUIRED error, recorded as a failed run).
        elevated: cmd.run_as_admin
            || crate::core::utility_help::detect_admin_escalation(&cmd.script),
        admin_password: None,
        variables: cmd.variables.clone(),
        variable_values,
        workflow_run_id: None,
        // The schedule's per-run timeout overrides the command's own when set;
        // otherwise the command's timeout (or none) applies.
        timeout_seconds: timeout_override.or(cmd.timeout_seconds),
        output_schema: cmd.output_schema.clone(),
        // Capture is per-schedule (3C); silent is per fire-path (4): planned
        // fires are silent, manual "Run now" is not.
        capture_output,
        silent,
    }
}

/// Convert a stored schedule `timeout_seconds` (`Option<i64>`) into the
/// executor's `Option<u64>`, dropping non-positive / negative values (which
/// mean "no override").
fn schedule_timeout_override(timeout_seconds: Option<i64>) -> Option<u64> {
    match timeout_seconds {
        Some(s) if s > 0 => Some(s as u64),
        _ => None,
    }
}

/// Decode the flat command-shape `variable_values` JSON object into a
/// `BTreeMap<String, String>`. Non-object JSON or non-string values are
/// ignored (the executor falls back to each spec's default for any name not
/// present, and reports a typed `missingVariable` for a no-default name).
fn command_variable_values(
    value: &serde_json::Value,
) -> std::collections::BTreeMap<String, String> {
    let mut out = std::collections::BTreeMap::new();
    if let Some(obj) = value.as_object() {
        for (k, v) in obj {
            if let Some(s) = v.as_str() {
                out.insert(k.clone(), s.to_string());
            }
        }
    }
    out
}

/// Decode the nested workflow-shape `variable_values` JSON object
/// (`nodeId -> { name -> value }`) into the map the workflow runner expects.
fn workflow_variable_values(
    value: &serde_json::Value,
) -> HashMap<String, std::collections::BTreeMap<String, String>> {
    let mut out = HashMap::new();
    if let Some(obj) = value.as_object() {
        for (node_id, inner) in obj {
            let mut node_map = std::collections::BTreeMap::new();
            if let Some(inner_obj) = inner.as_object() {
                for (name, v) in inner_obj {
                    if let Some(s) = v.as_str() {
                        node_map.insert(name.clone(), s.to_string());
                    }
                }
            }
            out.insert(node_id.clone(), node_map);
        }
    }
    out
}

/// Load a single command by id (the storage layer exposes only `list_all`, so
/// we filter — schedules are few and fires are infrequent, so the cost is
/// negligible and we avoid widening the storage API surface).
async fn load_command(pool: &DbPool, id: &str) -> Result<Option<CommandRecord>, String> {
    let all = storage_commands::list_all(pool).await?;
    Ok(all.into_iter().find(|c| c.id == id))
}

/// Persist the fire outcome: record a `scheduledRun` history event (the
/// source of truth for background runs) and update the schedule's run
/// counters / cached next-run. History / counter failures are logged but
/// never propagated — a fire must not crash the loop.
async fn record_outcome(
    pool: &DbPool,
    rec: &ScheduleRecord,
    now_iso: &str,
    status: FireStatus,
    next_run: Option<&str>,
    capture: &CommandFireResult,
) {
    let event = HistoryEvent {
        id: uuid::Uuid::new_v4().to_string(),
        created_at: now_iso.to_string(),
        payload: HistoryEventPayload::ScheduledRun {
            schedule_id: rec.id.clone(),
            schedule_name: rec.name.clone(),
            target_kind: rec.target_kind.clone(),
            target_id: rec.target_id.clone(),
            status: status.as_str().to_string(),
            // Captured detail: `None` for fires whose schedule had capture
            // disabled (and always for workflow targets in v1).
            exit_code: capture.status_exit_code,
            duration_ms: capture.duration_ms,
            output: capture.output.clone(),
            result: capture.result.clone(),
        },
    };
    if let Err(e) = storage_history::insert_event(pool, &event).await {
        eprintln!(
            "scheduler: failed to record history for schedule {}: {e}",
            rec.id
        );
    }

    if let Err(e) =
        storage_schedules::record_run(pool, &rec.id, now_iso, status.as_str(), next_run).await
    {
        eprintln!(
            "scheduler: failed to record run for schedule {}: {e}",
            rec.id
        );
    }
}

/// Record ONLY a `scheduledRun` history event for a fire, without touching the
/// schedule's run counters or cached next-run. Used by the manual "run now"
/// path so an out-of-band run is visible in History but does not shift the
/// schedule's stats or timing.
async fn record_history_only(
    pool: &DbPool,
    rec: &ScheduleRecord,
    status: FireStatus,
    capture: &CommandFireResult,
) {
    let event = HistoryEvent {
        id: uuid::Uuid::new_v4().to_string(),
        created_at: Local::now().to_rfc3339(),
        payload: HistoryEventPayload::ScheduledRun {
            schedule_id: rec.id.clone(),
            schedule_name: rec.name.clone(),
            target_kind: rec.target_kind.clone(),
            target_id: rec.target_id.clone(),
            status: status.as_str().to_string(),
            // Captured detail: `None` for fires whose schedule had capture
            // disabled (and always for workflow targets in v1).
            exit_code: capture.status_exit_code,
            duration_ms: capture.duration_ms,
            output: capture.output.clone(),
            result: capture.result.clone(),
        },
    };
    if let Err(e) = storage_history::insert_event(pool, &event).await {
        eprintln!(
            "scheduler: failed to record manual-run history for schedule {}: {e}",
            rec.id
        );
    }
}

/// Manually fire a schedule's target NOW, out of band. Resolves the schedule
/// by id, runs its target through the same headless fire path (honouring the
/// schedule's timeout / retries / stored variable values), and records a
/// `scheduledRun` history event — but does NOT update the schedule's
/// `last_run_at` / `run_count` / `next_run_at`, so the cron timing is
/// untouched. Returns `Err` if the schedule does not exist.
pub async fn run_now<R: Runtime>(
    app: &AppHandle<R>,
    pool: &DbPool,
    executor_state: &Arc<ExecutorState>,
    workflow_state: &Arc<WorkflowExecutorState>,
    schedule_id: &str,
) -> Result<(), String> {
    let schedules = storage_schedules::list_all(pool).await?;
    let Some(rec) = schedules.into_iter().find(|s| s.id == schedule_id) else {
        return Err(format!("schedule {schedule_id} not found"));
    };

    // Manual "Run now" MUST stream to the live console, so `silent = false`.
    let (status, capture) = match rec.target_kind.as_str() {
        "command" => {
            let fire = fire_command(app, pool, executor_state, &rec, false).await;
            (fire.status, fire.capture)
        }
        "workflow" => {
            // v1: workflow targets do not capture output.
            let status =
                fire_workflow(app, pool, executor_state, workflow_state, &rec, false).await;
            (status, CommandFireResult::default())
        }
        other => {
            eprintln!(
                "scheduler: manual run of schedule {} has unknown target_kind {other}",
                rec.id
            );
            (FireStatus::Error, CommandFireResult::default())
        }
    };

    record_history_only(pool, &rec, status, &capture).await;
    Ok(())
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
    fn schedule_timeout_override_drops_non_positive() {
        assert_eq!(schedule_timeout_override(Some(30)), Some(30));
        assert_eq!(schedule_timeout_override(Some(0)), None);
        assert_eq!(schedule_timeout_override(Some(-5)), None);
        assert_eq!(schedule_timeout_override(None), None);
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

    #[test]
    fn command_variable_values_decodes_flat_object() {
        let v = serde_json::json!({ "a": "1", "b": "two", "ignored": 3 });
        let map = command_variable_values(&v);
        assert_eq!(map.get("a").map(String::as_str), Some("1"));
        assert_eq!(map.get("b").map(String::as_str), Some("two"));
        // Non-string values are skipped.
        assert!(!map.contains_key("ignored"));
    }

    #[test]
    fn workflow_variable_values_decodes_nested_object() {
        let v = serde_json::json!({
            "node-a": { "x": "1" },
            "node-b": { "y": "2" }
        });
        let map = workflow_variable_values(&v);
        assert_eq!(
            map.get("node-a")
                .and_then(|m| m.get("x"))
                .map(String::as_str),
            Some("1")
        );
        assert_eq!(
            map.get("node-b")
                .and_then(|m| m.get("y"))
                .map(String::as_str),
            Some("2")
        );
    }

    #[test]
    fn fire_status_strings_are_stable() {
        assert_eq!(FireStatus::Success.as_str(), "success");
        assert_eq!(FireStatus::Error.as_str(), "error");
        assert_eq!(FireStatus::MissingVariable.as_str(), "missingVariable");
        assert_eq!(FireStatus::Skipped.as_str(), "skipped");
    }

    fn bare_command(id: &str, script: &str) -> CommandRecord {
        CommandRecord {
            id: id.into(),
            name: id.into(),
            name_key: None,
            description: None,
            description_key: None,
            icon: None,
            script: script.into(),
            shell: None,
            args: None,
            working_dir: None,
            env: None,
            tags: vec![],
            category_id: None,
            favorite: false,
            created_at: "2026-06-05T00:00:00Z".into(),
            updated_at: "2026-06-05T00:00:00Z".into(),
            last_run_at: None,
            run_count: 0,
            run_as_admin: false,
            variables: vec![],
            timeout_seconds: None,
            output_schema: None,
        }
    }

    /// `build_command_request` must propagate the per-schedule `capture_output`
    /// and the per-fire `silent` flags onto the `ExecuteRequest`, so a planned
    /// fire both captures output and stays off the live console.
    #[test]
    fn build_command_request_propagates_capture_and_silent() {
        let cmd = bare_command("cmd-1", "echo hi");
        let req = build_command_request(
            &cmd,
            "exec-1".into(),
            std::collections::BTreeMap::new(),
            None,
            true, // capture_output
            true, // silent
        );
        assert!(req.capture_output);
        assert!(req.silent);

        let req2 = build_command_request(
            &cmd,
            "exec-2".into(),
            std::collections::BTreeMap::new(),
            None,
            false,
            false,
        );
        assert!(!req2.capture_output);
        assert!(!req2.silent);
    }

    /// Map an outcome's captured lines into history `HistoryLogLine`s with the
    /// right stream tags, and `None` when capture was disabled.
    #[test]
    fn map_captured_output_tags_streams_and_handles_none() {
        let none_outcome = NodeOutcome {
            status: TerminalStatus::Finished,
            exit_code: Some(0),
            extracted: None,
            duration_ms: 5,
            output: None,
        };
        assert!(map_captured_output(&none_outcome).is_none());

        let outcome = NodeOutcome {
            status: TerminalStatus::Finished,
            exit_code: Some(0),
            extracted: None,
            duration_ms: 5,
            output: Some(vec![
                crate::core::executor::CapturedLine {
                    stream: crate::core::executor::CapturedStream::Stdout,
                    line: "out".into(),
                },
                crate::core::executor::CapturedLine {
                    stream: crate::core::executor::CapturedStream::Stderr,
                    line: "err".into(),
                },
            ]),
        };
        let mapped = map_captured_output(&outcome).expect("output present");
        assert_eq!(mapped.len(), 2);
        assert_eq!(mapped[0].stream, "stdout");
        assert_eq!(mapped[0].line, "out");
        assert_eq!(mapped[1].stream, "stderr");
        assert_eq!(mapped[1].line, "err");
    }

    /// A capture exceeding `MAX_HISTORY_OUTPUT_BYTES` is truncated and a
    /// trailing `meta` marker line is appended.
    #[test]
    fn map_captured_output_truncates_at_byte_cap() {
        // Each line is ~1KB; enough of them to exceed the 64KB cap.
        let big_line = "x".repeat(1024);
        let lines: Vec<_> = (0..100)
            .map(|_| crate::core::executor::CapturedLine {
                stream: crate::core::executor::CapturedStream::Stdout,
                line: big_line.clone(),
            })
            .collect();
        let outcome = NodeOutcome {
            status: TerminalStatus::Finished,
            exit_code: Some(0),
            extracted: None,
            duration_ms: 5,
            output: Some(lines),
        };
        let mapped = map_captured_output(&outcome).expect("output present");
        // Last line is the truncation marker.
        let last = mapped.last().expect("at least one line");
        assert_eq!(last.stream, "meta");
        assert_eq!(last.line, "…(truncated)");
        // The retained payload (excluding the marker) is within the cap.
        let retained_bytes: usize = mapped[..mapped.len() - 1]
            .iter()
            .map(|l| l.line.len())
            .sum();
        assert!(retained_bytes <= MAX_HISTORY_OUTPUT_BYTES);
    }
}
