//! Fire orchestration: resolving a schedule's target, running it headlessly
//! (or streaming for manual "Run now"), mapping the captured output into the
//! history layer's shapes, and persisting the outcome.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::Local;
use tauri::{AppHandle, Runtime};

use crate::core::executor::{
    self, CapturedLine, ExecuteRequest, ExecutorState, NodeOutcome, RunOptions, TerminalStatus,
};
use crate::core::workflow::{self, WorkflowExecutorState};
use crate::storage::commands::{self as storage_commands, CommandRecord};
use crate::storage::history::{
    self as storage_history, HistoryEvent, HistoryEventPayload, HistoryExtractedResult,
    HistoryLogLine,
};
use crate::storage::schedules::{self as storage_schedules, ScheduleRecord};
use crate::storage::workflows as storage_workflows;
use crate::storage::DbPool;

use super::{CommandFire, CommandFireResult, FireStatus};

/// Map an executor [`NodeOutcome`]'s captured lines into the history layer's
/// bounded [`HistoryLogLine`] shape (via [`storage_history::from_captured_lines`],
/// which applies the [`MAX_HISTORY_OUTPUT_BYTES`] cap and the trailing
/// `"…(truncated)"` marker). Returns `None` when the outcome carried no
/// captured output (capture disabled).
pub(super) fn map_captured_output(outcome: &NodeOutcome) -> Option<Vec<HistoryLogLine>> {
    let lines = outcome.output.as_ref()?;
    Some(storage_history::from_captured_lines(lines))
}

/// Map an executor [`NodeOutcome`]'s structured extraction into the history
/// layer's [`HistoryExtractedResult`] shape (via
/// [`storage_history::extracted_to_history`]). Returns `None` when the outcome
/// carried no extraction (no schema, or extraction failed).
pub(super) fn map_extracted_result(outcome: &NodeOutcome) -> Option<HistoryExtractedResult> {
    let extracted = outcome.extracted.as_ref()?;
    Some(storage_history::extracted_to_history(extracted))
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
pub(super) async fn fire_schedule<R: Runtime>(
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
    let next_run = super::cron_spec::next_after(&rec.cron, &now)
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
            let fire = fire_workflow(app, pool, executor_state, workflow_state, rec, silent).await;
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
pub(super) async fn fire_command<R: Runtime>(
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

    // Resolve any keychain-backed sensitive values (stored as sentinels in the
    // `variable_values` JSON) into their real values for this fire. Non-secret
    // values pass through unchanged. A sentinel with no stored secret is omitted
    // so the executor reports a `missingVariable` rather than running with the
    // literal sentinel. See `storage::schedules::resolve_sensitive_values`.
    let resolved_values =
        storage_schedules::resolve_sensitive_values(&rec.id, &rec.variable_values);
    let variable_values = command_variable_values(&resolved_values);
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
        // A scheduled command is a standalone run (`workflow_run_id: None`).
        // The schedule's per-run timeout overrides the command's own when set;
        // capture is per-schedule (3C); silent is per fire-path (4): planned
        // fires are silent, manual "Run now" is not.
        let req = ExecuteRequest::for_command(
            &cmd,
            RunOptions {
                execution_id,
                variable_values: variable_values.clone(),
                workflow_run_id: None,
                timeout_override,
                capture_output,
                silent,
            },
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
pub(super) async fn fire_workflow<R: Runtime>(
    app: &AppHandle<R>,
    pool: &DbPool,
    executor_state: &Arc<ExecutorState>,
    workflow_state: &Arc<WorkflowExecutorState>,
    rec: &ScheduleRecord,
    _silent: bool,
) -> CommandFire {
    let wf = match storage_workflows::list_all(pool).await {
        Ok(list) => match list.into_iter().find(|w| w.id == rec.target_id) {
            Some(wf) => wf,
            None => {
                eprintln!(
                    "scheduler: schedule {} references missing workflow {}",
                    rec.id, rec.target_id
                );
                return CommandFire {
                    status: FireStatus::Error,
                    capture: CommandFireResult::default(),
                };
            }
        },
        Err(e) => {
            eprintln!(
                "scheduler: failed to load workflows for schedule {}: {e}",
                rec.id
            );
            return CommandFire {
                status: FireStatus::Error,
                capture: CommandFireResult::default(),
            };
        }
    };

    let all_commands = match storage_commands::list_all(pool).await {
        Ok(list) => list,
        Err(e) => {
            eprintln!(
                "scheduler: failed to load commands for schedule {}: {e}",
                rec.id
            );
            return CommandFire {
                status: FireStatus::Error,
                capture: CommandFireResult::default(),
            };
        }
    };
    let commands: HashMap<String, CommandRecord> = all_commands
        .into_iter()
        .map(|c| (c.id.clone(), c))
        .collect();

    let node_variable_values = workflow_variable_values(&rec.variable_values);

    // Drive the workflow to completion in-process so we can record its
    // aggregate output. A scheduled fire is always headless (no live stream);
    // `execute_workflow_blocking` runs silent and capturing.
    let run = workflow::execute_workflow_blocking(
        app.clone(),
        executor_state.clone(),
        workflow_state.clone(),
        wf,
        commands,
        node_variable_values,
    )
    .await;

    let status = if run.succeeded {
        FireStatus::Success
    } else {
        FireStatus::Error
    };

    // Persist the captured aggregate log only when the schedule enabled
    // capture; otherwise the history row stays minimal (status only).
    let capture = if rec.capture_output {
        CommandFireResult {
            output: run.output.as_deref().map(map_workflow_capture),
            ..CommandFireResult::default()
        }
    } else {
        CommandFireResult::default()
    };

    CommandFire { status, capture }
}

/// Map a workflow run's aggregate [`CapturedLine`]s into bounded history log
/// lines — the same shared mapper a command uses
/// ([`storage_history::from_captured_lines`]).
fn map_workflow_capture(lines: &[CapturedLine]) -> Vec<HistoryLogLine> {
    storage_history::from_captured_lines(lines)
}

/// Launch a workflow target for a MANUAL "Run now": fire-and-return through
/// the streaming `execute_workflow` so the live console shows progress. No
/// output is captured for history (the manual path is interactive). Returns
/// only the launch status — a spawn failure is an error, a successful launch
/// is recorded as success (the streamed run reports its own per-node result).
async fn fire_workflow_streaming<R: Runtime>(
    app: &AppHandle<R>,
    pool: &DbPool,
    executor_state: &Arc<ExecutorState>,
    workflow_state: &Arc<WorkflowExecutorState>,
    rec: &ScheduleRecord,
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
        // Manual run streams live.
        false,
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
pub(super) async fn load_command(pool: &DbPool, id: &str) -> Result<Option<CommandRecord>, String> {
    let all = storage_commands::list_all(pool).await?;
    Ok(all.into_iter().find(|c| c.id == id))
}

/// Persist the fire outcome: record a `scheduledRun` history event (the
/// source of truth for background runs) and update the schedule's run
/// counters / cached next-run. History / counter failures are logged but
/// never propagated — a fire must not crash the loop.
pub(super) async fn record_outcome(
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
            // Manual "Run now" streams live to the console (it has a UI), so it
            // uses the fire-and-return `execute_workflow` rather than the
            // blocking+silent scheduled path — the live aggregate is built from
            // events on the frontend. No history output is captured here.
            let status =
                fire_workflow_streaming(app, pool, executor_state, workflow_state, &rec).await;
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
mod tests {
    use super::*;

    #[test]
    fn schedule_timeout_override_drops_non_positive() {
        assert_eq!(schedule_timeout_override(Some(30)), Some(30));
        assert_eq!(schedule_timeout_override(Some(0)), None);
        assert_eq!(schedule_timeout_override(Some(-5)), None);
        assert_eq!(schedule_timeout_override(None), None);
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
            scope: None,
            workflow_id: None,
            target: None,
            api_slug: None,
            api_enabled: false,
        }
    }

    /// `ExecuteRequest::for_command` must propagate the per-schedule
    /// `capture_output` and the per-fire `silent` flags onto the
    /// `ExecuteRequest`, so a planned fire both captures output and stays off
    /// the live console. A scheduled run carries no workflow run id.
    #[test]
    fn build_command_request_propagates_capture_and_silent() {
        let cmd = bare_command("cmd-1", "echo hi");
        let req = ExecuteRequest::for_command(
            &cmd,
            RunOptions {
                execution_id: "exec-1".into(),
                variable_values: std::collections::BTreeMap::new(),
                workflow_run_id: None,
                timeout_override: None,
                capture_output: true,
                silent: true,
            },
        );
        assert!(req.capture_output);
        assert!(req.silent);
        assert!(req.workflow_run_id.is_none());

        let req2 = ExecuteRequest::for_command(
            &cmd,
            RunOptions {
                execution_id: "exec-2".into(),
                variable_values: std::collections::BTreeMap::new(),
                workflow_run_id: None,
                timeout_override: None,
                capture_output: false,
                silent: false,
            },
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
            stdout_tail: None,
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
            stdout_tail: None,
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
            stdout_tail: None,
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
        assert!(retained_bytes <= storage_history::MAX_HISTORY_OUTPUT_BYTES);
    }
}
