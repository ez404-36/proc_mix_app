//! Terminal layout presets ("макеты терминала") — types + SQLite persistence.
//!
//! A layout is a NAMED, user-initiated snapshot of the console's Terminal
//! mode: dock position/fullscreen + panel size, the region split tree
//! (`LayoutSnapshotNode` — the frontend `RegionNode` tree stripped of live
//! region/session ids), and the last typed command per saved window so
//! applying the layout can replay it.
//!
//! Persistence boundary (docs/interactive-terminal.md): live PTY sessions are
//! never persisted anywhere; THIS table stores only what the user explicitly
//! chose to save via the layout dialog, which keeps the "No persistence"
//! boundary intact while making the feature possible.

use sqlx::Row;

use crate::storage::DbPool;

/// One saved terminal window inside a snapshot: the tab's (optional) custom
/// title, the last command typed into it (`None` = nothing typed), the
/// directory it was observed in, and — when the window was inside an `ssh`
/// session at save time — the ssh connection command line. A
/// `remote_command` window replays ONLY the connection (the other fields
/// describe remote state we cannot restore). Mirrors the TS
/// `LayoutSnapshotTab`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSnapshotTab {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_command: Option<String>,
}

/// The region split tree of a snapshot. Mirrors the TS
/// `LayoutSnapshotNode` union: a `region` leaf (its tab list + which tab was
/// active) or a `row`/`column` container arranging children with fraction
/// sizes. Tagged by `"type"` on the wire, matching the frontend types.
///
/// NOTE (see docs/interactive-terminal.md, "`#[serde(rename_all)]` on the
/// enum does NOT rename struct-variant fields"): the container-level
/// `#[serde(tag = "type")]` only produces the `type` tag; each variant
/// carries its own `rename_all = "camelCase"` so `active_tab_index`
/// serialises as `activeTabIndex` (the TS shape) — plus an exact-JSON test
/// below guarding against regressing to snake_case.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type")]
pub enum LayoutSnapshotNode {
    #[serde(rename = "region", rename_all = "camelCase")]
    Region {
        tabs: Vec<LayoutSnapshotTab>,
        active_tab_index: usize,
    },
    #[serde(rename = "row", rename_all = "camelCase")]
    Row {
        children: Vec<LayoutSnapshotNode>,
        sizes: Vec<f64>,
    },
    #[serde(rename = "column", rename_all = "camelCase")]
    Column {
        children: Vec<LayoutSnapshotNode>,
        sizes: Vec<f64>,
    },
}

impl LayoutSnapshotNode {
    /// Total node count (guard against pathological/deep trees on save).
    pub fn node_count(&self) -> usize {
        match self {
            LayoutSnapshotNode::Region { .. } => 1,
            LayoutSnapshotNode::Row { children, .. }
            | LayoutSnapshotNode::Column { children, .. } => {
                1 + children
                    .iter()
                    .map(LayoutSnapshotNode::node_count)
                    .sum::<usize>()
            }
        }
    }

    /// Total saved windows (tabs) across every region leaf.
    pub fn tab_count(&self) -> usize {
        match self {
            LayoutSnapshotNode::Region { tabs, .. } => tabs.len(),
            LayoutSnapshotNode::Row { children, .. }
            | LayoutSnapshotNode::Column { children, .. } => {
                children.iter().map(LayoutSnapshotNode::tab_count).sum()
            }
        }
    }
}

/// Saved panel size: `height` for the bottom dock, `width` for a side dock.
/// Mirrors the TS `LayoutSize`; either slot may be absent (unknown size).
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutSize {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
}

/// One terminal layout row (`terminal_layouts` table). Mirrors the TS
/// `TerminalLayoutDto`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalLayoutRecord {
    pub id: String,
    pub name: String,
    /// Console dock position: 'bottom' | 'left' | 'right'.
    pub position: String,
    pub fullscreen: bool,
    pub size: LayoutSize,
    pub layout: LayoutSnapshotNode,
    pub created_at: String,
    pub updated_at: String,
}

/// Upper bound on tree complexity accepted by `validate_snapshot` — a plain
/// sanity guard, far above anything the UI can produce (each region holds at
/// most `MAX_TERMINAL_SESSIONS` tabs).
const MAX_SNAPSHOT_NODES: usize = 256;

/// Sanity-check a snapshot received over IPC before it reaches SQLite.
/// Returns a short error string for the frontend toast; `Ok(())` when the
/// snapshot is structurally sound (sizes present per container, within the
/// node budget). Deep validation (fractions summing to 1, non-empty children)
/// is the frontend snapshot module's job — here we only refuse garbage.
pub fn validate_snapshot(layout: &LayoutSnapshotNode) -> Result<(), String> {
    if layout.node_count() > MAX_SNAPSHOT_NODES {
        return Err(format!(
            "terminal layout is too large ({MAX_SNAPSHOT_NODES} nodes max)"
        ));
    }
    match layout {
        LayoutSnapshotNode::Region { tabs, .. } => {
            if tabs.is_empty() {
                return Err("terminal layout region must hold at least one tab".into());
            }
            Ok(())
        }
        LayoutSnapshotNode::Row { children, sizes }
        | LayoutSnapshotNode::Column { children, sizes } => {
            if children.is_empty() {
                return Err("terminal layout container must have children".into());
            }
            if children.len() != sizes.len() {
                return Err("terminal layout container sizes/children mismatch".into());
            }
            for child in children {
                validate_snapshot(child)?;
            }
            Ok(())
        }
    }
}

// ---- CRUD -------------------------------------------------------------------

/// List every layout, name-ordered (case-insensitive) — the order the header
/// dropdown shows. Rows whose `layout_json` no longer decodes (corrupted /
/// hand-edited DB) are skipped with a warning instead of failing the list.
pub async fn list(pool: &DbPool) -> Result<Vec<TerminalLayoutRecord>, String> {
    let rows = sqlx::query(
        "SELECT id, name, position, fullscreen, size_json, layout_json, created_at, updated_at \
         FROM terminal_layouts ORDER BY name COLLATE NOCASE ASC",
    )
    .fetch_all(pool.as_ref())
    .await
    .map_err(|e| format!("list terminal_layouts: {e}"))?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let id: String = row.try_get("id").map_err(|e| format!("read id: {e}"))?;
        let record = decode_row(&row, &id);
        match record {
            Ok(record) => out.push(record),
            Err(e) => {
                tracing::warn!("skipping unreadable terminal layout {id}: {e}");
            }
        }
    }
    Ok(out)
}

/// Decode one row into a record. `id` is read by the caller (needed for the
/// warning message when the rest of the row fails to decode).
fn decode_row(row: &sqlx::sqlite::SqliteRow, id: &str) -> Result<TerminalLayoutRecord, String> {
    let read = |col: &str| -> Result<String, String> {
        row.try_get(col).map_err(|e| format!("read {col}: {e}"))
    };
    let name: String = read("name")?;
    let position: String = read("position")?;
    let fullscreen: i64 = row
        .try_get("fullscreen")
        .map_err(|e| format!("read fullscreen: {e}"))?;
    let size_json: String = read("size_json")?;
    let layout_json: String = read("layout_json")?;
    let created_at: String = read("created_at")?;
    let updated_at: String = read("updated_at")?;

    let size: LayoutSize =
        serde_json::from_str(&size_json).map_err(|e| format!("decode size_json: {e}"))?;
    let layout: LayoutSnapshotNode =
        serde_json::from_str(&layout_json).map_err(|e| format!("decode layout_json: {e}"))?;

    Ok(TerminalLayoutRecord {
        id: id.to_string(),
        name,
        position,
        fullscreen: fullscreen != 0,
        size,
        layout,
        created_at,
        updated_at,
    })
}

/// Find one layout by id.
pub async fn get(pool: &DbPool, id: &str) -> Result<Option<TerminalLayoutRecord>, String> {
    let row = sqlx::query(
        "SELECT id, name, position, fullscreen, size_json, layout_json, created_at, updated_at \
         FROM terminal_layouts WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(pool.as_ref())
    .await
    .map_err(|e| format!("find terminal_layout: {e}"))?;

    match row {
        None => Ok(None),
        Some(row) => decode_row(&row, id).map(Some),
    }
}

/// Find a layout by its (exact) name — used to reject duplicate save-as names
/// with a friendly error before hitting the UNIQUE constraint.
pub async fn find_by_name(
    pool: &DbPool,
    name: &str,
) -> Result<Option<TerminalLayoutRecord>, String> {
    let row = sqlx::query(
        "SELECT id, name, position, fullscreen, size_json, layout_json, created_at, updated_at \
         FROM terminal_layouts WHERE name = ?1",
    )
    .bind(name)
    .fetch_optional(pool.as_ref())
    .await
    .map_err(|e| format!("find terminal_layout by name: {e}"))?;

    match row {
        None => Ok(None),
        Some(row) => {
            let id: String = row.try_get("id").map_err(|e| format!("read id: {e}"))?;
            decode_row(&row, &id).map(Some)
        }
    }
}

/// Insert or overwrite a full record (id/created_at/updated_at supplied by the
/// caller — the command layer owns id generation and timestamps). A duplicate
/// NAME for a DIFFERENT id fails with the UNIQUE constraint error (the
/// command layer pre-checks and maps it to a friendly message).
pub async fn upsert(pool: &DbPool, rec: &TerminalLayoutRecord) -> Result<(), String> {
    let size_json =
        serde_json::to_string(&rec.size).map_err(|e| format!("encode size_json: {e}"))?;
    let layout_json =
        serde_json::to_string(&rec.layout).map_err(|e| format!("encode layout_json: {e}"))?;

    sqlx::query(
        "INSERT INTO terminal_layouts \
           (id, name, position, fullscreen, size_json, layout_json, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
         ON CONFLICT(id) DO UPDATE SET \
           name = excluded.name, \
           position = excluded.position, \
           fullscreen = excluded.fullscreen, \
           size_json = excluded.size_json, \
           layout_json = excluded.layout_json, \
           created_at = excluded.created_at, \
           updated_at = excluded.updated_at",
    )
    .bind(&rec.id)
    .bind(&rec.name)
    .bind(&rec.position)
    .bind(i64::from(rec.fullscreen))
    .bind(&size_json)
    .bind(&layout_json)
    .bind(&rec.created_at)
    .bind(&rec.updated_at)
    .execute(pool.as_ref())
    .await
    .map_err(|e| format!("save terminal_layout: {e}"))?;
    Ok(())
}

/// Rename a layout (keeps created_at, bumps updated_at — caller supplies the
/// timestamp). Errors when the id does not exist.
pub async fn rename(pool: &DbPool, id: &str, name: &str, updated_at: &str) -> Result<(), String> {
    let result =
        sqlx::query("UPDATE terminal_layouts SET name = ?2, updated_at = ?3 WHERE id = ?1")
            .bind(id)
            .bind(name)
            .bind(updated_at)
            .execute(pool.as_ref())
            .await
            .map_err(|e| format!("rename terminal_layout: {e}"))?;
    if result.rows_affected() == 0 {
        return Err(format!("terminal layout {id} not found"));
    }
    Ok(())
}

/// Delete a layout. Idempotent — a missing id is not an error.
pub async fn delete(pool: &DbPool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM terminal_layouts WHERE id = ?1")
        .bind(id)
        .execute(pool.as_ref())
        .await
        .map_err(|e| format!("delete terminal_layout: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn make_pool() -> DbPool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory db");
        sqlx::raw_sql(include_str!("schema.sql"))
            .execute(&pool)
            .await
            .expect("apply schema");
        std::sync::Arc::new(pool)
    }

    /// A two-region sample: a column of [region, region] — one local window
    /// with cwd + command, one ssh window with its connection command.
    fn sample_layout() -> LayoutSnapshotNode {
        LayoutSnapshotNode::Column {
            children: vec![
                LayoutSnapshotNode::Region {
                    tabs: vec![LayoutSnapshotTab {
                        title: Some("Terminal 1".into()),
                        last_command: Some("htop".into()),
                        cwd: Some("/var/log".into()),
                        remote_command: None,
                    }],
                    active_tab_index: 0,
                },
                LayoutSnapshotNode::Region {
                    tabs: vec![LayoutSnapshotTab {
                        title: None,
                        last_command: None,
                        cwd: None,
                        remote_command: Some("ssh -A deploy@prod".into()),
                    }],
                    active_tab_index: 0,
                },
            ],
            sizes: vec![0.7, 0.3],
        }
    }

    fn sample_record(id: &str, name: &str) -> TerminalLayoutRecord {
        TerminalLayoutRecord {
            id: id.into(),
            name: name.into(),
            position: "bottom".into(),
            fullscreen: false,
            size: LayoutSize {
                height: Some(420.0),
                width: None,
            },
            layout: sample_layout(),
            created_at: "2026-09-10T00:00:00+00:00".into(),
            updated_at: "2026-09-10T00:00:00+00:00".into(),
        }
    }

    #[test]
    fn snapshot_node_serialises_camel_case_with_type_tag() {
        // Exact-JSON assert (the interactive-terminal.md serde pitfall):
        // a snake_case `active_tab_index` here would silently break the
        // frontend types while every round-trip test keeps passing.
        let node = LayoutSnapshotNode::Region {
            tabs: vec![LayoutSnapshotTab {
                title: None,
                last_command: Some("ls -la".into()),
                cwd: Some("/tmp".into()),
                remote_command: Some("ssh host".into()),
            }],
            active_tab_index: 0,
        };
        let json = serde_json::to_string(&node).unwrap();
        assert_eq!(
            json,
            "{\"type\":\"region\",\"tabs\":[{\"lastCommand\":\"ls -la\",\
             \"cwd\":\"/tmp\",\"remoteCommand\":\"ssh host\"}],\"activeTabIndex\":0}"
        );
        let back: LayoutSnapshotNode = serde_json::from_str(&json).unwrap();
        assert_eq!(back, node);
    }

    /// Absent cwd / remoteCommand must be OMITTED from the JSON entirely so
    /// `layout_json` stays compact and pre-cwd rows keep decoding.
    #[test]
    fn snapshot_tab_omits_absent_cwd_and_remote_command() {
        let node = LayoutSnapshotNode::Region {
            tabs: vec![LayoutSnapshotTab {
                title: Some("T".into()),
                last_command: None,
                cwd: None,
                remote_command: None,
            }],
            active_tab_index: 0,
        };
        let json = serde_json::to_string(&node).unwrap();
        assert_eq!(
            json,
            "{\"type\":\"region\",\"tabs\":[{\"title\":\"T\"}],\"activeTabIndex\":0}"
        );
    }

    #[test]
    fn snapshot_node_counts_nodes_and_tabs() {
        let layout = sample_layout();
        assert_eq!(layout.node_count(), 3);
        assert_eq!(layout.tab_count(), 2);
    }

    #[test]
    fn validate_snapshot_rejects_empty_and_mismatched() {
        assert!(validate_snapshot(&sample_layout()).is_ok());

        let empty_region = LayoutSnapshotNode::Region {
            tabs: vec![],
            active_tab_index: 0,
        };
        assert!(validate_snapshot(&empty_region).is_err());

        let mismatch = LayoutSnapshotNode::Row {
            children: vec![sample_layout()],
            sizes: vec![],
        };
        assert!(validate_snapshot(&mismatch).is_err());

        let childless = LayoutSnapshotNode::Row {
            children: vec![],
            sizes: vec![],
        };
        assert!(validate_snapshot(&childless).is_err());
    }

    #[tokio::test]
    async fn upsert_insert_list_round_trips() {
        let pool = make_pool().await;
        let rec = sample_record("lay-1", "Monitoring");
        upsert(&pool, &rec).await.unwrap();

        let all = list(&pool).await.unwrap();
        assert_eq!(all, vec![rec.clone()]);

        let by_name = find_by_name(&pool, "monitoring").await.unwrap(); // exact match only — NOCASE affects ordering, not lookup
        assert!(by_name.is_none());
        let by_name = find_by_name(&pool, "Monitoring").await.unwrap();
        assert_eq!(by_name, Some(rec));
    }

    #[tokio::test]
    async fn upsert_overwrites_same_id() {
        let pool = make_pool().await;
        let mut rec = sample_record("lay-1", "Monitoring");
        upsert(&pool, &rec).await.unwrap();

        rec.name = "Monitoring v2".into();
        rec.updated_at = "2026-09-10T12:00:00+00:00".into();
        upsert(&pool, &rec).await.unwrap();

        let all = list(&pool).await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "Monitoring v2");
        assert_eq!(all[0].created_at, "2026-09-10T00:00:00+00:00");
    }

    #[tokio::test]
    async fn duplicate_name_fails_on_unique_constraint() {
        let pool = make_pool().await;
        upsert(&pool, &sample_record("lay-1", "Monitoring"))
            .await
            .unwrap();
        let err = upsert(&pool, &sample_record("lay-2", "Monitoring"))
            .await
            .unwrap_err();
        assert!(err.contains("UNIQUE"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn rename_updates_name_and_bumps_updated_at() {
        let pool = make_pool().await;
        upsert(&pool, &sample_record("lay-1", "Old name"))
            .await
            .unwrap();

        rename(&pool, "lay-1", "New name", "2026-09-10T13:00:00+00:00")
            .await
            .unwrap();
        let rec = get(&pool, "lay-1").await.unwrap().unwrap();
        assert_eq!(rec.name, "New name");
        assert_eq!(rec.updated_at, "2026-09-10T13:00:00+00:00");
        assert_eq!(rec.created_at, "2026-09-10T00:00:00+00:00");

        assert!(rename(&pool, "missing", "x", "now").await.is_err());
    }

    #[tokio::test]
    async fn delete_is_idempotent() {
        let pool = make_pool().await;
        upsert(&pool, &sample_record("lay-1", "Monitoring"))
            .await
            .unwrap();
        delete(&pool, "lay-1").await.unwrap();
        delete(&pool, "lay-1").await.unwrap(); // no-op, no error
        assert!(get(&pool, "lay-1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn list_skips_row_with_corrupt_layout_json() {
        let pool = make_pool().await;
        upsert(&pool, &sample_record("lay-1", "Good"))
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO terminal_layouts \
               (id, name, position, fullscreen, size_json, layout_json, created_at, updated_at) \
             VALUES ('lay-2', 'Bad', 'bottom', 0, '{}', 'not-json', 't', 't')",
        )
        .execute(pool.as_ref())
        .await
        .unwrap();

        let all = list(&pool).await.unwrap();
        assert_eq!(
            all.len(),
            1,
            "corrupt row must be skipped, not fail the list"
        );
        assert_eq!(all[0].name, "Good");
    }

    #[tokio::test]
    async fn list_orders_by_name_case_insensitive() {
        let pool = make_pool().await;
        upsert(&pool, &sample_record("lay-1", "beta"))
            .await
            .unwrap();
        upsert(&pool, &sample_record("lay-2", "Alpha"))
            .await
            .unwrap();
        upsert(&pool, &sample_record("lay-3", "gamma"))
            .await
            .unwrap();

        let names: Vec<String> = list(&pool)
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.name)
            .collect();
        assert_eq!(names, vec!["Alpha", "beta", "gamma"]);
    }
}
