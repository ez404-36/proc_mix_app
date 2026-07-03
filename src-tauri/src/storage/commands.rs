// CRUD operations for the `commands` table.
//
// The wire-format struct `CommandRecord` mirrors the TypeScript `Command`
// type (see `src/types/command.ts`) and crosses the Tauri IPC boundary via
// `list_commands`, `upsert_command`, and `delete_command`. All field names
// are serialised in camelCase to match the JS-side shape; the regression
// tests at the bottom of this file enforce that contract.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::core::executor::ExecutionTarget;
use crate::storage::DbPool;

/// Specification of a user-declared variable referenced from a
/// command's `script`, `args`, `working_dir`, or `env` values via the
/// `${name}` / `${name:default}` syntax. The parser layer
/// (`core::parser`) consumes these to resolve substitutions; storage
/// only round-trips the values.
///
/// `default_value` semantics — note this mirrors the JS `VariableSpec`:
///   - `None`               → no default; the runner MUST prompt the
///     user at run time unless a value was supplied programmatically.
///   - `Some("".to_string())` → empty string is a *valid* default and
///     on its own does NOT trigger a prompt.
///   - `Some(non-empty)`    → used as the default value.
///
/// `prompt_at_runtime` is an explicit override:
///   - `false` (the legacy convention) → prompt only when
///     `default_value.is_none()`.
///   - `true` → always prompt, even when a `default_value` is set;
///     the default is pre-filled into the modal input as a suggestion
///     that the user can accept or override on each run.
///
/// `sensitive` is consumed by the executor for redaction in events
/// and logs; storage does not treat sensitive values specially.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VariableSpec {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
    /// Force a prompt at run time even when `default_value` is set.
    /// Skipped from the wire payload when `false` so older records that
    /// predate this field continue to round-trip identically.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub prompt_at_runtime: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub sensitive: bool,
}

/// Return a copy of `variables` with every `sensitive` spec's `default_value`
/// removed. A sensitive variable must never carry a baked-in plaintext default
/// secret on disk — it prompts at run time instead (or, for a schedule, draws
/// its value from the OS keychain). The non-secret spec fields (name,
/// description, `sensitive`) are preserved so the variable still works.
///
/// This runs at the storage boundary (`upsert`) so the rule holds regardless of
/// what the frontend sent — a buggy or older client cannot smuggle a secret
/// default into the `commands` table.
fn strip_sensitive_defaults(variables: &[VariableSpec]) -> Vec<VariableSpec> {
    variables
        .iter()
        .map(|spec| {
            if spec.sensitive {
                VariableSpec {
                    default_value: None,
                    ..spec.clone()
                }
            } else {
                spec.clone()
            }
        })
        .collect()
}

/// A single field extracted from a command's stdout. The locator field
/// that matters depends on the parser (see [`OutputSchemaRecord::parser`]):
///   - json   → `path`   (e.g. `items[0].name`)
///   - regex  → `group`  (named capture group)
///   - table  → `column` (header name, or numeric index as a string) →
///     the field is the array of that column's values across all rows
///   - lines  → `index`  (0-based line number) → the field is that line
///
/// Mirrors the TS `OutputField` interface (camelCase on the wire).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OutputFieldRecord {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<String>,
    /// Line index locator for the `lines` parser (0-based, as a string
    /// to match the other string locators on the wire).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// A single step in a parser pipeline. Mirrors `OutputPipelineStep` on
/// the TS side. The step's input is the output of the previous step (or
/// the raw stdout string for the first step); when the input is an array,
/// the step is applied to every element (map semantics).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OutputPipelineStepRecord {
    /// One of: "raw", "lines", "json", "regex", "keyValue", "table",
    /// "javascript".
    pub parser: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delimiter: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_header: Option<bool>,
    /// Maximum number of columns the table parser splits a row into. When set,
    /// the row is split into at most this many fields — everything past the
    /// last delimiter goes into the final column unsplit (useful for output
    /// like `ls -l` where the last column is a path that may contain spaces).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_columns: Option<usize>,
    #[serde(default)]
    pub fields: Vec<OutputFieldRecord>,
    /// User-written `function parse(data) { … }` source for the `javascript`
    /// parser. Ignored by every other parser kind. Run in a sandboxed Boa
    /// context by `core::js_parser` (no FS/network; time + size bounded).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

fn default_parser_kind() -> String {
    "raw".to_string()
}

/// Declarative description of a command's stdout shape. Persisted as the
/// `output_schema` TEXT column (JSON-encoded, NULL when absent) and
/// consumed by `core::extractor` after the command finishes. Mirrors the
/// TS `OutputSchema` interface exactly (camelCase on the wire).
///
/// **Single-parser mode** (backward-compatible): `pipeline` is absent or
/// empty; `parser` + optional config fields + `fields` drive extraction.
///
/// **Pipeline mode**: `pipeline` contains two or more steps executed in
/// order. The top-level `parser` / `pattern` / `delimiter` / `has_header`
/// / `fields` are ignored when `pipeline` is non-empty.
///
/// `return_field` always lives at the root level.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OutputSchemaRecord {
    /// One of: "raw", "lines", "json", "regex", "keyValue", "table".
    /// Kept a plain string here; `core::extractor` owns the typed
    /// interpretation, exactly as `WorkflowNodeRecord::kind` does.
    /// Default "raw" so pipeline-mode records (which omit this field) still
    /// deserialise cleanly — the extractor ignores `parser` when `pipeline`
    /// is non-empty.
    #[serde(default = "default_parser_kind")]
    pub parser: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delimiter: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_header: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_columns: Option<usize>,
    #[serde(default)]
    pub fields: Vec<OutputFieldRecord>,
    /// Pipeline of parser steps. When non-empty, takes precedence over
    /// the single-parser fields above.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pipeline: Vec<OutputPipelineStepRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub return_field: Option<String>,
    /// Editor-only saved sample of stdout, used to preview extraction.
    /// Persisted with the schema but ignored by `core::extractor`. May
    /// contain arbitrary command output; the UI warns about sensitive
    /// data before the user opts to save it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample: Option<String>,
}

/// Materialised representation of a single user command as stored in
/// SQLite and exchanged over IPC. List/object fields are persisted as
/// JSON-encoded TEXT columns (`tags_json`, `args_json`, `env_json`,
/// `variables`, `output_schema`) and decoded on read.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandRecord {
    pub id: String,
    pub name: String,
    pub name_key: Option<String>,
    pub description: Option<String>,
    pub description_key: Option<String>,
    pub icon: Option<String>,
    pub script: String,
    pub shell: Option<String>,
    pub args: Option<Vec<String>>,
    pub working_dir: Option<String>,
    pub env: Option<HashMap<String, String>>,
    pub tags: Vec<String>,
    pub category_id: Option<String>,
    pub favorite: bool,
    pub created_at: String,
    pub updated_at: String,
    pub last_run_at: Option<String>,
    pub run_count: i64,
    /// Mirror of the `run_as_admin` SQLite column. When true, the
    /// executor spawns this command with elevated privileges (sudo /
    /// UAC). Serialised as `runAsAdmin` to match the TS `Command`
    /// type. Defaults to `false` on missing JSON for backwards
    /// compatibility with payloads from older clients.
    #[serde(default)]
    pub run_as_admin: bool,
    /// Variable specs referenced by `${name}` / `${name:default}` in
    /// the script, args, working_dir, or env values. Persisted as the
    /// `variables` TEXT column (JSON-encoded array). `#[serde(default)]`
    /// keeps legacy payloads — which never sent this field — parsing
    /// cleanly.
    #[serde(default)]
    pub variables: Vec<VariableSpec>,
    /// Optional execution timeout in seconds. When set, the executor
    /// kills the spawned process after this many seconds have elapsed.
    /// `None` means no limit. Persisted as the `timeout_seconds`
    /// INTEGER column (NULL when absent). `#[serde(default)]` keeps
    /// legacy payloads parsing cleanly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u64>,
    /// Optional output schema describing how to parse this command's
    /// stdout into named fields. Persisted as the `output_schema` TEXT
    /// column (JSON-encoded, NULL when absent). `#[serde(default)]` keeps
    /// legacy payloads — which never sent this field — parsing cleanly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<OutputSchemaRecord>,
    /// Visibility scope. `"global"` (the default) means the command lives
    /// in the shared library. `"local"` means it belongs to a single
    /// workflow (see `workflow_id`): it is hidden from the global library
    /// and only usable inside its owning workflow's editor. Persisted as
    /// the `scope` TEXT column (DEFAULT `'global'`). `#[serde(default)]`
    /// keeps legacy payloads — which never sent this field — parsing
    /// cleanly; `None` is interpreted as `"global"` by the TS boundary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// Owning workflow id for a `"local"`-scoped command. `None` for
    /// global commands. Persisted as the `workflow_id` TEXT column (NULL
    /// when absent). Serialised as `workflowId` to match the TS `Command`
    /// type.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    /// Where this command runs. `None` (the default for legacy rows and for
    /// commands that never set a target) is interpreted as
    /// [`ExecutionTarget::Local`] by the executor. Persisted as the `target`
    /// TEXT column (JSON-encoded `ExecutionTarget`, NULL when absent).
    /// Serialised as `target` to match the TS `Command` type.
    /// `#[serde(default)]` keeps legacy payloads — which never sent this
    /// field — parsing cleanly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<ExecutionTarget>,
    /// Optional stable slug used to address this command over the built-in HTTP
    /// API. `None` (the default) means no slug — the API can still address the
    /// command by `id`. Persisted as the `api_slug` TEXT column (NULL when
    /// absent); uniqueness among non-NULL slugs is enforced by a partial unique
    /// index. Serialised as `apiSlug`. `#[serde(default)]` keeps legacy payloads
    /// parsing cleanly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_slug: Option<String>,
    /// Whether this command may be run over the built-in HTTP API. `false` (the
    /// default) keeps it invisible to the API until the user opts in. Persisted
    /// as the `api_enabled` INTEGER column. Serialised as `apiEnabled`.
    #[serde(default)]
    pub api_enabled: bool,
    /// Whether this command appears in the OS file-manager ("Explorer") context
    /// menu. `false` (the default) keeps it out of the menu until the user opts
    /// in — this is INDEPENDENT of the `favorite` flag. Persisted as the
    /// `explorer_enabled` INTEGER column. Serialised as `explorerEnabled`.
    #[serde(default)]
    pub explorer_enabled: bool,
    /// Optional name of a command variable that should receive the right-clicked
    /// filesystem path (`PROCMIX_SELECTED_PATH`) when the command is launched
    /// from the Explorer context menu. `None` (the default) means the path is
    /// only exposed via the reserved `PROCMIX_SELECTED_PATH` variable. Persisted
    /// as the `explorer_path_variable` TEXT column (NULL when absent).
    /// Serialised as `explorerPathVariable`. `#[serde(default)]` keeps legacy
    /// payloads parsing cleanly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explorer_path_variable: Option<String>,
}

/// Return every command in insertion order (oldest first).
pub async fn list_all(pool: &DbPool) -> Result<Vec<CommandRecord>, String> {
    let rows = sqlx::query(
        "SELECT id, name, name_key, description, description_key, icon, script, shell, \
                args_json, working_dir, env_json, tags_json, category_id, favorite, \
                created_at, updated_at, last_run_at, run_count, run_as_admin, variables, \
                timeout_seconds, output_schema, scope, workflow_id, target, \
                api_slug, api_enabled, explorer_enabled, explorer_path_variable \
         FROM commands \
         ORDER BY created_at ASC",
    )
    .fetch_all(pool.as_ref())
    .await
    .map_err(|e| format!("list_all: {e}"))?;

    rows.into_iter().map(row_to_record).collect()
}

/// Load every command and key it by id for the workflow engine.
///
/// A workflow node carries only a `commandId`; the engine needs the full
/// [`CommandRecord`] to spawn it, so `execute_workflow` resolves the whole
/// table up front into a lookup map. Encapsulating `list_all` + the
/// `HashMap` assembly here keeps the Tauri command a thin adapter. The map
/// is keyed by `CommandRecord::id` (unique — it is the table's primary key),
/// so no entry is silently dropped.
pub async fn resolve_map(pool: &DbPool) -> Result<HashMap<String, CommandRecord>, String> {
    let all = list_all(pool).await?;
    Ok(all.into_iter().map(|c| (c.id.clone(), c)).collect())
}

/// Count the rows in the `commands` table. Used by the license quota gate
/// to decide whether a Basic-tier user may create another command.
pub async fn count_all(pool: &DbPool) -> Result<i64, String> {
    let row = sqlx::query("SELECT COUNT(*) AS n FROM commands")
        .fetch_one(pool.as_ref())
        .await
        .map_err(|e| format!("count_all: {e}"))?;
    row.try_get::<i64, _>("n")
        .map_err(|e| format!("count_all read: {e}"))
}

/// Whether a command with `id` already exists. The quota gate uses this to
/// distinguish a NEW insert (which counts against the Basic limit) from an
/// update to an existing command (always allowed).
pub async fn exists(pool: &DbPool, id: &str) -> Result<bool, String> {
    let row = sqlx::query("SELECT 1 FROM commands WHERE id = ? LIMIT 1")
        .bind(id)
        .fetch_optional(pool.as_ref())
        .await
        .map_err(|e| format!("exists: {e}"))?;
    Ok(row.is_some())
}

/// Insert a new command or update an existing one (matched by `id`).
pub async fn upsert(pool: &DbPool, cmd: &CommandRecord) -> Result<(), String> {
    let args_json = match &cmd.args {
        Some(v) => Some(serde_json::to_string(v).map_err(|e| format!("encode args: {e}"))?),
        None => None,
    };
    let env_json = match &cmd.env {
        Some(v) => Some(serde_json::to_string(v).map_err(|e| format!("encode env: {e}"))?),
        None => None,
    };
    let tags_json = serde_json::to_string(&cmd.tags).map_err(|e| format!("encode tags: {e}"))?;
    // Never persist a `sensitive` variable's default value to disk: a baked-in
    // default for a secret would write a plaintext token/password into the
    // `variables` TEXT column, defeating the `sensitive` flag's whole purpose.
    // The spec (name / description / `sensitive`) is kept so the variable still
    // prompts at run time; only the secret default is dropped. See H-1 in
    // `docs/plans/security-audit-remediation-plan.md`.
    let sanitized_variables = strip_sensitive_defaults(&cmd.variables);
    let variables_json = serde_json::to_string(&sanitized_variables)
        .map_err(|e| format!("encode variables: {e}"))?;
    let output_schema_json = match &cmd.output_schema {
        Some(s) => {
            Some(serde_json::to_string(s).map_err(|e| format!("encode output_schema: {e}"))?)
        }
        None => None,
    };
    // Persist the target as JSON. A `None` target (no remote config) is stored
    // as NULL, which `row_to_record` decodes back to `Local` — keeping the
    // column empty for the overwhelmingly common local command.
    let target_json = match &cmd.target {
        Some(t) => Some(serde_json::to_string(t).map_err(|e| format!("encode target: {e}"))?),
        None => None,
    };

    sqlx::query(
        "INSERT INTO commands ( \
            id, name, name_key, description, description_key, icon, script, shell, \
            args_json, working_dir, env_json, tags_json, category_id, favorite, \
            created_at, updated_at, last_run_at, run_count, run_as_admin, variables, \
            timeout_seconds, output_schema, scope, workflow_id, target, \
            api_slug, api_enabled, explorer_enabled, explorer_path_variable \
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET \
            name = excluded.name, \
            name_key = excluded.name_key, \
            description = excluded.description, \
            description_key = excluded.description_key, \
            icon = excluded.icon, \
            script = excluded.script, \
            shell = excluded.shell, \
            args_json = excluded.args_json, \
            working_dir = excluded.working_dir, \
            env_json = excluded.env_json, \
            tags_json = excluded.tags_json, \
            category_id = excluded.category_id, \
            favorite = excluded.favorite, \
            updated_at = excluded.updated_at, \
            last_run_at = excluded.last_run_at, \
            run_count = excluded.run_count, \
            run_as_admin = excluded.run_as_admin, \
            variables = excluded.variables, \
            timeout_seconds = excluded.timeout_seconds, \
            output_schema = excluded.output_schema, \
            scope = excluded.scope, \
            workflow_id = excluded.workflow_id, \
            target = excluded.target, \
            api_slug = excluded.api_slug, \
            api_enabled = excluded.api_enabled, \
            explorer_enabled = excluded.explorer_enabled, \
            explorer_path_variable = excluded.explorer_path_variable",
    )
    .bind(&cmd.id)
    .bind(&cmd.name)
    .bind(&cmd.name_key)
    .bind(&cmd.description)
    .bind(&cmd.description_key)
    .bind(&cmd.icon)
    .bind(&cmd.script)
    .bind(&cmd.shell)
    .bind(&args_json)
    .bind(&cmd.working_dir)
    .bind(&env_json)
    .bind(&tags_json)
    .bind(&cmd.category_id)
    .bind(if cmd.favorite { 1_i64 } else { 0_i64 })
    .bind(&cmd.created_at)
    .bind(&cmd.updated_at)
    .bind(&cmd.last_run_at)
    .bind(cmd.run_count)
    .bind(if cmd.run_as_admin { 1_i64 } else { 0_i64 })
    .bind(&variables_json)
    .bind(cmd.timeout_seconds.map(|v| v as i64))
    .bind(&output_schema_json)
    // Normalise an absent scope to the explicit `"global"` default so the
    // column is never NULL (mirrors the schema DEFAULT). A `"local"` command
    // carries its owning `workflow_id`; a global one binds NULL.
    .bind(cmd.scope.clone().unwrap_or_else(|| "global".to_string()))
    .bind(&cmd.workflow_id)
    .bind(&target_json)
    // An empty slug from the UI is normalised to NULL so "no slug" is a single
    // representation (NULL) — never an empty string that would also collide in
    // the partial unique index if two commands sent "".
    .bind(cmd.api_slug.as_deref().filter(|s| !s.is_empty()))
    .bind(if cmd.api_enabled { 1_i64 } else { 0_i64 })
    .bind(if cmd.explorer_enabled { 1_i64 } else { 0_i64 })
    // An empty variable name from the UI ("— don't substitute —") normalises to
    // NULL so "no variable" is a single representation.
    .bind(cmd.explorer_path_variable.as_deref().filter(|s| !s.is_empty()))
    .execute(pool.as_ref())
    .await
    .map_err(|e| format!("upsert: {e}"))?;

    Ok(())
}

/// Remove the command with the given id. A missing id is not an error
/// (matches the in-memory store semantics where delete is idempotent).
pub async fn delete(pool: &DbPool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM commands WHERE id = ?")
        .bind(id)
        .execute(pool.as_ref())
        .await
        .map_err(|e| format!("delete: {e}"))?;
    Ok(())
}

/// Remove every `local`-scoped command owned by the given workflow. Used to
/// cascade-delete a workflow's private commands when the workflow itself is
/// deleted — they live with the workflow, so they go with it. Idempotent: a
/// workflow with no local commands is a no-op.
pub async fn delete_local_for_workflow(pool: &DbPool, workflow_id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM commands WHERE scope = 'local' AND workflow_id = ?")
        .bind(workflow_id)
        .execute(pool.as_ref())
        .await
        .map_err(|e| format!("delete_local_for_workflow: {e}"))?;
    Ok(())
}

fn row_to_record(row: sqlx::sqlite::SqliteRow) -> Result<CommandRecord, String> {
    let args_json: Option<String> = row
        .try_get("args_json")
        .map_err(|e| format!("read args_json: {e}"))?;
    let env_json: Option<String> = row
        .try_get("env_json")
        .map_err(|e| format!("read env_json: {e}"))?;
    let tags_json: String = row
        .try_get("tags_json")
        .map_err(|e| format!("read tags_json: {e}"))?;
    let favorite_i: i64 = row
        .try_get("favorite")
        .map_err(|e| format!("read favorite: {e}"))?;
    let run_as_admin_i: i64 = row
        .try_get("run_as_admin")
        .map_err(|e| format!("read run_as_admin: {e}"))?;
    let variables_json: String = row
        .try_get("variables")
        .map_err(|e| format!("read variables: {e}"))?;

    let args = match args_json {
        Some(s) => Some(
            serde_json::from_str::<Vec<String>>(&s)
                .map_err(|e| format!("decode args_json: {e}"))?,
        ),
        None => None,
    };
    let env = match env_json {
        Some(s) => Some(
            serde_json::from_str::<HashMap<String, String>>(&s)
                .map_err(|e| format!("decode env_json: {e}"))?,
        ),
        None => None,
    };
    let tags = serde_json::from_str::<Vec<String>>(&tags_json)
        .map_err(|e| format!("decode tags_json: {e}"))?;
    let variables = serde_json::from_str::<Vec<VariableSpec>>(&variables_json)
        .map_err(|e| format!("decode variables: {e}"))?;
    let timeout_seconds: Option<i64> = row
        .try_get("timeout_seconds")
        .map_err(|e| format!("read timeout_seconds: {e}"))?;
    let output_schema_json: Option<String> = row
        .try_get("output_schema")
        .map_err(|e| format!("read output_schema: {e}"))?;
    let output_schema = match output_schema_json {
        Some(s) => Some(
            serde_json::from_str::<OutputSchemaRecord>(&s)
                .map_err(|e| format!("decode output_schema: {e}"))?,
        ),
        None => None,
    };
    let scope: Option<String> = row
        .try_get("scope")
        .map_err(|e| format!("read scope: {e}"))?;
    let workflow_id: Option<String> = row
        .try_get("workflow_id")
        .map_err(|e| format!("read workflow_id: {e}"))?;
    let target_json: Option<String> = row
        .try_get("target")
        .map_err(|e| format!("read target: {e}"))?;
    let target = match target_json {
        Some(s) => Some(
            serde_json::from_str::<ExecutionTarget>(&s)
                .map_err(|e| format!("decode target: {e}"))?,
        ),
        None => None,
    };
    let api_slug: Option<String> = row
        .try_get("api_slug")
        .map_err(|e| format!("read api_slug: {e}"))?;
    let api_enabled_i: i64 = row
        .try_get("api_enabled")
        .map_err(|e| format!("read api_enabled: {e}"))?;
    let explorer_enabled_i: i64 = row
        .try_get("explorer_enabled")
        .map_err(|e| format!("read explorer_enabled: {e}"))?;
    let explorer_path_variable: Option<String> = row
        .try_get("explorer_path_variable")
        .map_err(|e| format!("read explorer_path_variable: {e}"))?;

    Ok(CommandRecord {
        id: row.try_get("id").map_err(|e| format!("read id: {e}"))?,
        name: row.try_get("name").map_err(|e| format!("read name: {e}"))?,
        name_key: row
            .try_get("name_key")
            .map_err(|e| format!("read name_key: {e}"))?,
        description: row
            .try_get("description")
            .map_err(|e| format!("read description: {e}"))?,
        description_key: row
            .try_get("description_key")
            .map_err(|e| format!("read description_key: {e}"))?,
        icon: row.try_get("icon").map_err(|e| format!("read icon: {e}"))?,
        script: row
            .try_get("script")
            .map_err(|e| format!("read script: {e}"))?,
        shell: row
            .try_get("shell")
            .map_err(|e| format!("read shell: {e}"))?,
        args,
        working_dir: row
            .try_get("working_dir")
            .map_err(|e| format!("read working_dir: {e}"))?,
        env,
        tags,
        category_id: row
            .try_get("category_id")
            .map_err(|e| format!("read category_id: {e}"))?,
        favorite: favorite_i != 0,
        created_at: row
            .try_get("created_at")
            .map_err(|e| format!("read created_at: {e}"))?,
        updated_at: row
            .try_get("updated_at")
            .map_err(|e| format!("read updated_at: {e}"))?,
        last_run_at: row
            .try_get("last_run_at")
            .map_err(|e| format!("read last_run_at: {e}"))?,
        run_count: row
            .try_get("run_count")
            .map_err(|e| format!("read run_count: {e}"))?,
        run_as_admin: run_as_admin_i != 0,
        variables,
        timeout_seconds: timeout_seconds.map(|v| v as u64),
        output_schema,
        scope,
        workflow_id,
        target,
        api_slug,
        api_enabled: api_enabled_i != 0,
        explorer_enabled: explorer_enabled_i != 0,
        explorer_path_variable,
    })
}

/// Resolve a command for the HTTP API by `reference`, which is matched first
/// against `api_slug` and then (as a fallback) against `id`. Returns the record
/// ONLY when it is API-enabled (`api_enabled = 1`); an existing-but-not-opted-in
/// command resolves to `None` so the API endpoint returns 404 (it must be
/// indistinguishable from a non-existent one — opting in is the gate). A
/// non-empty `reference` is required; empty input resolves to `None`.
pub async fn find_by_api_ref(
    pool: &DbPool,
    reference: &str,
) -> Result<Option<CommandRecord>, String> {
    if reference.is_empty() {
        return Ok(None);
    }
    // Slug match first (the canonical address), then id fallback. Both are
    // gated on `api_enabled = 1` directly in SQL so a disabled command is never
    // even returned to the caller. Parameterised — `reference` is bound, never
    // interpolated.
    let row = sqlx::query(
        "SELECT id, name, name_key, description, description_key, icon, script, shell, \
                args_json, working_dir, env_json, tags_json, category_id, favorite, \
                created_at, updated_at, last_run_at, run_count, run_as_admin, variables, \
                timeout_seconds, output_schema, scope, workflow_id, target, \
                api_slug, api_enabled, explorer_enabled, explorer_path_variable \
         FROM commands \
         WHERE api_enabled = 1 AND (api_slug = ? OR id = ?) \
         ORDER BY (api_slug = ?) DESC \
         LIMIT 1",
    )
    .bind(reference)
    .bind(reference)
    .bind(reference)
    .fetch_optional(pool.as_ref())
    .await
    .map_err(|e| format!("find_by_api_ref: {e}"))?;

    match row {
        Some(row) => Ok(Some(row_to_record(row)?)),
        None => Ok(None),
    }
}

/// Load a single command by its primary-key `id`. Returns `Ok(None)` when no
/// row matches. A targeted point lookup used by the scheduler's fire path
/// instead of loading the whole table to find one command.
pub async fn find_by_id(pool: &DbPool, id: &str) -> Result<Option<CommandRecord>, String> {
    let row = sqlx::query(
        "SELECT id, name, name_key, description, description_key, icon, script, shell, \
                args_json, working_dir, env_json, tags_json, category_id, favorite, \
                created_at, updated_at, last_run_at, run_count, run_as_admin, variables, \
                timeout_seconds, output_schema, scope, workflow_id, target, \
                api_slug, api_enabled, explorer_enabled, explorer_path_variable \
         FROM commands \
         WHERE id = ? \
         LIMIT 1",
    )
    .bind(id)
    .fetch_optional(pool.as_ref())
    .await
    .map_err(|e| format!("find_by_id: {e}"))?;

    match row {
        Some(row) => Ok(Some(row_to_record(row)?)),
        None => Ok(None),
    }
}

#[cfg(test)]
mod wire_format_tests {
    use super::*;

    fn sample() -> CommandRecord {
        CommandRecord {
            id: "abc".into(),
            name: "n".into(),
            name_key: Some("k".into()),
            description: Some("d".into()),
            description_key: Some("dk".into()),
            icon: Some("i".into()),
            script: "echo".into(),
            shell: Some("bash".into()),
            args: Some(vec!["--flag".into()]),
            working_dir: Some("/tmp".into()),
            env: Some({
                let mut m = HashMap::new();
                m.insert("FOO".into(), "bar".into());
                m
            }),
            tags: vec!["t1".into()],
            category_id: Some("c1".into()),
            favorite: true,
            created_at: "2026-05-28T00:00:00Z".into(),
            updated_at: "2026-05-28T00:00:01Z".into(),
            last_run_at: Some("2026-05-28T00:00:02Z".into()),
            run_count: 7,
            run_as_admin: true,
            variables: vec![VariableSpec {
                name: "who".into(),
                default_value: Some("world".into()),
                prompt_at_runtime: false,
                description: Some("Greeting target".into()),
                sensitive: false,
            }],
            timeout_seconds: Some(30),
            output_schema: Some(OutputSchemaRecord {
                parser: "json".into(),
                source: Some("stdout".into()),
                pattern: None,
                delimiter: None,
                has_header: None,
                max_columns: None,
                fields: vec![OutputFieldRecord {
                    name: "count".into(),
                    path: Some("items.length".into()),
                    group: None,
                    column: None,
                    index: None,
                    description: Some("Number of items".into()),
                }],
                pipeline: Vec::new(),
                return_field: Some("count".into()),
                sample: None,
            }),
            scope: Some("local".into()),
            workflow_id: Some("wf-1".into()),
            target: None,
            api_slug: Some("deploy".into()),
            api_enabled: true,
            explorer_enabled: true,
            explorer_path_variable: Some("target".into()),
        }
    }

    #[test]
    fn record_serializes_camelcase() {
        let rec = sample();
        let json = serde_json::to_value(&rec).unwrap();
        // Positive: every camelCase key is present.
        assert!(json.get("id").is_some());
        assert!(json.get("name").is_some());
        assert!(json.get("nameKey").is_some());
        assert!(json.get("description").is_some());
        assert!(json.get("descriptionKey").is_some());
        assert!(json.get("icon").is_some());
        assert!(json.get("script").is_some());
        assert!(json.get("shell").is_some());
        assert!(json.get("args").is_some());
        assert!(json.get("workingDir").is_some());
        assert!(json.get("env").is_some());
        assert!(json.get("tags").is_some());
        assert!(json.get("categoryId").is_some());
        assert!(json.get("favorite").is_some());
        assert!(json.get("createdAt").is_some());
        assert!(json.get("updatedAt").is_some());
        assert!(json.get("lastRunAt").is_some());
        assert!(json.get("runCount").is_some());
        assert!(json.get("runAsAdmin").is_some());
        assert!(json.get("variables").is_some());
        assert!(json.get("timeoutSeconds").is_some());
        assert!(json.get("outputSchema").is_some());
        assert!(json.get("scope").is_some());
        assert!(json.get("workflowId").is_some());
        // The nested schema must also be camelCase on the wire.
        let schema = json.get("outputSchema").unwrap();
        assert!(schema.get("parser").is_some());
        assert!(schema.get("returnField").is_some());
        assert!(schema.get("return_field").is_none());

        // Negative: snake_case must NOT leak through.
        assert!(json.get("name_key").is_none());
        assert!(json.get("description_key").is_none());
        assert!(json.get("working_dir").is_none());
        assert!(json.get("category_id").is_none());
        assert!(json.get("created_at").is_none());
        assert!(json.get("updated_at").is_none());
        assert!(json.get("last_run_at").is_none());
        assert!(json.get("run_count").is_none());
        assert!(json.get("run_as_admin").is_none());
        assert!(json.get("timeout_seconds").is_none());
        assert!(json.get("workflow_id").is_none());
    }

    /// Legacy clients that predate the admin feature don't include
    /// `runAsAdmin` in their payloads. The struct must accept that
    /// JSON unchanged and default the field to `false` — otherwise
    /// every existing command in storage would fail to deserialize.
    #[test]
    fn record_deserializes_when_run_as_admin_is_absent() {
        let json = serde_json::json!({
            "id": "abc",
            "name": "n",
            "nameKey": null,
            "description": null,
            "descriptionKey": null,
            "icon": null,
            "script": "echo",
            "shell": null,
            "args": null,
            "workingDir": null,
            "env": null,
            "tags": [],
            "categoryId": null,
            "favorite": false,
            "createdAt": "2026-05-28T00:00:00Z",
            "updatedAt": "2026-05-28T00:00:00Z",
            "lastRunAt": null,
            "runCount": 0
        });
        let rec: CommandRecord = serde_json::from_value(json).unwrap();
        assert!(!rec.run_as_admin);
    }

    #[test]
    fn record_roundtrips_through_json() {
        let rec = sample();
        let json = serde_json::to_string(&rec).unwrap();
        let back: CommandRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(rec, back);
    }

    /// VariableSpec uses `defaultValue` (camelCase) on the wire.
    /// `description`/`sensitive` likewise. snake_case must never leak.
    #[test]
    fn variable_spec_wire_format_is_camelcase() {
        let spec = VariableSpec {
            name: "n".into(),
            default_value: Some("d".into()),
            prompt_at_runtime: false,
            description: Some("desc".into()),
            sensitive: true,
        };
        let json = serde_json::to_value(&spec).unwrap();
        assert_eq!(json["name"], "n");
        assert_eq!(json["defaultValue"], "d");
        assert_eq!(json["description"], "desc");
        assert_eq!(json["sensitive"], true);
        assert!(json.get("default_value").is_none());
        // promptAtRuntime: false is the legacy default — must be absent
        // from the wire payload so older clients accept it unchanged.
        assert!(json.get("promptAtRuntime").is_none());
        assert!(json.get("prompt_at_runtime").is_none());
    }

    /// When `prompt_at_runtime: true`, the field MUST appear in the
    /// wire payload as `promptAtRuntime: true` so the runner knows to
    /// prompt even though a `defaultValue` is also present.
    #[test]
    fn variable_spec_serializes_prompt_at_runtime_when_true() {
        let spec = VariableSpec {
            name: "host".into(),
            default_value: Some("localhost".into()),
            prompt_at_runtime: true,
            description: None,
            sensitive: false,
        };
        let json = serde_json::to_value(&spec).unwrap();
        assert_eq!(json["defaultValue"], "localhost");
        assert_eq!(json["promptAtRuntime"], true);
        // Round-trip: deserialize back and verify the field survives.
        let back: VariableSpec = serde_json::from_value(json).unwrap();
        assert_eq!(back, spec);
    }

    /// Older command records have no `promptAtRuntime` key. Deserializing
    /// such records must succeed and default the field to `false`, so
    /// the legacy "no default ⇒ prompt" convention continues to apply.
    #[test]
    fn variable_spec_deserializes_legacy_records_with_no_prompt_field() {
        let legacy = serde_json::json!({
            "name": "who",
            "defaultValue": "world",
            "sensitive": false,
        });
        let spec: VariableSpec = serde_json::from_value(legacy).unwrap();
        assert_eq!(spec.name, "who");
        assert_eq!(spec.default_value.as_deref(), Some("world"));
        assert!(!spec.prompt_at_runtime);
    }

    /// Empty inline default `""` is a *valid* value distinct from `None`
    /// — the parser must treat it as "default to empty string" rather
    /// than "no default, prompt the user". Lock the wire shape so a
    /// future serde rename can't collapse the two cases.
    #[test]
    fn variable_spec_distinguishes_empty_default_from_none() {
        let with_empty = VariableSpec {
            name: "x".into(),
            default_value: Some(String::new()),
            prompt_at_runtime: false,
            description: None,
            sensitive: false,
        };
        let with_none = VariableSpec {
            name: "x".into(),
            default_value: None,
            prompt_at_runtime: false,
            description: None,
            sensitive: false,
        };
        let j_empty = serde_json::to_value(&with_empty).unwrap();
        let j_none = serde_json::to_value(&with_none).unwrap();
        assert_eq!(j_empty["defaultValue"], "");
        // `skip_serializing_if` strips None so the key is absent — the
        // distinction is "key present with empty string" vs "no key".
        assert!(j_none.get("defaultValue").is_none());
    }

    /// Legacy clients that predate the variables feature don't include
    /// `variables` in their payloads. `#[serde(default)]` keeps them
    /// parsing cleanly; the resulting Vec is empty.
    #[test]
    fn record_deserializes_when_variables_is_absent() {
        let json = serde_json::json!({
            "id": "abc",
            "name": "n",
            "nameKey": null,
            "description": null,
            "descriptionKey": null,
            "icon": null,
            "script": "echo",
            "shell": null,
            "args": null,
            "workingDir": null,
            "env": null,
            "tags": [],
            "categoryId": null,
            "favorite": false,
            "createdAt": "2026-05-28T00:00:00Z",
            "updatedAt": "2026-05-28T00:00:00Z",
            "lastRunAt": null,
            "runCount": 0,
            "runAsAdmin": false
        });
        let rec: CommandRecord = serde_json::from_value(json).unwrap();
        assert!(rec.variables.is_empty());
        assert!(rec.timeout_seconds.is_none());
    }
}

#[cfg(test)]
mod sqlite_integration_tests {
    use super::*;
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

    fn fixture(id: &str, favorite: bool) -> CommandRecord {
        CommandRecord {
            id: id.into(),
            name: format!("name-{id}"),
            name_key: None,
            description: None,
            description_key: None,
            icon: None,
            script: "echo hi".into(),
            shell: Some("bash".into()),
            args: Some(vec!["a".into(), "b".into()]),
            working_dir: None,
            env: None,
            tags: vec!["x".into()],
            category_id: None,
            favorite,
            created_at: format!("2026-05-28T00:00:0{}", id.len() % 10),
            updated_at: "2026-05-28T00:00:00Z".into(),
            last_run_at: None,
            run_count: 0,
            run_as_admin: false,
            variables: Vec::new(),
            timeout_seconds: None,
            output_schema: None,
            // `upsert` normalises an absent scope to `"global"` (and the column
            // has a `'global'` DEFAULT), so a round-tripped global command
            // always reads back `Some("global")`. The fixture reflects that
            // persisted reality so the `upsert → list` equality holds.
            scope: Some("global".into()),
            workflow_id: None,
            target: None,
            // Round-trips: `None`/`false` survive upsert → list unchanged
            // (empty slug normalises to NULL, default disabled).
            api_slug: None,
            api_enabled: false,
            explorer_enabled: true,
            explorer_path_variable: Some("target".into()),
        }
    }

    #[tokio::test]
    async fn upsert_then_list_returns_inserted_record() {
        let pool = make_pool().await;
        let rec = fixture("one", true);
        upsert(&pool, &rec).await.unwrap();
        let listed = list_all(&pool).await.unwrap();
        assert_eq!(listed, vec![rec]);
    }

    /// H-1: a `sensitive` variable's default value must NOT be persisted to the
    /// `commands` table — `upsert` strips it so a plaintext secret never lands
    /// in the `variables` column. The non-secret spec fields survive, and a
    /// non-sensitive variable's default is untouched.
    #[tokio::test]
    async fn upsert_strips_sensitive_variable_default_before_persisting() {
        let pool = make_pool().await;
        let mut rec = fixture("secret-cmd", false);
        rec.variables = vec![
            VariableSpec {
                name: "token".into(),
                default_value: Some("s3cr3t-default".into()),
                prompt_at_runtime: false,
                description: Some("API token".into()),
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
        upsert(&pool, &rec).await.unwrap();

        // Read the raw column so we assert against what is actually on disk.
        let raw: String = sqlx::query("SELECT variables FROM commands WHERE id = 'secret-cmd'")
            .fetch_one(pool.as_ref())
            .await
            .unwrap()
            .try_get("variables")
            .unwrap();
        assert!(
            !raw.contains("s3cr3t-default"),
            "the sensitive default must never be written to the commands table: {raw}"
        );

        let listed = list_all(&pool).await.unwrap();
        let vars = &listed[0].variables;
        let token = vars.iter().find(|v| v.name == "token").unwrap();
        assert_eq!(
            token.default_value, None,
            "sensitive default must be dropped"
        );
        assert!(token.sensitive, "sensitive flag must be preserved");
        assert_eq!(
            token.description.as_deref(),
            Some("API token"),
            "non-secret spec fields must survive"
        );
        let host = vars.iter().find(|v| v.name == "host").unwrap();
        assert_eq!(
            host.default_value.as_deref(),
            Some("example.com"),
            "a non-sensitive default must be untouched"
        );
    }

    #[tokio::test]
    async fn upsert_updates_existing_id() {
        let pool = make_pool().await;
        let mut rec = fixture("one", false);
        upsert(&pool, &rec).await.unwrap();
        rec.name = "renamed".into();
        rec.run_count = 5;
        rec.favorite = true;
        upsert(&pool, &rec).await.unwrap();
        let listed = list_all(&pool).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "renamed");
        assert_eq!(listed[0].run_count, 5);
        assert!(listed[0].favorite);
    }

    #[tokio::test]
    async fn delete_removes_record() {
        let pool = make_pool().await;
        let rec = fixture("one", false);
        upsert(&pool, &rec).await.unwrap();
        delete(&pool, "one").await.unwrap();
        let listed = list_all(&pool).await.unwrap();
        assert!(listed.is_empty());
    }

    #[tokio::test]
    async fn delete_missing_id_is_noop() {
        let pool = make_pool().await;
        delete(&pool, "does-not-exist").await.unwrap();
    }

    #[tokio::test]
    async fn count_all_reflects_inserts() {
        let pool = make_pool().await;
        assert_eq!(count_all(&pool).await.unwrap(), 0);
        upsert(&pool, &fixture("a", false)).await.unwrap();
        upsert(&pool, &fixture("b", false)).await.unwrap();
        assert_eq!(count_all(&pool).await.unwrap(), 2);
        // Re-upserting an existing id must NOT inflate the count (it's an
        // update) — this is what lets the quota gate treat edits as free.
        upsert(&pool, &fixture("a", true)).await.unwrap();
        assert_eq!(count_all(&pool).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn exists_distinguishes_new_from_existing_id() {
        let pool = make_pool().await;
        assert!(!exists(&pool, "a").await.unwrap());
        upsert(&pool, &fixture("a", false)).await.unwrap();
        assert!(exists(&pool, "a").await.unwrap());
        assert!(!exists(&pool, "b").await.unwrap());
    }

    /// `run_as_admin` round-trips through SQLite as expected. The
    /// integer column is materialised back to the bool with the
    /// `!= 0` predicate from `row_to_record`, so any encoding mistake
    /// (binding the wrong byte, reading the wrong column) is caught.
    #[tokio::test]
    async fn upsert_then_list_preserves_run_as_admin_true() {
        let pool = make_pool().await;
        let mut rec = fixture("admin-cmd", false);
        rec.run_as_admin = true;
        upsert(&pool, &rec).await.unwrap();
        let listed = list_all(&pool).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].run_as_admin);
    }

    /// Toggling `run_as_admin` from true→false via upsert must persist
    /// the new value (relies on `excluded.run_as_admin` being listed in
    /// the ON CONFLICT clause — easy to forget when adding new columns).
    #[tokio::test]
    async fn upsert_can_clear_run_as_admin() {
        let pool = make_pool().await;
        let mut rec = fixture("admin-cmd", false);
        rec.run_as_admin = true;
        upsert(&pool, &rec).await.unwrap();
        rec.run_as_admin = false;
        upsert(&pool, &rec).await.unwrap();
        let listed = list_all(&pool).await.unwrap();
        assert!(!listed[0].run_as_admin);
    }

    /// Variables round-trip through SQLite as JSON. Distinguishing
    /// `None` from `Some("")` matters for the prompt-on-no-default
    /// semantics — both must survive the column encode/decode unchanged.
    #[tokio::test]
    async fn upsert_then_list_preserves_variables() {
        let pool = make_pool().await;
        let mut rec = fixture("var-cmd", false);
        rec.variables = vec![
            VariableSpec {
                name: "alpha".into(),
                default_value: Some("default-alpha".into()),
                prompt_at_runtime: false,
                description: Some("first var".into()),
                sensitive: false,
            },
            VariableSpec {
                name: "beta".into(),
                default_value: None,
                prompt_at_runtime: false,
                description: None,
                sensitive: true,
            },
            VariableSpec {
                name: "gamma".into(),
                default_value: Some(String::new()),
                prompt_at_runtime: false,
                description: None,
                sensitive: false,
            },
        ];
        upsert(&pool, &rec).await.unwrap();
        let listed = list_all(&pool).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].variables, rec.variables);
    }

    /// Upserting `variables = []` must clear any previously stored
    /// values (verifies `variables = excluded.variables` is present in
    /// the ON CONFLICT clause).
    #[tokio::test]
    async fn upsert_can_clear_variables() {
        let pool = make_pool().await;
        let mut rec = fixture("var-cmd", false);
        rec.variables = vec![VariableSpec {
            name: "alpha".into(),
            default_value: None,
            prompt_at_runtime: false,
            description: None,
            sensitive: false,
        }];
        upsert(&pool, &rec).await.unwrap();
        rec.variables = Vec::new();
        upsert(&pool, &rec).await.unwrap();
        let listed = list_all(&pool).await.unwrap();
        assert!(listed[0].variables.is_empty());
    }

    /// An output schema must survive a full insert → list round-trip
    /// through the JSON-encoded `output_schema` column unchanged.
    #[tokio::test]
    async fn upsert_then_list_preserves_output_schema() {
        let pool = make_pool().await;
        let mut rec = fixture("schema-cmd", false);
        rec.output_schema = Some(OutputSchemaRecord {
            parser: "regex".into(),
            source: Some("stdout".into()),
            pattern: Some(r"(?P<ip>\d+\.\d+\.\d+\.\d+)".into()),
            delimiter: None,
            has_header: None,
            max_columns: None,
            fields: vec![OutputFieldRecord {
                name: "ip".into(),
                path: None,
                group: Some("ip".into()),
                column: None,
                index: None,
                description: Some("matched address".into()),
            }],
            pipeline: Vec::new(),
            return_field: Some("ip".into()),
            sample: Some("addr 10.0.0.1\n".into()),
        });
        upsert(&pool, &rec).await.unwrap();
        let listed = list_all(&pool).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].output_schema, rec.output_schema);
    }

    /// Upserting `output_schema = None` must clear a previously stored
    /// schema (verifies `output_schema = excluded.output_schema` is in
    /// the ON CONFLICT clause).
    #[tokio::test]
    async fn upsert_can_clear_output_schema() {
        let pool = make_pool().await;
        let mut rec = fixture("schema-cmd", false);
        rec.output_schema = Some(OutputSchemaRecord {
            parser: "lines".into(),
            source: None,
            pattern: None,
            delimiter: None,
            has_header: None,
            max_columns: None,
            fields: Vec::new(),
            pipeline: Vec::new(),
            return_field: None,
            sample: None,
        });
        upsert(&pool, &rec).await.unwrap();
        rec.output_schema = None;
        upsert(&pool, &rec).await.unwrap();
        let listed = list_all(&pool).await.unwrap();
        assert!(listed[0].output_schema.is_none());
    }

    /// A `local`-scoped command round-trips its `scope` + `workflow_id`
    /// through SQLite (verifies the new columns are bound on insert and read
    /// back in `row_to_record`).
    #[tokio::test]
    async fn upsert_then_list_preserves_local_scope() {
        let pool = make_pool().await;
        let mut rec = fixture("local-cmd", false);
        rec.scope = Some("local".into());
        rec.workflow_id = Some("wf-42".into());
        upsert(&pool, &rec).await.unwrap();
        let listed = list_all(&pool).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].scope.as_deref(), Some("local"));
        assert_eq!(listed[0].workflow_id.as_deref(), Some("wf-42"));
    }

    /// A command with no explicit scope is persisted (and read back) as
    /// `"global"` — the column DEFAULT plus the `upsert` normalisation.
    #[tokio::test]
    async fn upsert_defaults_absent_scope_to_global() {
        let pool = make_pool().await;
        let mut rec = fixture("no-scope-cmd", false);
        rec.scope = None;
        rec.workflow_id = None;
        upsert(&pool, &rec).await.unwrap();
        let listed = list_all(&pool).await.unwrap();
        assert_eq!(listed[0].scope.as_deref(), Some("global"));
        assert!(listed[0].workflow_id.is_none());
    }

    /// A remote target round-trips through SQLite: the `target` column is
    /// bound on insert (JSON-encoded) and decoded back in `row_to_record`.
    #[tokio::test]
    async fn upsert_then_list_preserves_remote_target() {
        let pool = make_pool().await;
        let mut rec = fixture("remote-cmd", false);
        rec.target = Some(ExecutionTarget::Remote {
            alias: "prod-web".into(),
        });
        upsert(&pool, &rec).await.unwrap();
        let listed = list_all(&pool).await.unwrap();
        assert_eq!(
            listed[0].target,
            Some(ExecutionTarget::Remote {
                alias: "prod-web".into()
            })
        );
    }

    /// A command with no target persists NULL and reads back as `None` (the
    /// executor interprets that as `Local`). Also verifies a target can be
    /// cleared by upserting `None` over an existing remote value.
    #[tokio::test]
    async fn upsert_can_clear_target_to_local() {
        let pool = make_pool().await;
        let mut rec = fixture("clear-target-cmd", false);
        rec.target = Some(ExecutionTarget::Remote {
            alias: "staging".into(),
        });
        upsert(&pool, &rec).await.unwrap();
        rec.target = None;
        upsert(&pool, &rec).await.unwrap();
        let listed = list_all(&pool).await.unwrap();
        assert!(listed[0].target.is_none());
    }

    /// Cascade-delete removes only the named workflow's `local` commands,
    /// leaving globals and other workflows' locals untouched.
    #[tokio::test]
    async fn delete_local_for_workflow_removes_only_owned_locals() {
        let pool = make_pool().await;

        let mut local_a = fixture("local-a", false);
        local_a.scope = Some("local".into());
        local_a.workflow_id = Some("wf-1".into());
        let mut local_b = fixture("local-b", false);
        local_b.scope = Some("local".into());
        local_b.workflow_id = Some("wf-2".into());
        let global = fixture("global-c", false);

        upsert(&pool, &local_a).await.unwrap();
        upsert(&pool, &local_b).await.unwrap();
        upsert(&pool, &global).await.unwrap();

        delete_local_for_workflow(&pool, "wf-1").await.unwrap();

        let listed = list_all(&pool).await.unwrap();
        let ids: std::collections::HashSet<&str> = listed.iter().map(|c| c.id.as_str()).collect();
        assert!(!ids.contains("local-a"), "owned local must be deleted");
        assert!(
            ids.contains("local-b"),
            "other workflow's local must remain"
        );
        assert!(ids.contains("global-c"), "global command must remain");

        // Idempotent: a workflow with no locals is a no-op.
        delete_local_for_workflow(&pool, "wf-unknown")
            .await
            .unwrap();
        assert_eq!(list_all(&pool).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn find_by_id_returns_inserted_record() {
        let pool = make_pool().await;
        let rec = fixture("target", true);
        upsert(&pool, &rec).await.unwrap();

        let found = find_by_id(&pool, "target").await.unwrap();
        assert_eq!(found, Some(rec));
    }

    #[tokio::test]
    async fn find_by_id_returns_none_for_missing_id() {
        let pool = make_pool().await;
        // Another command exists, but not the one we ask for.
        upsert(&pool, &fixture("present", false)).await.unwrap();

        let found = find_by_id(&pool, "does-not-exist").await.unwrap();
        assert!(found.is_none());
    }
}
