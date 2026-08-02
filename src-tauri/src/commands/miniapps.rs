//! Mini-App CRUD commands + headless status probe.
//!
//! Thin wrappers over `storage::miniapps`, mirroring the command-library
//! trio (list / get / save / delete). A mini-app is persisted exactly as
//! typed by the editor.
//!
//! `run_miniapp_status_probe` runs a [`StatusSourceRecord`] (a `commandRef`
//! to an existing library command, or an `inline` script) HEADLESSLY and
//! returns the extracted status fields. It mirrors the headless execution
//! path shared by the scheduler (`core::scheduler::fire`) and the HTTP-API
//! handler (`core::http_server::handlers`):
//! [`ExecuteRequest::for_command`] + [`RunOptions`] (`silent: true`,
//! `capture_output: true`) + [`executor::spawn_execution_with_completion`]
//! over a `oneshot` channel.
//!
//! History avoidance: the executor NEVER writes to `history_events` itself —
//! a History row is the CALLER's responsibility (the frontend `commandRunner`
//! pre-inserts one; the HTTP-API handler calls `record_command_run_started`).
//! The probe simply never invokes a History function, so no row is created.
//! `silent: true` additionally suppresses the `execution-event` stream so no
//! UI OutputPanel opens for the probe.
//!
//! Every handler returns `Result<T, String>` and accesses the DB through
//! `State<'_, DbPool>` (`pool.inner()`).

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tokio::sync::oneshot;

use crate::core::executor::{
    self, CapturedStream, ExecuteRequest, ExecutorState, NodeOutcome, RunOptions, TerminalStatus,
};
use crate::storage::commands as storage_commands;
use crate::storage::commands::CommandRecord;
use crate::storage::miniapps as storage_miniapps;
use crate::storage::miniapps::StatusSourceRecord;
use crate::storage::DbPool;

#[tauri::command]
pub async fn list_miniapps(
    pool: State<'_, DbPool>,
) -> Result<Vec<storage_miniapps::MiniAppRecord>, String> {
    storage_miniapps::list_all(pool.inner()).await
}

#[tauri::command]
pub async fn get_miniapp(
    pool: State<'_, DbPool>,
    id: String,
) -> Result<Option<storage_miniapps::MiniAppRecord>, String> {
    storage_miniapps::get(pool.inner(), &id).await
}

#[tauri::command]
pub async fn save_miniapp(
    pool: State<'_, DbPool>,
    miniapp: storage_miniapps::MiniAppRecord,
) -> Result<(), String> {
    storage_miniapps::upsert(pool.inner(), &miniapp).await
}

#[tauri::command]
pub async fn delete_miniapp(pool: State<'_, DbPool>, id: String) -> Result<(), String> {
    storage_miniapps::delete(pool.inner(), &id).await
}

/// Input for a headless status probe: what to run plus optional variable
/// values. `source` mirrors the TS `StatusSource` union (`commandRef` reuses
/// an existing library command by id; `inline` carries a self-contained
/// script). `variable_values` is optional — a probe with no variables omits
/// it, and `#[serde(default)]` deserialises that to an empty map.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusProbeInput {
    pub source: StatusSourceRecord,
    #[serde(default)]
    pub variable_values: BTreeMap<String, String>,
}

/// Result of a headless status probe. `fields` / `return_value` come from the
/// command's output-schema extraction (empty / `None` when there is no schema
/// or extraction failed); `stdout_tail` carries a trimmed slice of the run's
/// captured stdout so a no-schema probe can still surface a raw status string
/// (e.g. the `connected` / `disconnected` line a probe echoes). Mirrors the
/// TS `StatusProbeResult` interface.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusProbeResult {
    /// Terminal disposition of the run, using the same vocabulary as the
    /// HTTP-API handler: `"succeeded"` (clean exit 0), `"cancelled"`, or
    /// `"failed"` (non-zero exit / signal / wait error).
    pub status: String,
    pub exit_code: Option<i32>,
    /// Extracted output-schema fields. Empty when the command declared no
    /// schema or extraction failed — a status widget maps these through its
    /// `StatusMapping`.
    pub fields: BTreeMap<String, serde_json::Value>,
    /// The command's chosen return value, or `None` when there was no
    /// extraction.
    pub return_value: Option<serde_json::Value>,
    pub stdout_tail: Option<String>,
}

/// Run a Mini-App status source headlessly and return its extracted status.
///
/// The run is SILENT (no `execution-event` stream, so no OutputPanel opens)
/// and does NOT create a History row (the executor never writes History; this
/// command never calls a History function). Admin elevation is unavailable in
/// headless mode — a referenced command with `run_as_admin` is rejected up
/// front, and an `inline` source is always forced to run non-elevated.
#[tauri::command]
pub async fn run_miniapp_status_probe(
    app: AppHandle,
    pool: State<'_, DbPool>,
    state: State<'_, Arc<ExecutorState>>,
    input: StatusProbeInput,
) -> Result<StatusProbeResult, String> {
    // 1. Resolve the command to run from the status source (library command
    //    by id, or a synthetic record built from an inline script). This also
    //    enforces the headless admin-elevation guard.
    let cmd = resolve_status_command(pool.inner(), &input.source).await?;

    // 2. Build a silent, capturing, standalone (non-workflow) headless request
    //    — the exact shape used by the scheduler / HTTP-API paths. The
    //    caller-supplied execution id is generated here (a fresh UUID).
    let execution_id = uuid::Uuid::new_v4().to_string();
    let req = ExecuteRequest::for_command(
        &cmd,
        RunOptions {
            execution_id,
            variable_values: input.variable_values,
            workflow_run_id: None,
            timeout_override: None,
            working_dir_override: None,
            capture_output: true,
            silent: true,
        },
    );

    // 3. Spawn the run and await its terminal outcome over a oneshot channel,
    //    so the result is finalised in the BACKEND (independent of any open UI
    //    window) — exactly like a scheduled fire / API run.
    let (tx, rx) = oneshot::channel::<NodeOutcome>();
    executor::spawn_execution_with_completion(app, state.inner().clone(), req, Some(tx)).await?;
    let outcome = rx
        .await
        .map_err(|_| "status probe: execution completion channel dropped".to_string())?;

    Ok(map_probe_result(&outcome))
}

/// Resolve a [`StatusSourceRecord`] into the [`CommandRecord`] the executor
/// should run.
///
/// - `commandRef`: load the library command by id (404-style error when
///   missing) and reject `run_as_admin` (headless cannot prompt for sudo).
/// - `inline`: build a synthetic, never-persisted `CommandRecord` from the
///   inline script fields, forcing `run_as_admin = false`.
async fn resolve_status_command(
    pool: &DbPool,
    source: &StatusSourceRecord,
) -> Result<CommandRecord, String> {
    match source {
        StatusSourceRecord::CommandRef { command_id } => {
            let cmd = storage_commands::find_by_id(pool, command_id)
                .await?
                .ok_or_else(|| format!("status probe: command not found: {command_id}"))?;
            if cmd.run_as_admin {
                return Err(
                    "status probe: admin elevation is not available in headless mode".to_string(),
                );
            }
            Ok(cmd)
        }
        StatusSourceRecord::Inline {
            script,
            shell,
            variables,
        } => {
            // A synthetic, in-memory command for an inline status script. It is
            // never persisted, so the bookkeeping fields (name, timestamps,
            // counts) are inert placeholders; `for_command` only reads the
            // execution-relevant fields (script / shell / variables / target).
            // `run_as_admin` is forced false — headless cannot prompt.
            Ok(CommandRecord {
                id: String::from("miniapp-status-probe"),
                name: String::from("miniapp-status-probe"),
                name_key: None,
                description: None,
                description_key: None,
                icon: None,
                script: script.clone(),
                shell: shell.clone(),
                args: None,
                working_dir: None,
                prompt_working_dir: false,
                env: None,
                tags: Vec::new(),
                category_id: None,
                favorite: false,
                created_at: String::new(),
                updated_at: String::new(),
                last_run_at: None,
                run_count: 0,
                run_as_admin: false,
                variables: variables.clone().unwrap_or_default(),
                timeout_seconds: None,
                output_schema: None,
                scope: None,
                workflow_id: None,
                target: None,
                prompt_ssh_password: false,
                api_slug: None,
                api_enabled: false,
                explorer_enabled: false,
                explorer_path_variable: None,
                sound: None,
            })
        }
    }
}

/// Map a terminal [`NodeOutcome`] into the probe result. `fields` /
/// `return_value` come from the (optional) extraction; `stdout_tail` prefers
/// the executor-retained tail and falls back to the captured stdout lines
/// (non-workflow runs never retain `stdout_tail`, so the capture buffer —
/// always allocated for a probe — is the source for a no-schema probe).
fn map_probe_result(outcome: &NodeOutcome) -> StatusProbeResult {
    let (fields, return_value) = match &outcome.extracted {
        Some(extracted) => (
            extracted.fields.clone(),
            Some(extracted.return_value.clone()),
        ),
        None => (BTreeMap::new(), None),
    };
    StatusProbeResult {
        status: terminal_status_str(outcome).to_string(),
        exit_code: outcome.exit_code,
        fields,
        return_value,
        stdout_tail: probe_stdout_tail(outcome),
    }
}

/// Map a [`NodeOutcome`]'s terminal status to the same vocabulary used by the
/// HTTP-API handler (`"succeeded"` / `"cancelled"` / `"failed"`).
fn terminal_status_str(outcome: &NodeOutcome) -> &'static str {
    match outcome.status {
        TerminalStatus::Finished if outcome.exit_code == Some(0) => "succeeded",
        TerminalStatus::Cancelled => "cancelled",
        _ => "failed",
    }
}

/// Best-effort trimmed stdout tail for the probe result.
fn probe_stdout_tail(outcome: &NodeOutcome) -> Option<String> {
    if let Some(tail) = outcome.stdout_tail.as_ref() {
        let trimmed = tail.trim();
        return if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };
    }
    // Non-workflow runs do not retain `stdout_tail`; reconstruct a tail from
    // the captured stdout lines (`capture_output` was requested).
    let lines = outcome.output.as_ref()?;
    let joined = lines
        .iter()
        .filter(|l| matches!(l.stream, CapturedStream::Stdout))
        .map(|l| l.line.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let trimmed = joined.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The probe result serialises every field in camelCase so the JS
    /// `StatusProbeResult` interface maps 1:1 — a regression guard matching
    /// the wire-format tests on the storage records.
    #[test]
    fn probe_result_serializes_camelcase() {
        let mut fields = BTreeMap::new();
        fields.insert("state".to_string(), serde_json::json!("connected"));
        let result = StatusProbeResult {
            status: "succeeded".to_string(),
            exit_code: Some(0),
            fields,
            return_value: Some(serde_json::json!("connected")),
            stdout_tail: Some("connected".to_string()),
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["status"], "succeeded");
        assert_eq!(json["exitCode"], 0);
        assert_eq!(json["fields"]["state"], "connected");
        assert_eq!(json["returnValue"], "connected");
        assert_eq!(json["stdoutTail"], "connected");
        // snake_case must NOT leak through.
        assert!(json.get("exit_code").is_none());
        assert!(json.get("return_value").is_none());
        assert!(json.get("stdout_tail").is_none());
    }

    /// `terminal_status_str` mirrors the HTTP-API vocabulary exactly.
    #[test]
    fn terminal_status_classifies_outcome() {
        let mk = |status, code: Option<i32>| NodeOutcome {
            status,
            exit_code: code,
            extracted: None,
            duration_ms: 0,
            output: None,
            stdout_tail: None,
        };
        assert_eq!(
            terminal_status_str(&mk(TerminalStatus::Finished, Some(0))),
            "succeeded"
        );
        assert_eq!(
            terminal_status_str(&mk(TerminalStatus::Finished, Some(1))),
            "failed"
        );
        assert_eq!(
            terminal_status_str(&mk(TerminalStatus::Cancelled, None)),
            "cancelled"
        );
        assert_eq!(
            terminal_status_str(&mk(TerminalStatus::Error, None)),
            "failed"
        );
    }

    /// `probe_stdout_tail` reconstructs a trimmed tail from captured stdout
    /// lines when the executor did not retain `stdout_tail` (the non-workflow
    /// case), and returns `None` for an all-empty capture.
    #[test]
    fn probe_stdout_tail_falls_back_to_capture() {
        use crate::core::executor::CapturedLine;
        let outcome = NodeOutcome {
            status: TerminalStatus::Finished,
            exit_code: Some(0),
            extracted: None,
            duration_ms: 0,
            output: Some(vec![
                CapturedLine {
                    stream: CapturedStream::Stdout,
                    line: "connected".into(),
                },
                CapturedLine {
                    stream: CapturedStream::Stderr,
                    line: "warn".into(),
                },
                CapturedLine {
                    stream: CapturedStream::Stdout,
                    line: "".into(),
                },
            ]),
            stdout_tail: None,
        };
        assert_eq!(probe_stdout_tail(&outcome).as_deref(), Some("connected"));

        let empty = NodeOutcome {
            status: TerminalStatus::Finished,
            exit_code: Some(0),
            extracted: None,
            duration_ms: 0,
            output: Some(vec![]),
            stdout_tail: None,
        };
        assert_eq!(probe_stdout_tail(&empty), None);
    }
}
