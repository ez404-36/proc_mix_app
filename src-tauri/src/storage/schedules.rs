// CRUD operations for the `schedules` table.
//
// The wire-format struct `ScheduleRecord` mirrors the TypeScript `Schedule`
// type (see `src/types/schedule.ts`) and crosses the Tauri IPC boundary via
// `list_schedules`, `upsert_schedule`, `delete_schedule`, and
// `set_schedule_enabled`. All field names are serialised in camelCase to
// match the JS-side shape; the regression tests at the bottom of this file
// enforce that contract.
//
// `variable_values` is persisted as a JSON-encoded TEXT column. Its shape is
// polymorphic by `target_kind`: for a `command` target it is a flat object of
// name->value; for a `workflow` target it is an object of nodeId->(name->value).
// The storage layer keeps it a `serde_json::Value` and only round-trips it —
// the scheduler (`core::scheduler`) and the command layer own the typed
// interpretation, exactly as `storage::workflows` keeps node `kind` a plain
// string.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::security::schedule_secrets;
use crate::storage::DbPool;

/// Materialised representation of a single schedule as stored in SQLite and
/// exchanged over IPC. `variable_values` is a JSON value whose shape depends
/// on `target_kind` (see module docs); it defaults to an empty object so a
/// schedule with no variables round-trips cleanly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRecord {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    /// Run target discriminator: `"command"` or `"workflow"`. Kept a plain
    /// `String` (not an enum) so the storage layer only round-trips it; the
    /// scheduler owns the typed interpretation.
    pub target_kind: String,
    /// Logical FK into `commands.id` / `workflows.id`.
    pub target_id: String,
    /// 5-field Unix cron expression as typed by the user.
    pub cron: String,
    /// Pre-resolved per-run variable values (see module docs). Defaults to an
    /// empty object so absent payloads deserialise cleanly.
    #[serde(default = "empty_object")]
    pub variable_values: serde_json::Value,
    /// Suppress a fire when the previous run of this schedule is still in
    /// flight.
    #[serde(default)]
    pub skip_if_running: bool,
    /// Whether this schedule's background-fire output (console log +
    /// output-schema result) is persisted to history. Defaults to `true` (ON)
    /// so a schedule created before this field existed — or a legacy payload
    /// that omits it — opts into capture.
    #[serde(default = "default_true")]
    pub capture_output: bool,
    /// Missed-run policy when the app was closed across a fire time:
    /// `"none"` (skip — default), `"once"` (single catch-up), or `"all"`
    /// (one catch-up per missed occurrence, capped). Kept a plain `String`
    /// (not an enum) so storage only round-trips it; the scheduler owns the
    /// typed interpretation.
    #[serde(default = "catch_up_none")]
    pub catch_up_policy: String,
    /// Optional per-run timeout (seconds) for a command target, overriding the
    /// command's own timeout. `None` keeps the command's timeout (or none).
    #[serde(default)]
    pub timeout_seconds: Option<i64>,
    /// Number of times to re-run the target after a failed attempt (0 = none).
    #[serde(default)]
    pub max_retries: i64,
    pub created_at: String,
    pub updated_at: String,
    pub last_run_at: Option<String>,
    /// Status of the most recent fire: `"success"`, `"error"`,
    /// `"cancelled"`, `"missingVariable"`, or `"skipped"`. `None` until the
    /// schedule has fired at least once.
    pub last_run_status: Option<String>,
    /// Cached next fire time (ISO 8601, local) for display. Recomputed on
    /// startup and on every upsert; the scheduler does not rely on it for
    /// firing (it recomputes from the live cron each tick).
    pub next_run_at: Option<String>,
    pub run_count: i64,
}

fn empty_object() -> serde_json::Value {
    serde_json::Value::Object(serde_json::Map::new())
}

fn catch_up_none() -> String {
    "none".to_owned()
}

fn default_true() -> bool {
    true
}

/// Return every schedule in insertion order (oldest first).
pub async fn list_all(pool: &DbPool) -> Result<Vec<ScheduleRecord>, String> {
    let rows = sqlx::query(
        "SELECT id, name, enabled, target_kind, target_id, cron, variable_values, \
                skip_if_running, capture_output, catch_up_policy, timeout_seconds, max_retries, \
                created_at, updated_at, last_run_at, last_run_status, next_run_at, run_count \
         FROM schedules \
         ORDER BY created_at ASC",
    )
    .fetch_all(pool.as_ref())
    .await
    .map_err(|e| format!("list_all: {e}"))?;

    rows.into_iter().map(row_to_record).collect()
}

/// Fetch a single schedule by `id`, or `None` when it does not exist. Used by
/// the enable-toggle path to recompute `next_run_at` from the stored cron
/// (the command only receives `id` + `enabled`, not the full record).
pub async fn get(pool: &DbPool, id: &str) -> Result<Option<ScheduleRecord>, String> {
    let row = sqlx::query(
        "SELECT id, name, enabled, target_kind, target_id, cron, variable_values, \
                skip_if_running, capture_output, catch_up_policy, timeout_seconds, max_retries, \
                created_at, updated_at, last_run_at, last_run_status, next_run_at, run_count \
         FROM schedules \
         WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool.as_ref())
    .await
    .map_err(|e| format!("get: {e}"))?;

    row.map(row_to_record).transpose()
}

/// Count the rows in the `schedules` table. Used by the license quota gate
/// to decide whether a Basic-tier user may create another schedule.
pub async fn count_all(pool: &DbPool) -> Result<i64, String> {
    let row = sqlx::query("SELECT COUNT(*) AS n FROM schedules")
        .fetch_one(pool.as_ref())
        .await
        .map_err(|e| format!("count_all: {e}"))?;
    row.try_get::<i64, _>("n")
        .map_err(|e| format!("count_all read: {e}"))
}

/// Whether a schedule with `id` already exists. The quota gate uses this to
/// distinguish a NEW insert (counts against the Basic limit) from an update
/// to an existing schedule (always allowed).
pub async fn exists(pool: &DbPool, id: &str) -> Result<bool, String> {
    let row = sqlx::query("SELECT 1 FROM schedules WHERE id = ? LIMIT 1")
        .bind(id)
        .fetch_optional(pool.as_ref())
        .await
        .map_err(|e| format!("exists: {e}"))?;
    Ok(row.is_some())
}

/// Insert a new schedule or update an existing one (matched by `id`).
///
/// `sensitive_vars` is the set of variable names the schedule's TARGET command
/// marks `sensitive` (for a `command` target; empty for workflows in v1). Each
/// such value is moved OUT of the persisted `variable_values` JSON and into the
/// OS keychain via [`schedule_secrets`], leaving a non-secret sentinel in the
/// column. This keeps tokens/passwords off disk — they live only in the
/// keychain, exactly like the sudo password.
///
/// The keychain write is best-effort with respect to the DB write ORDER: we
/// store secrets FIRST, then persist the sentinel-redacted JSON, so a crash
/// between the two leaves a recoverable state (the secret is in the keychain;
/// the column either still has the old value or the new sentinel — never a new
/// plaintext secret). A keychain failure aborts the upsert with an error so the
/// caller can surface it rather than silently persisting a plaintext secret.
pub async fn upsert(
    pool: &DbPool,
    sched: &ScheduleRecord,
    sensitive_vars: &BTreeSet<String>,
) -> Result<(), String> {
    // Split sensitive values out to the keychain, replacing each with a
    // sentinel reference in the JSON that gets persisted. A no-op when the
    // target declares no sensitive variables (the common case).
    let redacted_values =
        persist_sensitive_values(&sched.id, &sched.variable_values, sensitive_vars)?;

    let variable_values_json = serde_json::to_string(&redacted_values)
        .map_err(|e| format!("encode variable_values: {e}"))?;

    sqlx::query(
        "INSERT INTO schedules ( \
            id, name, enabled, target_kind, target_id, cron, variable_values, \
            skip_if_running, capture_output, catch_up_policy, timeout_seconds, max_retries, \
            created_at, updated_at, last_run_at, \
            last_run_status, next_run_at, run_count \
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET \
            name = excluded.name, \
            enabled = excluded.enabled, \
            target_kind = excluded.target_kind, \
            target_id = excluded.target_id, \
            cron = excluded.cron, \
            variable_values = excluded.variable_values, \
            skip_if_running = excluded.skip_if_running, \
            capture_output = excluded.capture_output, \
            catch_up_policy = excluded.catch_up_policy, \
            timeout_seconds = excluded.timeout_seconds, \
            max_retries = excluded.max_retries, \
            updated_at = excluded.updated_at, \
            last_run_at = excluded.last_run_at, \
            last_run_status = excluded.last_run_status, \
            next_run_at = excluded.next_run_at, \
            run_count = excluded.run_count",
    )
    .bind(&sched.id)
    .bind(&sched.name)
    .bind(if sched.enabled { 1_i64 } else { 0_i64 })
    .bind(&sched.target_kind)
    .bind(&sched.target_id)
    .bind(&sched.cron)
    .bind(&variable_values_json)
    .bind(if sched.skip_if_running { 1_i64 } else { 0_i64 })
    .bind(if sched.capture_output { 1_i64 } else { 0_i64 })
    .bind(&sched.catch_up_policy)
    .bind(sched.timeout_seconds)
    .bind(sched.max_retries)
    .bind(&sched.created_at)
    .bind(&sched.updated_at)
    .bind(&sched.last_run_at)
    .bind(&sched.last_run_status)
    .bind(&sched.next_run_at)
    .bind(sched.run_count)
    .execute(pool.as_ref())
    .await
    .map_err(|e| format!("upsert: {e}"))?;

    Ok(())
}

/// Remove the schedule with the given id. A missing id is not an error
/// (matches the `commands::delete` idempotent semantics).
///
/// Also clears any keychain secrets this schedule owned. We read the stored
/// (sentinel-redacted) `variable_values` first to learn which variable names
/// held a secret, then delete each keychain entry so a removed schedule never
/// orphans a credential. Keychain clear failures are logged but do not block
/// the row delete — an orphaned keychain entry is harmless and the user can
/// still remove the schedule.
pub async fn delete(pool: &DbPool, id: &str) -> Result<(), String> {
    // Best-effort: clear the keychain secrets before dropping the row. If the
    // schedule is already gone, `get` returns None and this is a no-op.
    if let Ok(Some(sched)) = get(pool, id).await {
        clear_sensitive_values(id, &sched.variable_values);
    }

    sqlx::query("DELETE FROM schedules WHERE id = ?")
        .bind(id)
        .execute(pool.as_ref())
        .await
        .map_err(|e| format!("delete: {e}"))?;
    Ok(())
}

/// Move every `sensitive_vars` entry of a command-shape `variable_values`
/// object into the keychain and return a clone of the JSON with each such value
/// replaced by the [`schedule_secrets::SECRET_REF`] sentinel.
///
/// Non-sensitive values, and any value that is already the sentinel (an
/// unchanged re-save where the UI did not re-enter the secret), pass through
/// untouched — re-storing the sentinel as a keychain value would clobber the
/// real secret with garbage. Only a plaintext value for a sensitive variable is
/// stored and redacted.
///
/// Workflow-shape (nested) values are not redacted here: workflow targets do
/// not flow sensitive prompts through the schedule in v1, and the nested shape
/// has no command spec to consult. The function detects a non-object or nested
/// shape and returns it unchanged.
fn persist_sensitive_values(
    schedule_id: &str,
    values: &serde_json::Value,
    sensitive_vars: &BTreeSet<String>,
) -> Result<serde_json::Value, String> {
    // Nothing to do when the target has no sensitive variables.
    if sensitive_vars.is_empty() {
        return Ok(values.clone());
    }
    let Some(obj) = values.as_object() else {
        return Ok(values.clone());
    };

    let mut out = serde_json::Map::with_capacity(obj.len());
    for (name, value) in obj {
        let is_sensitive = sensitive_vars.contains(name);
        match value.as_str() {
            // A sensitive plaintext value → store in keychain, persist sentinel.
            Some(s) if is_sensitive && !schedule_secrets::is_secret_ref(s) => {
                if s.is_empty() {
                    // An empty secret carries nothing to protect; drop any prior
                    // keychain entry and persist the sentinel so the fire path
                    // treats it as "no stored secret" → missingVariable.
                    let _ = schedule_secrets::clear(schedule_id, name);
                } else {
                    schedule_secrets::set(schedule_id, name, s)
                        .map_err(|e| format!("store sensitive value for {name}: {e}"))?;
                }
                out.insert(
                    name.clone(),
                    serde_json::Value::String(schedule_secrets::SECRET_REF.to_string()),
                );
            }
            // Already a sentinel (unchanged re-save) or non-sensitive → keep.
            _ => {
                out.insert(name.clone(), value.clone());
            }
        }
    }
    Ok(serde_json::Value::Object(out))
}

/// Clear every keychain secret referenced by a schedule's stored
/// `variable_values` (i.e. each value equal to the sentinel). Best-effort —
/// individual clear failures are logged, never propagated, because an orphaned
/// keychain entry is harmless.
fn clear_sensitive_values(schedule_id: &str, values: &serde_json::Value) {
    let Some(obj) = values.as_object() else {
        return;
    };
    for (name, value) in obj {
        if value.as_str().is_some_and(schedule_secrets::is_secret_ref) {
            if let Err(e) = schedule_secrets::clear(schedule_id, name) {
                tracing::error!("schedules: failed to clear keychain secret for {name}: {e}");
            }
        }
    }
}

/// Resolve a schedule's stored command-shape `variable_values` back into real
/// values for a fire: every sentinel reference is swapped for the secret read
/// from the keychain. A sentinel with NO stored keychain entry (user cleared
/// it, or a backend error) resolves to `None` for that key — it is OMITTED from
/// the returned object so the executor treats it as an unset variable and
/// records a `missingVariable` run rather than passing the literal sentinel to
/// the child process.
///
/// Non-sentinel values pass through unchanged. Returns the resolved JSON object
/// the scheduler then decodes via `command_variable_values`.
pub fn resolve_sensitive_values(
    schedule_id: &str,
    values: &serde_json::Value,
) -> serde_json::Value {
    let Some(obj) = values.as_object() else {
        return values.clone();
    };
    let mut out = serde_json::Map::with_capacity(obj.len());
    for (name, value) in obj {
        match value.as_str() {
            Some(s) if schedule_secrets::is_secret_ref(s) => {
                match schedule_secrets::get(schedule_id, name) {
                    Ok(Some(secret)) => {
                        out.insert(name.clone(), serde_json::Value::String(secret));
                    }
                    // No stored secret (cleared) or a keychain error: omit the
                    // key so the fire reports a missing variable instead of
                    // leaking the sentinel into the command.
                    Ok(None) => {}
                    Err(e) => {
                        tracing::error!(
                            "schedules: failed to read keychain secret for {name}: {e}"
                        );
                    }
                }
            }
            _ => {
                out.insert(name.clone(), value.clone());
            }
        }
    }
    serde_json::Value::Object(out)
}

/// Toggle a schedule's `enabled` flag and refresh `updated_at`. Used by the
/// `set_schedule_enabled` command so the UI can flip a schedule on/off
/// without re-sending the whole record. A missing id is a no-op.
pub async fn set_enabled(
    pool: &DbPool,
    id: &str,
    enabled: bool,
    updated_at: &str,
) -> Result<(), String> {
    sqlx::query("UPDATE schedules SET enabled = ?, updated_at = ? WHERE id = ?")
        .bind(if enabled { 1_i64 } else { 0_i64 })
        .bind(updated_at)
        .bind(id)
        .execute(pool.as_ref())
        .await
        .map_err(|e| format!("set_enabled: {e}"))?;
    Ok(())
}

/// Record the outcome of a fire: bump `run_count`, stamp `last_run_at` /
/// `last_run_status`, and cache the freshly-computed `next_run_at`. Called by
/// the scheduler after each run attempt (including skipped / failed ones).
pub async fn record_run(
    pool: &DbPool,
    id: &str,
    last_run_at: &str,
    last_run_status: &str,
    next_run_at: Option<&str>,
) -> Result<(), String> {
    sqlx::query(
        "UPDATE schedules \
         SET run_count = run_count + 1, last_run_at = ?, last_run_status = ?, next_run_at = ? \
         WHERE id = ?",
    )
    .bind(last_run_at)
    .bind(last_run_status)
    .bind(next_run_at)
    .bind(id)
    .execute(pool.as_ref())
    .await
    .map_err(|e| format!("record_run: {e}"))?;
    Ok(())
}

/// Persist a freshly-computed `next_run_at` without counting a run. Used on
/// startup when the scheduler recomputes the next fire time from `now`
/// (missed-run = skip policy) so the cached display value stays accurate.
pub async fn set_next_run(
    pool: &DbPool,
    id: &str,
    next_run_at: Option<&str>,
) -> Result<(), String> {
    sqlx::query("UPDATE schedules SET next_run_at = ? WHERE id = ?")
        .bind(next_run_at)
        .bind(id)
        .execute(pool.as_ref())
        .await
        .map_err(|e| format!("set_next_run: {e}"))?;
    Ok(())
}

fn row_to_record(row: sqlx::sqlite::SqliteRow) -> Result<ScheduleRecord, String> {
    let enabled_i: i64 = row
        .try_get("enabled")
        .map_err(|e| format!("read enabled: {e}"))?;
    let skip_if_running_i: i64 = row
        .try_get("skip_if_running")
        .map_err(|e| format!("read skip_if_running: {e}"))?;
    let capture_output_i: i64 = row
        .try_get("capture_output")
        .map_err(|e| format!("read capture_output: {e}"))?;
    let variable_values_json: String = row
        .try_get("variable_values")
        .map_err(|e| format!("read variable_values: {e}"))?;
    let variable_values = serde_json::from_str::<serde_json::Value>(&variable_values_json)
        .map_err(|e| format!("decode variable_values: {e}"))?;

    Ok(ScheduleRecord {
        id: row.try_get("id").map_err(|e| format!("read id: {e}"))?,
        name: row.try_get("name").map_err(|e| format!("read name: {e}"))?,
        enabled: enabled_i != 0,
        target_kind: row
            .try_get("target_kind")
            .map_err(|e| format!("read target_kind: {e}"))?,
        target_id: row
            .try_get("target_id")
            .map_err(|e| format!("read target_id: {e}"))?,
        cron: row.try_get("cron").map_err(|e| format!("read cron: {e}"))?,
        variable_values,
        skip_if_running: skip_if_running_i != 0,
        capture_output: capture_output_i != 0,
        catch_up_policy: row
            .try_get("catch_up_policy")
            .map_err(|e| format!("read catch_up_policy: {e}"))?,
        timeout_seconds: row
            .try_get("timeout_seconds")
            .map_err(|e| format!("read timeout_seconds: {e}"))?,
        max_retries: row
            .try_get("max_retries")
            .map_err(|e| format!("read max_retries: {e}"))?,
        created_at: row
            .try_get("created_at")
            .map_err(|e| format!("read created_at: {e}"))?,
        updated_at: row
            .try_get("updated_at")
            .map_err(|e| format!("read updated_at: {e}"))?,
        last_run_at: row
            .try_get("last_run_at")
            .map_err(|e| format!("read last_run_at: {e}"))?,
        last_run_status: row
            .try_get("last_run_status")
            .map_err(|e| format!("read last_run_status: {e}"))?,
        next_run_at: row
            .try_get("next_run_at")
            .map_err(|e| format!("read next_run_at: {e}"))?,
        run_count: row
            .try_get("run_count")
            .map_err(|e| format!("read run_count: {e}"))?,
    })
}

#[cfg(test)]
mod wire_format_tests {
    use super::*;

    fn sample() -> ScheduleRecord {
        ScheduleRecord {
            id: "sch-1".into(),
            name: "Nightly backup".into(),
            enabled: true,
            target_kind: "command".into(),
            target_id: "cmd-1".into(),
            cron: "0 2 * * *".into(),
            variable_values: serde_json::json!({ "dir": "/tmp" }),
            skip_if_running: true,
            capture_output: true,
            catch_up_policy: "once".into(),
            timeout_seconds: Some(30),
            max_retries: 2,
            created_at: "2026-06-03T00:00:00Z".into(),
            updated_at: "2026-06-03T00:00:01Z".into(),
            last_run_at: Some("2026-06-03T02:00:00Z".into()),
            last_run_status: Some("success".into()),
            next_run_at: Some("2026-06-04T02:00:00Z".into()),
            run_count: 5,
        }
    }

    #[test]
    fn record_serializes_camelcase() {
        let rec = sample();
        let json = serde_json::to_value(&rec).unwrap();
        // Positive: every camelCase key is present.
        assert!(json.get("id").is_some());
        assert!(json.get("name").is_some());
        assert!(json.get("enabled").is_some());
        assert!(json.get("targetKind").is_some());
        assert!(json.get("targetId").is_some());
        assert!(json.get("cron").is_some());
        assert!(json.get("variableValues").is_some());
        assert!(json.get("skipIfRunning").is_some());
        assert!(json.get("captureOutput").is_some());
        assert!(json.get("catchUpPolicy").is_some());
        assert!(json.get("timeoutSeconds").is_some());
        assert!(json.get("maxRetries").is_some());
        assert!(json.get("createdAt").is_some());
        assert!(json.get("updatedAt").is_some());
        assert!(json.get("lastRunAt").is_some());
        assert!(json.get("lastRunStatus").is_some());
        assert!(json.get("nextRunAt").is_some());
        assert!(json.get("runCount").is_some());

        // Negative: snake_case must NOT leak through.
        assert!(json.get("target_kind").is_none());
        assert!(json.get("target_id").is_none());
        assert!(json.get("variable_values").is_none());
        assert!(json.get("skip_if_running").is_none());
        assert!(json.get("capture_output").is_none());
        assert!(json.get("catch_up_policy").is_none());
        assert!(json.get("timeout_seconds").is_none());
        assert!(json.get("max_retries").is_none());
        assert!(json.get("created_at").is_none());
        assert!(json.get("last_run_at").is_none());
        assert!(json.get("last_run_status").is_none());
        assert!(json.get("next_run_at").is_none());
        assert!(json.get("run_count").is_none());
    }

    #[test]
    fn record_roundtrips_through_json() {
        let rec = sample();
        let json = serde_json::to_string(&rec).unwrap();
        let back: ScheduleRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(rec, back);
    }

    /// A workflow-target schedule carries the nested nodeId->(name->value)
    /// shape; it must round-trip unchanged through the JSON column.
    #[test]
    fn workflow_variable_values_roundtrip() {
        let mut rec = sample();
        rec.target_kind = "workflow".into();
        rec.variable_values = serde_json::json!({
            "node-a": { "x": "1" },
            "node-b": { "y": "2", "z": "3" }
        });
        let json = serde_json::to_string(&rec).unwrap();
        let back: ScheduleRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(rec, back);
    }

    /// A minimal payload that omits `variableValues` / `skipIfRunning` must
    /// deserialize with the documented defaults (empty object / false).
    #[test]
    fn record_deserializes_with_defaults() {
        let json = serde_json::json!({
            "id": "sch-1",
            "name": "n",
            "enabled": false,
            "targetKind": "command",
            "targetId": "cmd-1",
            "cron": "* * * * *",
            "createdAt": "2026-06-03T00:00:00Z",
            "updatedAt": "2026-06-03T00:00:00Z",
            "lastRunAt": null,
            "lastRunStatus": null,
            "nextRunAt": null,
            "runCount": 0
        });
        let rec: ScheduleRecord = serde_json::from_value(json).unwrap();
        assert_eq!(rec.variable_values, empty_object());
        assert!(!rec.skip_if_running);
        // Omitted captureOutput defaults to true (capture ON).
        assert!(rec.capture_output);
        // Omitted catchUpPolicy defaults to "none".
        assert_eq!(rec.catch_up_policy, "none");
        // Omitted timeout/retries default to none / 0.
        assert_eq!(rec.timeout_seconds, None);
        assert_eq!(rec.max_retries, 0);
    }
}

#[cfg(test)]
mod sqlite_integration_tests {
    use super::*;
    use std::sync::Arc;

    /// No sensitive variables: the common case for these CRUD tests, which use
    /// non-sensitive `variable_values`. The keychain split path is exercised
    /// separately in `secret_redaction_tests`.
    fn no_secrets() -> BTreeSet<String> {
        BTreeSet::new()
    }

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

    fn fixture(id: &str, enabled: bool) -> ScheduleRecord {
        ScheduleRecord {
            id: id.into(),
            name: format!("name-{id}"),
            enabled,
            target_kind: "command".into(),
            target_id: "cmd-1".into(),
            cron: "0 2 * * *".into(),
            variable_values: serde_json::json!({ "k": "v" }),
            skip_if_running: false,
            capture_output: true,
            catch_up_policy: "none".into(),
            timeout_seconds: None,
            max_retries: 0,
            created_at: format!("2026-06-03T00:00:0{}", id.len() % 10),
            updated_at: "2026-06-03T00:00:00Z".into(),
            last_run_at: None,
            last_run_status: None,
            next_run_at: None,
            run_count: 0,
        }
    }

    #[tokio::test]
    async fn upsert_then_list_returns_inserted_record() {
        let pool = make_pool().await;
        let rec = fixture("one", true);
        upsert(&pool, &rec, &no_secrets()).await.unwrap();
        let listed = list_all(&pool).await.unwrap();
        assert_eq!(listed, vec![rec]);
    }

    #[tokio::test]
    async fn upsert_updates_existing_id() {
        let pool = make_pool().await;
        let mut rec = fixture("one", false);
        upsert(&pool, &rec, &no_secrets()).await.unwrap();
        rec.name = "renamed".into();
        rec.cron = "*/5 * * * *".into();
        rec.enabled = true;
        upsert(&pool, &rec, &no_secrets()).await.unwrap();
        let listed = list_all(&pool).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "renamed");
        assert_eq!(listed[0].cron, "*/5 * * * *");
        assert!(listed[0].enabled);
    }

    #[tokio::test]
    async fn get_returns_the_record_or_none() {
        let pool = make_pool().await;
        assert!(get(&pool, "one").await.unwrap().is_none());
        let rec = fixture("one", true);
        upsert(&pool, &rec, &no_secrets()).await.unwrap();
        assert_eq!(get(&pool, "one").await.unwrap(), Some(rec));
        assert!(get(&pool, "missing").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn set_next_run_round_trips_through_get() {
        let pool = make_pool().await;
        upsert(&pool, &fixture("one", true), &no_secrets())
            .await
            .unwrap();
        set_next_run(&pool, "one", Some("2026-06-04T02:00:00+00:00"))
            .await
            .unwrap();
        assert_eq!(
            get(&pool, "one").await.unwrap().unwrap().next_run_at,
            Some("2026-06-04T02:00:00+00:00".into())
        );
        set_next_run(&pool, "one", None).await.unwrap();
        assert_eq!(get(&pool, "one").await.unwrap().unwrap().next_run_at, None);
    }

    #[tokio::test]
    async fn delete_removes_record() {
        let pool = make_pool().await;
        upsert(&pool, &fixture("one", false), &no_secrets())
            .await
            .unwrap();
        delete(&pool, "one").await.unwrap();
        assert!(list_all(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn delete_missing_id_is_noop() {
        let pool = make_pool().await;
        delete(&pool, "does-not-exist").await.unwrap();
    }

    #[tokio::test]
    async fn count_all_and_exists_track_inserts() {
        let pool = make_pool().await;
        assert_eq!(count_all(&pool).await.unwrap(), 0);
        assert!(!exists(&pool, "a").await.unwrap());
        upsert(&pool, &fixture("a", true), &no_secrets())
            .await
            .unwrap();
        assert_eq!(count_all(&pool).await.unwrap(), 1);
        assert!(exists(&pool, "a").await.unwrap());
        // Updating the existing schedule does not increase the count.
        upsert(&pool, &fixture("a", false), &no_secrets())
            .await
            .unwrap();
        assert_eq!(count_all(&pool).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn set_enabled_flips_flag() {
        let pool = make_pool().await;
        upsert(&pool, &fixture("a", true), &no_secrets())
            .await
            .unwrap();
        set_enabled(&pool, "a", false, "2026-06-03T01:00:00Z")
            .await
            .unwrap();
        let listed = list_all(&pool).await.unwrap();
        assert!(!listed[0].enabled);
        assert_eq!(listed[0].updated_at, "2026-06-03T01:00:00Z");
    }

    #[tokio::test]
    async fn record_run_bumps_count_and_stamps_status() {
        let pool = make_pool().await;
        upsert(&pool, &fixture("a", true), &no_secrets())
            .await
            .unwrap();
        record_run(
            &pool,
            "a",
            "2026-06-03T02:00:00Z",
            "success",
            Some("2026-06-04T02:00:00Z"),
        )
        .await
        .unwrap();
        let listed = list_all(&pool).await.unwrap();
        assert_eq!(listed[0].run_count, 1);
        assert_eq!(
            listed[0].last_run_at.as_deref(),
            Some("2026-06-03T02:00:00Z")
        );
        assert_eq!(listed[0].last_run_status.as_deref(), Some("success"));
        assert_eq!(
            listed[0].next_run_at.as_deref(),
            Some("2026-06-04T02:00:00Z")
        );
    }

    #[tokio::test]
    async fn set_next_run_does_not_count_a_run() {
        let pool = make_pool().await;
        upsert(&pool, &fixture("a", true), &no_secrets())
            .await
            .unwrap();
        set_next_run(&pool, "a", Some("2026-06-04T02:00:00Z"))
            .await
            .unwrap();
        let listed = list_all(&pool).await.unwrap();
        assert_eq!(listed[0].run_count, 0);
        assert_eq!(
            listed[0].next_run_at.as_deref(),
            Some("2026-06-04T02:00:00Z")
        );
    }

    /// The polymorphic `variable_values` JSON column round-trips a nested
    /// workflow shape unchanged.
    #[tokio::test]
    async fn workflow_variable_values_persist() {
        let pool = make_pool().await;
        let mut rec = fixture("wf", true);
        rec.target_kind = "workflow".into();
        rec.target_id = "wf-1".into();
        rec.variable_values = serde_json::json!({ "node-a": { "x": "1" } });
        upsert(&pool, &rec, &no_secrets()).await.unwrap();
        let listed = list_all(&pool).await.unwrap();
        assert_eq!(listed[0].variable_values, rec.variable_values);
    }
}

/// Tests for the H-1 keychain-reference redaction of sensitive scheduled
/// variable values. These deliberately exercise the keychain-INDEPENDENT
/// decision logic only: like `security::admin_password`'s tests, we do NOT
/// drive a real keychain round-trip (the test config links the real platform
/// backend, which is unavailable / non-deterministic in CI). The keychain
/// write/read round-trip is covered by manual QA against a real OS keychain.
#[cfg(test)]
mod secret_redaction_tests {
    use super::*;

    /// With NO sensitive variables, `persist_sensitive_values` is a pure
    /// pass-through and never touches the keychain — the JSON is unchanged.
    #[test]
    fn persist_is_noop_without_sensitive_vars() {
        let values = serde_json::json!({ "host": "example.com", "token": "s3cr3t" });
        let out = persist_sensitive_values("sched-1", &values, &BTreeSet::new()).unwrap();
        assert_eq!(out, values, "no sensitive vars → JSON must be untouched");
    }

    /// A value that is ALREADY the sentinel (an unchanged re-save where the UI
    /// did not re-enter the secret) is kept as-is and never re-stored — so the
    /// real keychain secret is not clobbered. This path needs no keychain.
    #[test]
    fn persist_keeps_existing_sentinel_without_touching_keychain() {
        let mut sensitive = BTreeSet::new();
        sensitive.insert("token".to_string());
        let values = serde_json::json!({
            "host": "example.com",
            "token": schedule_secrets::SECRET_REF,
        });
        let out = persist_sensitive_values("sched-1", &values, &sensitive).unwrap();
        assert_eq!(
            out, values,
            "an existing sentinel must pass through unchanged"
        );
    }

    /// `resolve_sensitive_values` passes NON-sentinel values through unchanged
    /// without consulting the keychain — the common, secret-free fire path.
    #[test]
    fn resolve_passes_through_plain_values() {
        let values = serde_json::json!({ "host": "example.com", "port": "8080" });
        let out = resolve_sensitive_values("sched-1", &values);
        assert_eq!(out, values);
    }

    /// The persisted JSON for a SENSITIVE plaintext value must be the sentinel,
    /// not the secret — proving the value never lands in the column. Skipped
    /// gracefully when the OS keychain backend is unavailable (CI without
    /// D-Bus), exactly like the admin-password round-trip is left to manual QA:
    /// we assert the redaction only when the keychain `set` actually succeeded.
    #[test]
    fn persist_redacts_sensitive_plaintext_to_sentinel_when_keychain_available() {
        let mut sensitive = BTreeSet::new();
        sensitive.insert("token".to_string());
        let values = serde_json::json!({ "host": "example.com", "token": "s3cr3t" });

        match persist_sensitive_values("sched-redact-test", &values, &sensitive) {
            Ok(out) => {
                // The secret must NOT be in the column; the sentinel replaces it.
                let obj = out.as_object().expect("object");
                assert_eq!(
                    obj.get("token").and_then(|v| v.as_str()),
                    Some(schedule_secrets::SECRET_REF),
                    "sensitive value must be replaced by the keychain sentinel"
                );
                assert_eq!(
                    obj.get("host").and_then(|v| v.as_str()),
                    Some("example.com"),
                    "non-sensitive value must pass through unchanged"
                );
                let serialised = serde_json::to_string(&out).unwrap();
                assert!(
                    !serialised.contains("s3cr3t"),
                    "the persisted JSON must never contain the plaintext secret"
                );
                // Clean up the keychain entry we created.
                let _ = schedule_secrets::clear("sched-redact-test", "token");
            }
            Err(_) => {
                // Keychain backend unavailable in this environment — the
                // round-trip is covered by manual QA. Not a failure.
            }
        }
    }
}
