// CRUD operations for the `workflows` table.
//
// The wire-format struct `WorkflowRecord` mirrors the TypeScript `Workflow`
// type (see `src/types/workflow.ts`) and crosses the Tauri IPC boundary via
// `list_workflows`, `upsert_workflow`, and `delete_workflow` (registered in
// Phase 2). All field names are serialised in camelCase to match the JS-side
// shape; the regression tests at the bottom of this file enforce that
// contract. The graph (`nodes`, `edges`) and `tags` are persisted as
// JSON-encoded TEXT columns and decoded on read — exactly the pattern used
// by `storage::commands` for its `args_json` / `tags_json` columns.

use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::storage::DbPool;

/// Canvas coordinates for a node, owned by the visual editor. The runner
/// never reads these — they only round-trip so the editor can restore the
/// layout. Mirrors the TS `WorkflowNode.position`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodePosition {
    pub x: f64,
    pub y: f64,
}

/// A single node in the workflow graph. `kind` is the discriminator
/// (`start` / `command` / `condition` / `end`); `command_id` is present
/// only for `command` nodes. Stored inside the `nodes` JSON column.
///
/// `kind` is intentionally a plain `String` rather than a Rust enum: the
/// storage layer only round-trips the value, and keeping it a string
/// avoids a serde rename surface that would have to stay in lock-step with
/// the TS `WorkflowNodeKind` union. The execution engine (Phase 2) owns the
/// typed interpretation.
/// One case of a `switch` node: a predicate plus the id used to label its
/// outgoing edge (`case:<id>`). Evaluated in vector order; the first match
/// wins, else the `default` edge is taken. Mirrors the TS
/// `WorkflowNode.cases[]` element.
///
/// The predicate type is the pure `Condition` from `core::workflow_condition`
/// (a serde-only DTO). This is a `storage → core` reference for the data
/// shape ONLY; `core::workflow_condition` imports nothing from storage, so the
/// dependency is acyclic.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SwitchCaseRecord {
    pub id: String,
    pub condition: crate::core::workflow_condition::Condition,
}

/// Bounded-iteration config for a `loop` node. Exactly one of `count` /
/// `while_condition` drives normal termination; `max_iterations` is the hard
/// safety cap the runner enforces regardless (mirrors the engine's
/// `WorkflowError::LoopLimit`). Mirrors the TS `LoopConfig`.
///
/// `while` is a Rust keyword, so the field is `while_condition` here and is
/// renamed to the wire/`TS` name `while` via serde.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoopConfigRecord {
    /// Fixed iteration count. Mutually exclusive with `while_condition`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
    /// Repeat while this predicate holds. Mutually exclusive with `count`.
    #[serde(rename = "while", default, skip_serializing_if = "Option::is_none")]
    pub while_condition: Option<crate::core::workflow_condition::Condition>,
    /// Hard upper bound on iterations; the runner aborts past this with
    /// `LoopLimit`.
    pub max_iterations: u32,
}

/// Retry config for a `try` (or retrying `command`) node. `retries` is the
/// number of ADDITIONAL attempts after the first; `backoff_ms` is the pause
/// between attempts. Mirrors the TS `RetryConfig`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RetryConfigRecord {
    /// Additional attempts after the first. `0` means run once (no retry).
    pub retries: u32,
    /// Pause between attempts, in milliseconds. `None`/0 = retry immediately.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backoff_ms: Option<u64>,
}

/// Where a `data` node assignment pulls its value from. Tagged union mirroring
/// the TS `DataSource` (`{ kind, … }`). Every non-`Manual` source reads from
/// the node executed immediately before this data node on the path that
/// reached it (the runner tracks that "previous outcome").
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum DataSourceRecord {
    /// A literal / `${ref}`-templated string the user typed.
    Manual { value: String },
    /// The previous node's raw stdout (bounded tail).
    RawOutput,
    /// The previous node's FULL extracted output-schema result as one value
    /// (compact JSON of all fields). Only meaningful when the prev command
    /// has a schema; empty otherwise.
    SchemaOutput,
    /// The previous node's process exit code.
    ExitCode,
    /// A single named output-schema field the previous node extracted.
    Field { field: String },
    /// Attempts a `try` predecessor made (1 = succeeded first try).
    RetryCount,
    /// "true" / "false": did a `condition` predecessor's test pass.
    ConditionResult,
    /// The case id a `switch` predecessor took ("default" when none matched).
    MatchedCase,
    /// Completed iterations of a `loop` predecessor (count).
    LoopIterations,
    /// Prompt the user for this value when the workflow runs (the value is
    /// supplied through `node_variable_values`, exactly like a no-default
    /// command variable). Meaningful only as a per-variable source on a
    /// command-bearing node; on a `data` assignment it resolves to empty.
    AtRun,
    /// A data-flow variable produced by an upstream `data` node, looked up by
    /// `name` in the live data-flow map (NOT the previous node's extracted
    /// fields). Lets a node's command variable read a `data`-node value.
    DataVar { name: String },
}

/// One assignment performed by a `data` node: set the data-flow variable
/// `name` to a value pulled from `source`. Mirrors the TS `DataAssignment`.
///
/// `value` is RETAINED for backward compatibility: pre-`source` records (and
/// the `Manual` source) carry the literal here. `source` defaults to
/// `Manual { value }` when absent (old records), so existing data nodes keep
/// working unchanged.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DataAssignmentRecord {
    pub name: String,
    #[serde(default)]
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<DataSourceRecord>,
}

impl DataAssignmentRecord {
    /// The effective source: explicit `source` when set, else a `Manual`
    /// source wrapping the legacy `value` (so pre-`source` records behave
    /// exactly as before).
    pub fn effective_source(&self) -> DataSourceRecord {
        self.source
            .clone()
            .unwrap_or_else(|| DataSourceRecord::Manual {
                value: self.value.clone(),
            })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNodeRecord {
    pub id: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Optional branch predicate for a `condition` node. `None` → fall back to
    /// exit-code branching (MVP behaviour). Wired in §6; carried here now so
    /// the node record round-trips it. Mirrors the TS `WorkflowNode.condition`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition: Option<crate::core::workflow_condition::Condition>,
    /// Per-case predicates for a `switch` node, evaluated in order. Empty /
    /// absent for every other kind. Mirrors the TS `WorkflowNode.cases`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cases: Vec<SwitchCaseRecord>,
    /// Iteration config for a `loop` node. `None` for every other kind.
    /// Mirrors the TS `WorkflowNode.loop`.
    #[serde(rename = "loop", default, skip_serializing_if = "Option::is_none")]
    pub loop_config: Option<LoopConfigRecord>,
    /// Retry config for a `try` node. `None` for every other kind.
    /// Mirrors the TS `WorkflowNode.retry`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<RetryConfigRecord>,
    /// Variable assignments performed by a `data` node, in order. Empty /
    /// absent for every other kind. Mirrors the TS `WorkflowNode.data`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub data: Vec<DataAssignmentRecord>,
    /// Where each of the referenced command's variables draws its value, keyed
    /// by variable name. Empty / absent for nodes without overrides. Mirrors
    /// the TS `WorkflowNode.variableSources`.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub variable_sources: std::collections::BTreeMap<String, DataSourceRecord>,
    /// Output-schema pipeline a `parser` node applies to the previous node's
    /// raw output. `None` for every other kind. Mirrors the TS
    /// `WorkflowNode.parser`. Reuses the command `OutputSchemaRecord` so the
    /// same `core::extractor` runs for both command output parsing and a
    /// standalone parser node.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parser: Option<crate::storage::commands::OutputSchemaRecord>,
    /// The template text a `text` node composes: `${var}` references are
    /// expanded against the run's variables and the result becomes the node's
    /// output. `None` for every other kind. Mirrors the TS `WorkflowNode.text`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Optional explicit join barrier for a `parallel` (fork) node: the id of
    /// the `join` node where all of this fork's branches synchronise. `None`
    /// for every other kind, and also for a `parallel` whose branches each end
    /// at their own `end` (no barrier). Mirrors the TS `WorkflowNode.joinNodeId`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub join_node_id: Option<String>,
    pub position: NodePosition,
}

/// A directed edge in the workflow graph. `branch` disambiguates the two
/// exits of a `condition` node (`then` / `else`) from the single `out`
/// exit of start / command nodes. Stored inside the `edges` JSON column.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEdgeRecord {
    pub id: String,
    pub source: String,
    pub target: String,
    pub branch: String,
}

/// Materialised representation of a single workflow as stored in SQLite
/// and exchanged over IPC. The graph (`nodes`, `edges`) and `tags` are
/// persisted as JSON-encoded TEXT columns (`nodes_json`, `edges_json`,
/// `tags_json`) and decoded on read.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRecord {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    #[serde(default)]
    pub nodes: Vec<WorkflowNodeRecord>,
    #[serde(default)]
    pub edges: Vec<WorkflowEdgeRecord>,
    pub tags: Vec<String>,
    pub category_id: Option<String>,
    pub favorite: bool,
    pub created_at: String,
    pub updated_at: String,
    pub last_run_at: Option<String>,
    pub run_count: i64,
}

/// Return every workflow in insertion order (oldest first).
pub async fn list_all(pool: &DbPool) -> Result<Vec<WorkflowRecord>, String> {
    let rows = sqlx::query(
        "SELECT id, name, description, icon, nodes_json, edges_json, tags_json, \
                category_id, favorite, created_at, updated_at, last_run_at, run_count \
         FROM workflows \
         ORDER BY created_at ASC",
    )
    .fetch_all(pool.as_ref())
    .await
    .map_err(|e| format!("list_all: {e}"))?;

    rows.into_iter().map(row_to_record).collect()
}

/// Count the rows in the `workflows` table. Used by the license quota gate
/// to decide whether a Basic-tier user may create another workflow.
pub async fn count_all(pool: &DbPool) -> Result<i64, String> {
    let row = sqlx::query("SELECT COUNT(*) AS n FROM workflows")
        .fetch_one(pool.as_ref())
        .await
        .map_err(|e| format!("count_all: {e}"))?;
    row.try_get::<i64, _>("n")
        .map_err(|e| format!("count_all read: {e}"))
}

/// Whether a workflow with `id` already exists. The quota gate uses this to
/// distinguish a NEW insert (counts against the Basic limit) from an update
/// to an existing workflow (always allowed).
pub async fn exists(pool: &DbPool, id: &str) -> Result<bool, String> {
    let row = sqlx::query("SELECT 1 FROM workflows WHERE id = ? LIMIT 1")
        .bind(id)
        .fetch_optional(pool.as_ref())
        .await
        .map_err(|e| format!("exists: {e}"))?;
    Ok(row.is_some())
}

/// Insert a new workflow or update an existing one (matched by `id`).
pub async fn upsert(pool: &DbPool, wf: &WorkflowRecord) -> Result<(), String> {
    let nodes_json = serde_json::to_string(&wf.nodes).map_err(|e| format!("encode nodes: {e}"))?;
    let edges_json = serde_json::to_string(&wf.edges).map_err(|e| format!("encode edges: {e}"))?;
    let tags_json = serde_json::to_string(&wf.tags).map_err(|e| format!("encode tags: {e}"))?;

    sqlx::query(
        "INSERT INTO workflows ( \
            id, name, description, icon, nodes_json, edges_json, tags_json, \
            category_id, favorite, created_at, updated_at, last_run_at, run_count \
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET \
            name = excluded.name, \
            description = excluded.description, \
            icon = excluded.icon, \
            nodes_json = excluded.nodes_json, \
            edges_json = excluded.edges_json, \
            tags_json = excluded.tags_json, \
            category_id = excluded.category_id, \
            favorite = excluded.favorite, \
            updated_at = excluded.updated_at, \
            last_run_at = excluded.last_run_at, \
            run_count = excluded.run_count",
    )
    .bind(&wf.id)
    .bind(&wf.name)
    .bind(&wf.description)
    .bind(&wf.icon)
    .bind(&nodes_json)
    .bind(&edges_json)
    .bind(&tags_json)
    .bind(&wf.category_id)
    .bind(if wf.favorite { 1_i64 } else { 0_i64 })
    .bind(&wf.created_at)
    .bind(&wf.updated_at)
    .bind(&wf.last_run_at)
    .bind(wf.run_count)
    .execute(pool.as_ref())
    .await
    .map_err(|e| format!("upsert: {e}"))?;

    Ok(())
}

/// Remove the workflow with the given id. A missing id is not an error
/// (matches the `commands::delete` idempotent semantics).
pub async fn delete(pool: &DbPool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM workflows WHERE id = ?")
        .bind(id)
        .execute(pool.as_ref())
        .await
        .map_err(|e| format!("delete: {e}"))?;
    Ok(())
}

fn row_to_record(row: sqlx::sqlite::SqliteRow) -> Result<WorkflowRecord, String> {
    let nodes_json: String = row
        .try_get("nodes_json")
        .map_err(|e| format!("read nodes_json: {e}"))?;
    let edges_json: String = row
        .try_get("edges_json")
        .map_err(|e| format!("read edges_json: {e}"))?;
    let tags_json: String = row
        .try_get("tags_json")
        .map_err(|e| format!("read tags_json: {e}"))?;
    let favorite_i: i64 = row
        .try_get("favorite")
        .map_err(|e| format!("read favorite: {e}"))?;

    let nodes = serde_json::from_str::<Vec<WorkflowNodeRecord>>(&nodes_json)
        .map_err(|e| format!("decode nodes_json: {e}"))?;
    let edges = serde_json::from_str::<Vec<WorkflowEdgeRecord>>(&edges_json)
        .map_err(|e| format!("decode edges_json: {e}"))?;
    let tags = serde_json::from_str::<Vec<String>>(&tags_json)
        .map_err(|e| format!("decode tags_json: {e}"))?;

    Ok(WorkflowRecord {
        id: row.try_get("id").map_err(|e| format!("read id: {e}"))?,
        name: row.try_get("name").map_err(|e| format!("read name: {e}"))?,
        description: row
            .try_get("description")
            .map_err(|e| format!("read description: {e}"))?,
        icon: row.try_get("icon").map_err(|e| format!("read icon: {e}"))?,
        nodes,
        edges,
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
    })
}

#[cfg(test)]
mod wire_format_tests {
    use super::*;

    fn sample() -> WorkflowRecord {
        WorkflowRecord {
            id: "wf-1".into(),
            name: "Deploy".into(),
            description: Some("Build then deploy".into()),
            icon: Some("rocket".into()),
            nodes: vec![
                WorkflowNodeRecord {
                    id: "n-start".into(),
                    kind: "start".into(),
                    command_id: None,
                    label: None,
                    condition: None,
                    cases: Vec::new(),
                    loop_config: None,
                    retry: None,
                    data: Vec::new(),
                    variable_sources: std::collections::BTreeMap::new(),
                    parser: None,
                    text: None,
                    join_node_id: None,
                    position: NodePosition { x: 0.0, y: 0.0 },
                },
                WorkflowNodeRecord {
                    id: "n-build".into(),
                    kind: "command".into(),
                    command_id: Some("cmd-build".into()),
                    label: Some("Build".into()),
                    condition: None,
                    cases: Vec::new(),
                    loop_config: None,
                    retry: None,
                    data: Vec::new(),
                    variable_sources: std::collections::BTreeMap::new(),
                    parser: None,
                    text: None,
                    join_node_id: None,
                    position: NodePosition { x: 120.0, y: 40.0 },
                },
            ],
            edges: vec![WorkflowEdgeRecord {
                id: "e1".into(),
                source: "n-start".into(),
                target: "n-build".into(),
                branch: "out".into(),
            }],
            tags: vec!["ci".into()],
            category_id: Some("c1".into()),
            favorite: true,
            created_at: "2026-05-28T00:00:00Z".into(),
            updated_at: "2026-05-28T00:00:01Z".into(),
            last_run_at: Some("2026-05-28T00:00:02Z".into()),
            run_count: 3,
        }
    }

    #[test]
    fn record_serializes_camelcase() {
        let rec = sample();
        let json = serde_json::to_value(&rec).unwrap();
        // Positive: every camelCase key is present.
        assert!(json.get("id").is_some());
        assert!(json.get("name").is_some());
        assert!(json.get("description").is_some());
        assert!(json.get("icon").is_some());
        assert!(json.get("nodes").is_some());
        assert!(json.get("edges").is_some());
        assert!(json.get("tags").is_some());
        assert!(json.get("categoryId").is_some());
        assert!(json.get("favorite").is_some());
        assert!(json.get("createdAt").is_some());
        assert!(json.get("updatedAt").is_some());
        assert!(json.get("lastRunAt").is_some());
        assert!(json.get("runCount").is_some());

        // Negative: snake_case must NOT leak through.
        assert!(json.get("category_id").is_none());
        assert!(json.get("created_at").is_none());
        assert!(json.get("updated_at").is_none());
        assert!(json.get("last_run_at").is_none());
        assert!(json.get("run_count").is_none());
        assert!(json.get("nodes_json").is_none());
        assert!(json.get("edges_json").is_none());
    }

    /// Node sub-records use camelCase (`commandId`) and omit `commandId`
    /// / `label` when `None` (via `skip_serializing_if`). snake_case must
    /// never leak.
    #[test]
    fn node_record_wire_format_is_camelcase() {
        let node = WorkflowNodeRecord {
            id: "n1".into(),
            kind: "command".into(),
            command_id: Some("cmd-9".into()),
            label: Some("Run".into()),
            condition: None,
            cases: Vec::new(),
            loop_config: None,
            retry: None,
            data: Vec::new(),
            variable_sources: std::collections::BTreeMap::new(),
            parser: None,
            text: None,
            join_node_id: None,
            position: NodePosition { x: 1.0, y: 2.0 },
        };
        let json = serde_json::to_value(&node).unwrap();
        assert_eq!(json["id"], "n1");
        assert_eq!(json["kind"], "command");
        assert_eq!(json["commandId"], "cmd-9");
        assert_eq!(json["label"], "Run");
        assert_eq!(json["position"]["x"], 1.0);
        assert!(json.get("command_id").is_none());
    }

    #[test]
    fn node_record_omits_absent_optionals() {
        let node = WorkflowNodeRecord {
            id: "n-start".into(),
            kind: "start".into(),
            command_id: None,
            label: None,
            condition: None,
            cases: Vec::new(),
            loop_config: None,
            retry: None,
            data: Vec::new(),
            variable_sources: std::collections::BTreeMap::new(),
            parser: None,
            text: None,
            join_node_id: None,
            position: NodePosition { x: 0.0, y: 0.0 },
        };
        let json = serde_json::to_value(&node).unwrap();
        assert!(json.get("commandId").is_none());
        assert!(json.get("label").is_none());
        // The advanced-node optionals are also omitted when empty/None.
        assert!(json.get("condition").is_none());
        assert!(json.get("cases").is_none());
        assert!(json.get("loop").is_none());
        assert!(json.get("variableSources").is_none());
        assert!(json.get("joinNodeId").is_none());
    }

    /// A `parallel` node's optional `joinNodeId` serialises as camelCase and is
    /// omitted when `None` (every non-`parallel` kind), present when `Some`.
    #[test]
    fn node_record_join_node_id_wire_format_and_round_trip() {
        let mut node = WorkflowNodeRecord {
            id: "n-fork".into(),
            kind: "parallel".into(),
            command_id: None,
            label: None,
            condition: None,
            cases: Vec::new(),
            loop_config: None,
            retry: None,
            data: Vec::new(),
            variable_sources: std::collections::BTreeMap::new(),
            parser: None,
            text: None,
            join_node_id: None,
            position: NodePosition { x: 0.0, y: 0.0 },
        };

        // None → the field is omitted entirely.
        let json = serde_json::to_value(&node).unwrap();
        assert!(json.get("joinNodeId").is_none());
        assert!(json.get("join_node_id").is_none());

        // Some → camelCase `joinNodeId`, and the record round-trips unchanged.
        node.join_node_id = Some("n-join".into());
        let json = serde_json::to_value(&node).unwrap();
        assert_eq!(json["joinNodeId"], "n-join");
        assert!(json.get("join_node_id").is_none());
        let back: WorkflowNodeRecord = serde_json::from_value(json).unwrap();
        assert_eq!(back, node);
    }

    /// A `loop` config serialises with the field renamed to the wire/TS name
    /// `while` (not `whileCondition`) and round-trips back unchanged. A rename
    /// regression here would silently break loaded loops.
    #[test]
    fn loop_config_uses_while_wire_name_and_round_trips() {
        let cfg = LoopConfigRecord {
            count: None,
            while_condition: Some(crate::core::workflow_condition::Condition {
                subject: crate::core::workflow_condition::Subject::ExitCode,
                op: crate::core::workflow_condition::Op::Eq,
                value: "0".into(),
            }),
            max_iterations: 50,
        };
        let json = serde_json::to_value(&cfg).unwrap();
        assert!(
            json.get("while").is_some(),
            "must use the `while` wire name"
        );
        assert!(json.get("whileCondition").is_none());
        assert_eq!(json["maxIterations"], 50);
        assert!(json.get("count").is_none(), "absent count is omitted");

        let back: LoopConfigRecord = serde_json::from_value(json).unwrap();
        assert_eq!(back, cfg);
    }

    /// A `retry` config uses camelCase (`backoffMs`), omits an absent backoff,
    /// and round-trips unchanged.
    #[test]
    fn retry_config_wire_format_is_camelcase_and_round_trips() {
        let cfg = RetryConfigRecord {
            retries: 3,
            backoff_ms: Some(250),
        };
        let json = serde_json::to_value(&cfg).unwrap();
        assert_eq!(json["retries"], 3);
        assert_eq!(json["backoffMs"], 250);
        assert!(json.get("backoff_ms").is_none());
        let back: RetryConfigRecord = serde_json::from_value(json).unwrap();
        assert_eq!(back, cfg);

        // An absent backoff is omitted entirely.
        let no_backoff = RetryConfigRecord {
            retries: 1,
            backoff_ms: None,
        };
        let json = serde_json::to_value(&no_backoff).unwrap();
        assert!(json.get("backoffMs").is_none());
    }

    #[test]
    fn edge_record_wire_format_is_camelcase() {
        let edge = WorkflowEdgeRecord {
            id: "e1".into(),
            source: "a".into(),
            target: "b".into(),
            branch: "then".into(),
        };
        let json = serde_json::to_value(&edge).unwrap();
        assert_eq!(json["source"], "a");
        assert_eq!(json["target"], "b");
        assert_eq!(json["branch"], "then");
    }

    #[test]
    fn record_roundtrips_through_json() {
        let rec = sample();
        let json = serde_json::to_string(&rec).unwrap();
        let back: WorkflowRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(rec, back);
    }

    /// Legacy / minimal payloads that omit `nodes` or `edges` must
    /// deserialize cleanly with empty Vecs (via `#[serde(default)]`),
    /// matching the lenient contract used by `CommandRecord` for new
    /// list fields.
    #[test]
    fn record_deserializes_when_graph_is_absent() {
        let json = serde_json::json!({
            "id": "wf-1",
            "name": "n",
            "description": null,
            "icon": null,
            "tags": [],
            "categoryId": null,
            "favorite": false,
            "createdAt": "2026-05-28T00:00:00Z",
            "updatedAt": "2026-05-28T00:00:00Z",
            "lastRunAt": null,
            "runCount": 0
        });
        let rec: WorkflowRecord = serde_json::from_value(json).unwrap();
        assert!(rec.nodes.is_empty());
        assert!(rec.edges.is_empty());
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

    fn fixture(id: &str, favorite: bool) -> WorkflowRecord {
        WorkflowRecord {
            id: id.into(),
            name: format!("name-{id}"),
            description: None,
            icon: None,
            nodes: vec![
                WorkflowNodeRecord {
                    id: "n-start".into(),
                    kind: "start".into(),
                    command_id: None,
                    label: None,
                    condition: None,
                    cases: Vec::new(),
                    loop_config: None,
                    retry: None,
                    data: Vec::new(),
                    variable_sources: std::collections::BTreeMap::new(),
                    parser: None,
                    text: None,
                    join_node_id: None,
                    position: NodePosition { x: 0.0, y: 0.0 },
                },
                WorkflowNodeRecord {
                    id: "n-cmd".into(),
                    kind: "command".into(),
                    command_id: Some("cmd-1".into()),
                    label: Some("Run".into()),
                    condition: None,
                    cases: Vec::new(),
                    loop_config: None,
                    retry: None,
                    data: Vec::new(),
                    variable_sources: std::collections::BTreeMap::new(),
                    parser: None,
                    text: None,
                    join_node_id: None,
                    position: NodePosition { x: 100.0, y: 0.0 },
                },
            ],
            edges: vec![WorkflowEdgeRecord {
                id: "e1".into(),
                source: "n-start".into(),
                target: "n-cmd".into(),
                branch: "out".into(),
            }],
            tags: vec!["x".into()],
            category_id: None,
            favorite,
            created_at: format!("2026-05-28T00:00:0{}", id.len() % 10),
            updated_at: "2026-05-28T00:00:00Z".into(),
            last_run_at: None,
            run_count: 0,
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
        assert_eq!(count_all(&pool).await.unwrap(), 1);
        // Updating the existing workflow does not increase the count — this
        // is why the Basic single-workflow user can keep editing it.
        upsert(&pool, &fixture("a", true)).await.unwrap();
        assert_eq!(count_all(&pool).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn exists_distinguishes_new_from_existing_id() {
        let pool = make_pool().await;
        assert!(!exists(&pool, "a").await.unwrap());
        upsert(&pool, &fixture("a", false)).await.unwrap();
        assert!(exists(&pool, "a").await.unwrap());
        assert!(!exists(&pool, "b").await.unwrap());
    }

    /// The graph (nodes + edges) round-trips through the JSON columns
    /// unchanged. Any encode/decode mistake (wrong column, dropped
    /// field) surfaces here because the full record is compared.
    #[tokio::test]
    async fn upsert_then_list_preserves_graph() {
        let pool = make_pool().await;
        let rec = fixture("graph", false);
        upsert(&pool, &rec).await.unwrap();
        let listed = list_all(&pool).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].nodes, rec.nodes);
        assert_eq!(listed[0].edges, rec.edges);
    }

    /// Upserting an empty graph must clear any previously stored nodes /
    /// edges (verifies `nodes_json = excluded.nodes_json` etc. are in
    /// the ON CONFLICT clause).
    #[tokio::test]
    async fn upsert_can_clear_graph() {
        let pool = make_pool().await;
        let mut rec = fixture("graph", false);
        upsert(&pool, &rec).await.unwrap();
        rec.nodes = Vec::new();
        rec.edges = Vec::new();
        upsert(&pool, &rec).await.unwrap();
        let listed = list_all(&pool).await.unwrap();
        assert!(listed[0].nodes.is_empty());
        assert!(listed[0].edges.is_empty());
    }
}
