// CRUD operations for the `miniapps` table.
//
// The wire-format struct `MiniAppRecord` mirrors the TypeScript `MiniApp`
// type (see `src/types/miniapp.ts`) and crosses the Tauri IPC boundary via
// `list_miniapps`, `get_miniapp`, `save_miniapp`, and `delete_miniapp`
// (registered in lib.rs). All field names are serialised in camelCase to
// match the JS-side shape; the regression tests at the bottom of this file
// enforce that contract. The `widgets` / `tags` / `os` columns are
// persisted as JSON-encoded TEXT columns and decoded on read — exactly the
// pattern used by `storage::workflows` for its `nodes_json` / `edges_json`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::storage::commands::VariableSpec;
use crate::storage::DbPool;

/// What a button / toggle runs, or what a status probe executes. A
/// `commandRef` reuses an existing global command from the library (exactly
/// like a workflow `command` node); an `inline` carries a self-contained
/// script so a mini-app can be autonomous. Mirrors the TS `MiniAppAction`
/// discriminated union (`kind`-tagged, camelCase on the wire).
///
/// NOTE: serde's container-level `renameAll` on an enum renames VARIANTS
/// only (`CommandRef` → `commandRef`); the fields of a struct variant need
/// their own per-variant `renameAll` to camelCase (`command_id` →
/// `commandId`). The wire-format tests at the bottom enforce this.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum MiniAppActionRecord {
    #[serde(rename_all = "camelCase")]
    CommandRef { command_id: String },
    #[serde(rename_all = "camelCase")]
    Inline {
        name: String,
        script: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shell: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        args: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        working_dir: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        env: Option<HashMap<String, String>>,
        #[serde(default)]
        run_as_admin: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        variables: Option<Vec<VariableSpec>>,
    },
}

/// Source a status / toggle-state probe runs. Same `kind`-tagged shape as
/// [`MiniAppActionRecord`], but the `inline` variant carries only the
/// fields a headless status probe needs (script + optional shell + optional
/// variables). Mirrors the TS `StatusSource` discriminated union.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum StatusSourceRecord {
    #[serde(rename_all = "camelCase")]
    CommandRef { command_id: String },
    #[serde(rename_all = "camelCase")]
    Inline {
        script: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shell: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        variables: Option<Vec<VariableSpec>>,
    },
}

/// Strategy used to compare a `StatusRuleRecord.match_value` against the
/// probe's raw string. Mirrors the TS `StatusMapping.rules[].matchMode`
/// union verbatim (lowercase on the wire via `rename_all`). The actual
/// matching happens frontend-side (`miniappStatusPoller.ts`); this is a
/// storage-only pass-through.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MatchMode {
    Exact,
    Contains,
    Regex,
}

/// One entry in a `mapped` status mapping: when the raw value satisfies
/// `match_mode` (default `exact` equality) against `match`, the indicator
/// shows `label` (and optional `color`). Mirrors the TS
/// `StatusMapping.rules[]` element. `match` is a Rust keyword, so the field
/// is `match_value` renamed to the wire name `match` (mirrors the
/// `while_condition` → `while` rename in `LoopConfigRecord`).
///
/// `match_mode` is `#[serde(default, skip_serializing_if = "Option::is_none")]`
/// so rules persisted before it existed still decode (`None`), and the
/// frontend treats an absent value as `"exact"` — zero migration needed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatusRuleRecord {
    #[serde(rename = "match")]
    pub match_value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_mode: Option<MatchMode>,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// How a status value is derived from a probe's extracted result. `field`
/// names an output-schema field (defaults to the return value); `mode` is
/// `"raw"` (show the value verbatim) or `"mapped"` (look up `rules`).
/// Mirrors the TS `StatusMapping`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StatusMappingRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules: Option<Vec<StatusRuleRecord>>,
}

/// Optional poll config for a `toggle` widget: run `source` on
/// `interval_ms` and map its result through `mapping` to reflect the
/// toggle's live on/off state. Mirrors the TS `MiniAppWidget.status` (the
/// toggle variant).
///
/// `on_value` names the status value that means "the switch is ON". It is
/// `#[serde(default)]` so rows persisted before the field existed still
/// decode (the frontend falls back to the legacy "probe succeeded"
/// heuristic when it is absent).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToggleStatusRecord {
    pub source: StatusSourceRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_ms: Option<u64>,
    pub mapping: StatusMappingRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_value: Option<String>,
}

/// Canvas placement of a widget: position (`x`, `y`) and size (`w`, `h`) in
/// pixel coordinates (fractional during drag, hence `f64`). Mirrors the TS
/// `WidgetLayout` interface. Every widget variant carries one so positions
/// round-trip through SQLite with the widget JSON.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WidgetLayoutRecord {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

fn default_font_size() -> f64 {
    14.0
}

fn default_text_align() -> String {
    "left".to_string()
}

/// Typography styling for a `text` widget: font size (px), optional colour,
/// bold / italic flags, and horizontal alignment (`left` / `center` /
/// `right`). Mirrors the TS `TextStyle` interface. Persisted inside the
/// widget JSON.
///
/// EVERY field carries its own `#[serde(default)]` so a PARTIAL `style`
/// object (e.g. `{ "bold": true }`) still decodes — serde only applies the
/// container-level default when the whole `style` key is absent, so
/// per-field defaults are needed for partial-object back-fill. The `Default`
/// impl agrees with the field defaults (14 px, no colour, not bold/italic,
/// left-aligned) and backs the `#[serde(default)]` on the `Text` variant's
/// `style` field so a widget persisted with NO `style` object at all also
/// decodes — mirroring the `default_panel_size` back-fill.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextStyleRecord {
    #[serde(default = "default_font_size")]
    pub font_size: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    #[serde(default = "default_text_align")]
    pub align: String,
}

impl Default for TextStyleRecord {
    fn default() -> Self {
        TextStyleRecord {
            font_size: default_font_size(),
            color: None,
            bold: false,
            italic: false,
            align: default_text_align(),
        }
    }
}

fn default_widget_variant() -> String {
    "fill".to_string()
}

/// Visual styling for a `button` or `toggle` widget: optional colour and a
/// fill/outline variant. Mirrors the TS `WidgetStyle` interface. Persisted
/// inside the widget JSON.
///
/// EVERY field carries its own `#[serde(default)]` so a PARTIAL `style`
/// object (e.g. `{ "variant": "outline" }`) still decodes — serde only
/// applies the container-level default when the whole `style` key is
/// absent, so per-field defaults are needed for partial-object back-fill.
/// The `Default` impl agrees with the field defaults (no colour, fill
/// variant). Unlike [`TextStyleRecord`], this style is itself `Option`al on
/// the widget (`style: Option<WidgetStyleRecord>`), since a button/toggle
/// with no `style` at all is a common, valid case — not a legacy row to
/// back-fill.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WidgetStyleRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default = "default_widget_variant")]
    pub variant: String,
}

impl Default for WidgetStyleRecord {
    fn default() -> Self {
        WidgetStyleRecord {
            color: None,
            variant: default_widget_variant(),
        }
    }
}

/// Pixel dimensions of a mini-app's main panel (`w` × `h`). A property of the
/// mini-app itself (not of any widget): the bordered rectangle widgets live
/// inside, resizable via a corner handle, rendered by the runner at this size.
/// Mirrors the TS `PanelSize` interface. Persisted as the `panel_size_json`
/// TEXT column; `#[serde(default = "default_panel_size")]` back-fills the
/// compact-control-panel default (`400×320`) for rows predating the column.
fn default_panel_size() -> PanelSizeRecord {
    PanelSizeRecord { w: 400.0, h: 320.0 }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PanelSizeRecord {
    pub w: f64,
    pub h: f64,
}

/// One widget on a mini-app panel. `kind`-tagged discriminated union
/// (`button` / `toggle` / `status` / `artifact`) so it round-trips the TS
/// `MiniAppWidget` union exactly. Stored inside the `widgets` JSON column.
///
/// The `MiniAppActionRecord` fields are `Box`ed to keep the enum compact:
/// `Toggle` carries two actions (each ~224 bytes incl. an inline-script
/// `HashMap`), which would otherwise dominate the enum size and trip
/// `clippy::large_enum_variant`. Serde (de)serialises `Box<T>` exactly like
/// `T`, so the IPC/JSON wire format is unaffected.
///
/// Every variant carries a `layout: WidgetLayoutRecord` for canvas placement.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum MiniAppWidgetRecord {
    #[serde(rename_all = "camelCase")]
    Button {
        id: String,
        layout: WidgetLayoutRecord,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        icon: Option<String>,
        action: Box<MiniAppActionRecord>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        style: Option<WidgetStyleRecord>,
    },
    #[serde(rename_all = "camelCase")]
    Toggle {
        id: String,
        layout: WidgetLayoutRecord,
        label: String,
        on_action: Box<MiniAppActionRecord>,
        off_action: Box<MiniAppActionRecord>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<ToggleStatusRecord>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        style: Option<WidgetStyleRecord>,
    },
    #[serde(rename_all = "camelCase")]
    Status {
        id: String,
        layout: WidgetLayoutRecord,
        label: String,
        source: StatusSourceRecord,
        interval_ms: u64,
        mapping: StatusMappingRecord,
    },
    #[serde(rename_all = "camelCase")]
    Artifact {
        id: String,
        layout: WidgetLayoutRecord,
        #[serde(default)]
        name: String,
        label: String,
        value: String,
        variant: String,
        /// Persist this artifact's runtime value back to SQLite so it
        /// survives an app restart. `#[serde(default)]` back-fills `false`
        /// for rows persisted before this field existed — zero migration
        /// needed. MUST NEVER be `true` when `variant == "secret"`; the
        /// editor's `validateMiniApp` enforces this at authoring time and
        /// the runner's write-back point re-checks it independently.
        #[serde(default)]
        persist: bool,
    },
    #[serde(rename_all = "camelCase")]
    Text {
        id: String,
        layout: WidgetLayoutRecord,
        label: String,
        content: String,
        #[serde(default)]
        style: TextStyleRecord,
    },
}

/// Materialised representation of a single mini-app as stored in SQLite and
/// exchanged over IPC. The `widgets`, `tags`, and `os` columns are
/// persisted as JSON-encoded TEXT columns (`widgets_json`, `tags_json`,
/// `os_json`) and decoded on read. Mirrors the TS `MiniApp` interface.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MiniAppRecord {
    pub id: String,
    pub name: String,
    /// Optional i18next key for the display name, set only by built-in
    /// seeds (mirrors `commands.name_key`). Persisted as the `name_key`
    /// TEXT column; `None` for every user-created mini-app.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Optional i18next key for the display description. Same rules as
    /// [`MiniAppRecord::name_key`]; persisted as `description_key`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default)]
    pub widgets: Vec<MiniAppWidgetRecord>,
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_id: Option<String>,
    pub favorite: bool,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    pub run_count: i64,
    /// Optional target-OS restriction (`linux` / `macos` / `windows`).
    /// `None` (the default) means the mini-app is universal. Persisted as
    /// the `os_json` TEXT column (JSON-encoded array, NULL when absent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os: Option<Vec<String>>,
    /// Pixel dimensions of the main panel. Persisted as the `panel_size_json`
    /// TEXT column (JSON-encoded `{w,h}`). The serde default back-fills the
    /// compact-control-panel size (`400×320`) for rows predating the column,
    /// so the field is always populated after a read.
    #[serde(default = "default_panel_size")]
    pub panel_size: PanelSizeRecord,
}

/// Return every mini-app in insertion order (oldest first).
pub async fn list_all(pool: &DbPool) -> Result<Vec<MiniAppRecord>, String> {
    let rows = sqlx::query(
        "SELECT id, name, name_key, description, description_key, icon, widgets_json, tags_json, \
                category_id, favorite, created_at, updated_at, last_run_at, run_count, os_json, \
                panel_size_json \
         FROM miniapps \
         ORDER BY created_at ASC",
    )
    .fetch_all(pool.as_ref())
    .await
    .map_err(|e| format!("list_all: {e}"))?;

    rows.into_iter().map(row_to_record).collect()
}

/// Return the mini-app with the given id, or `None` if it does not exist.
pub async fn get(pool: &DbPool, id: &str) -> Result<Option<MiniAppRecord>, String> {
    let row = sqlx::query(
        "SELECT id, name, name_key, description, description_key, icon, widgets_json, tags_json, \
                category_id, favorite, created_at, updated_at, last_run_at, run_count, os_json, \
                panel_size_json \
         FROM miniapps \
         WHERE id = ? \
         LIMIT 1",
    )
    .bind(id)
    .fetch_optional(pool.as_ref())
    .await
    .map_err(|e| format!("get: {e}"))?;

    match row {
        Some(row) => Ok(Some(row_to_record(row)?)),
        None => Ok(None),
    }
}

/// Insert a new mini-app or update an existing one (matched by `id`).
pub async fn upsert(pool: &DbPool, rec: &MiniAppRecord) -> Result<(), String> {
    let widgets_json =
        serde_json::to_string(&rec.widgets).map_err(|e| format!("encode widgets: {e}"))?;
    let tags_json = serde_json::to_string(&rec.tags).map_err(|e| format!("encode tags: {e}"))?;
    let os_json = match &rec.os {
        Some(os) => Some(serde_json::to_string(os).map_err(|e| format!("encode os: {e}"))?),
        None => None,
    };
    let panel_size_json =
        serde_json::to_string(&rec.panel_size).map_err(|e| format!("encode panel_size: {e}"))?;

    sqlx::query(
        "INSERT INTO miniapps ( \
            id, name, name_key, description, description_key, icon, widgets_json, tags_json, \
            category_id, favorite, created_at, updated_at, last_run_at, run_count, os_json, \
            panel_size_json \
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET \
            name = excluded.name, \
            name_key = excluded.name_key, \
            description = excluded.description, \
            description_key = excluded.description_key, \
            icon = excluded.icon, \
            widgets_json = excluded.widgets_json, \
            tags_json = excluded.tags_json, \
            category_id = excluded.category_id, \
            favorite = excluded.favorite, \
            updated_at = excluded.updated_at, \
            last_run_at = excluded.last_run_at, \
            run_count = excluded.run_count, \
            os_json = excluded.os_json, \
            panel_size_json = excluded.panel_size_json",
    )
    .bind(&rec.id)
    .bind(&rec.name)
    .bind(&rec.name_key)
    .bind(&rec.description)
    .bind(&rec.description_key)
    .bind(&rec.icon)
    .bind(&widgets_json)
    .bind(&tags_json)
    .bind(&rec.category_id)
    .bind(if rec.favorite { 1_i64 } else { 0_i64 })
    .bind(&rec.created_at)
    .bind(&rec.updated_at)
    .bind(&rec.last_run_at)
    .bind(rec.run_count)
    .bind(&os_json)
    .bind(&panel_size_json)
    .execute(pool.as_ref())
    .await
    .map_err(|e| format!("upsert: {e}"))?;

    Ok(())
}

/// Remove the mini-app with the given id. A missing id is not an error
/// (matches the idempotent semantics used by `storage::workflows::delete`).
pub async fn delete(pool: &DbPool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM miniapps WHERE id = ?")
        .bind(id)
        .execute(pool.as_ref())
        .await
        .map_err(|e| format!("delete: {e}"))?;
    Ok(())
}

fn row_to_record(row: sqlx::sqlite::SqliteRow) -> Result<MiniAppRecord, String> {
    let widgets_json: String = row
        .try_get("widgets_json")
        .map_err(|e| format!("read widgets_json: {e}"))?;
    let tags_json: String = row
        .try_get("tags_json")
        .map_err(|e| format!("read tags_json: {e}"))?;
    let favorite_i: i64 = row
        .try_get("favorite")
        .map_err(|e| format!("read favorite: {e}"))?;

    let widgets = serde_json::from_str::<Vec<MiniAppWidgetRecord>>(&widgets_json)
        .map_err(|e| format!("decode widgets_json: {e}"))?;
    let tags = serde_json::from_str::<Vec<String>>(&tags_json)
        .map_err(|e| format!("decode tags_json: {e}"))?;
    let os_json: Option<String> = row
        .try_get("os_json")
        .map_err(|e| format!("read os_json: {e}"))?;
    let os = match os_json {
        Some(s) => Some(
            serde_json::from_str::<Vec<String>>(&s).map_err(|e| format!("decode os_json: {e}"))?,
        ),
        None => None,
    };
    // `panel_size_json` is NOT NULL with a column default, but a legacy row
    // predating the column migration reads as NULL here (the ALTER back-fills
    // the default for existing rows, so this is belt-and-braces). Fall back to
    // the serde default shape rather than failing the whole read.
    let panel_size_json: Option<String> = row
        .try_get("panel_size_json")
        .map_err(|e| format!("read panel_size_json: {e}"))?;
    let panel_size = match panel_size_json {
        Some(s) => {
            serde_json::from_str::<PanelSizeRecord>(&s).unwrap_or_else(|_| default_panel_size())
        }
        None => default_panel_size(),
    };

    Ok(MiniAppRecord {
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
        widgets,
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
        os,
        panel_size,
    })
}

#[cfg(test)]
mod wire_format_tests {
    use super::*;
    use crate::storage::commands::VariableSpec;

    fn sample() -> MiniAppRecord {
        MiniAppRecord {
            id: "ma-1".into(),
            name: "VPN".into(),
            name_key: Some("miniapps.seeds.openvpn3.name".into()),
            description: Some("openvpn3 panel".into()),
            description_key: Some("miniapps.seeds.openvpn3.description".into()),
            icon: Some("shield".into()),
            widgets: vec![
                MiniAppWidgetRecord::Button {
                    id: "w-connect".into(),
                    layout: WidgetLayoutRecord {
                        x: 0.0,
                        y: 0.0,
                        w: 200.0,
                        h: 60.0,
                    },
                    label: "Connect".into(),
                    icon: None,
                    action: Box::new(MiniAppActionRecord::CommandRef {
                        command_id: "cmd-connect".into(),
                    }),
                    style: None,
                },
                MiniAppWidgetRecord::Toggle {
                    id: "w-tog".into(),
                    layout: WidgetLayoutRecord {
                        x: 0.0,
                        y: 80.0,
                        w: 200.0,
                        h: 60.0,
                    },
                    label: "Auto".into(),
                    on_action: Box::new(MiniAppActionRecord::Inline {
                        name: "on".into(),
                        script: "echo on".into(),
                        shell: Some("bash".into()),
                        args: None,
                        working_dir: None,
                        env: None,
                        run_as_admin: false,
                        variables: Some(vec![VariableSpec {
                            name: "x".into(),
                            default_value: Some("1".into()),
                            prompt_at_runtime: false,
                            description: None,
                            sensitive: false,
                        }]),
                    }),
                    off_action: Box::new(MiniAppActionRecord::CommandRef {
                        command_id: "cmd-off".into(),
                    }),
                    status: None,
                    style: None,
                },
            ],
            tags: vec!["net".into()],
            category_id: Some("c1".into()),
            favorite: true,
            created_at: "2026-07-30T00:00:00Z".into(),
            updated_at: "2026-07-30T00:00:01Z".into(),
            last_run_at: Some("2026-07-30T00:00:02Z".into()),
            run_count: 3,
            os: Some(vec!["linux".into()]),
            panel_size: PanelSizeRecord { w: 320.0, h: 240.0 },
        }
    }

    #[test]
    fn record_serializes_camelcase() {
        let rec = sample();
        let json = serde_json::to_value(&rec).unwrap();
        // Positive: every camelCase key is present.
        assert!(json.get("id").is_some());
        assert!(json.get("widgets").is_some());
        assert!(json.get("tags").is_some());
        assert!(json.get("categoryId").is_some());
        assert!(json.get("createdAt").is_some());
        assert!(json.get("updatedAt").is_some());
        assert!(json.get("lastRunAt").is_some());
        assert!(json.get("runCount").is_some());
        assert!(json.get("os").is_some());
        assert!(json.get("panelSize").is_some());
        assert_eq!(json["panelSize"]["w"], 320.0);
        assert_eq!(json["panelSize"]["h"], 240.0);
        assert_eq!(json["nameKey"], "miniapps.seeds.openvpn3.name");
        assert_eq!(
            json["descriptionKey"],
            "miniapps.seeds.openvpn3.description"
        );
        // Negative: snake_case must NOT leak through.
        assert!(json.get("category_id").is_none());
        assert!(json.get("created_at").is_none());
        assert!(json.get("last_run_at").is_none());
        assert!(json.get("run_count").is_none());
        assert!(json.get("widgets_json").is_none());
        assert!(json.get("panel_size").is_none());
        assert!(json.get("panel_size_json").is_none());
        assert!(json.get("name_key").is_none());
        assert!(json.get("description_key").is_none());
    }

    /// A toggle's `status.onValue` camelCases on the wire and round-trips.
    #[test]
    fn toggle_status_on_value_camelcase_and_round_trip() {
        let status = ToggleStatusRecord {
            source: StatusSourceRecord::Inline {
                script: "systemctl is-active nginx".into(),
                shell: None,
                variables: None,
            },
            interval_ms: Some(5000),
            mapping: StatusMappingRecord {
                field: None,
                mode: "raw".into(),
                rules: None,
            },
            on_value: Some("active".into()),
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["onValue"], "active");
        assert!(json.get("on_value").is_none());
        let back: ToggleStatusRecord = serde_json::from_value(json).unwrap();
        assert_eq!(back, status);
    }

    /// A toggle status persisted BEFORE `on_value` existed must still decode:
    /// `#[serde(default)]` back-fills `None` (the frontend then falls back to
    /// the legacy "probe succeeded" heuristic).
    #[test]
    fn toggle_status_deserializes_without_on_value_for_backward_compat() {
        let json = serde_json::json!({
            "source": { "kind": "inline", "script": "echo up" },
            "mapping": { "mode": "raw" }
        });
        let status: ToggleStatusRecord =
            serde_json::from_value(json).expect("should decode legacy toggle status");
        assert!(status.on_value.is_none());
        assert!(status.interval_ms.is_none());
    }

    /// The widget union tags on `kind` (lowercased variant) and camelCases
    /// its struct-variant fields (`commandId`, `workingDir`, `runAsAdmin`).
    #[test]
    fn widget_roundtrips_with_kind_tag_and_camelcase_fields() {
        let button = MiniAppWidgetRecord::Button {
            id: "w1".into(),
            layout: WidgetLayoutRecord {
                x: 0.0,
                y: 0.0,
                w: 200.0,
                h: 60.0,
            },
            label: "Run".into(),
            icon: None,
            action: Box::new(MiniAppActionRecord::CommandRef {
                command_id: "cmd-1".into(),
            }),
            style: None,
        };
        let json = serde_json::to_value(&button).unwrap();
        assert_eq!(json["kind"], "button");
        // The canvas layout nests as a plain object and round-trips.
        assert_eq!(json["layout"]["x"], 0.0);
        assert_eq!(json["layout"]["y"], 0.0);
        assert_eq!(json["layout"]["w"], 200.0);
        assert_eq!(json["layout"]["h"], 60.0);
        assert_eq!(json["action"]["kind"], "commandRef");
        assert_eq!(json["action"]["commandId"], "cmd-1");
        assert!(json.get("command_id").is_none());
        let back: MiniAppWidgetRecord = serde_json::from_value(json).unwrap();
        assert_eq!(back, button);
    }

    /// An inline action camelCases every field and round-trips unchanged.
    #[test]
    fn inline_action_camelcase_and_round_trip() {
        let action = MiniAppActionRecord::Inline {
            name: "on".into(),
            script: "echo hi".into(),
            shell: Some("bash".into()),
            args: Some(vec!["-l".into()]),
            working_dir: Some("/tmp".into()),
            env: None,
            run_as_admin: true,
            variables: None,
        };
        let json = serde_json::to_value(&action).unwrap();
        assert_eq!(json["kind"], "inline");
        assert_eq!(json["workingDir"], "/tmp");
        assert_eq!(json["runAsAdmin"], true);
        assert!(json.get("working_dir").is_none());
        assert!(json.get("run_as_admin").is_none());
        let back: MiniAppActionRecord = serde_json::from_value(json).unwrap();
        assert_eq!(back, action);
    }

    /// A `mapped` rule renames `match_value` → `match` on the wire.
    #[test]
    fn status_rule_renames_match_keyword() {
        let rule = StatusRuleRecord {
            match_value: "up".into(),
            match_mode: None,
            label: "Connected".into(),
            color: Some("green".into()),
        };
        let json = serde_json::to_value(&rule).unwrap();
        assert_eq!(json["match"], "up");
        assert_eq!(json["label"], "Connected");
        assert!(json.get("match_value").is_none());
        let back: StatusRuleRecord = serde_json::from_value(json).unwrap();
        assert_eq!(back, rule);
    }

    /// A rule with `matchMode: "contains"` round-trips correctly and
    /// serialises as a lowercase string matching the TS union verbatim.
    #[test]
    fn status_rule_match_mode_contains_round_trips() {
        let rule = StatusRuleRecord {
            match_value: "Client connected".into(),
            match_mode: Some(MatchMode::Contains),
            label: "Connected".into(),
            color: None,
        };
        let json = serde_json::to_value(&rule).unwrap();
        assert_eq!(json["matchMode"], "contains");
        assert!(json.get("match_mode").is_none());
        let back: StatusRuleRecord = serde_json::from_value(json).unwrap();
        assert_eq!(back, rule);
    }

    /// `matchMode` serialises to the exact lowercase strings the TS union
    /// expects, for every variant.
    #[test]
    fn match_mode_serializes_to_lowercase_strings() {
        assert_eq!(serde_json::to_value(MatchMode::Exact).unwrap(), "exact");
        assert_eq!(
            serde_json::to_value(MatchMode::Contains).unwrap(),
            "contains"
        );
        assert_eq!(serde_json::to_value(MatchMode::Regex).unwrap(), "regex");
    }

    /// A rule persisted BEFORE `match_mode` existed must still decode:
    /// `#[serde(default)]` back-fills `None`, which the frontend treats as
    /// `"exact"` — zero migration needed.
    #[test]
    fn status_rule_deserializes_without_match_mode_for_backward_compat() {
        let json = serde_json::json!({
            "match": "up",
            "label": "Connected"
        });
        let rule: StatusRuleRecord =
            serde_json::from_value(json).expect("should decode legacy rule");
        assert!(rule.match_mode.is_none());
    }

    #[test]
    fn record_roundtrips_through_json() {
        let rec = sample();
        let json = serde_json::to_string(&rec).unwrap();
        let back: MiniAppRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(rec, back);
    }

    /// A minimal payload that omits optionals must deserialize cleanly.
    #[test]
    fn record_deserializes_when_optionals_absent() {
        let json = serde_json::json!({
            "id": "ma-x",
            "name": "n",
            "widgets": [],
            "tags": [],
            "favorite": false,
            "createdAt": "2026-07-30T00:00:00Z",
            "updatedAt": "2026-07-30T00:00:00Z",
            "runCount": 0
        });
        let rec: MiniAppRecord = serde_json::from_value(json).unwrap();
        assert!(rec.widgets.is_empty());
        assert!(rec.description.is_none());
        assert!(rec.name_key.is_none());
        assert!(rec.description_key.is_none());
        assert!(rec.os.is_none());
        // `panelSize` carries the serde default (400×320) when the payload
        // omits it — exactly the back-fill a pre-panelSize row gets.
        assert_eq!(rec.panel_size, default_panel_size());
    }

    /// An `artifact` widget persisted BEFORE the `name` field existed (old
    /// SQLite rows in the `miniapps` table) must still decode: `#[serde(default)]`
    /// on the field back-fills `""` instead of failing with `missing field name`.
    #[test]
    fn artifact_widget_deserializes_without_name_for_backward_compat() {
        let json = serde_json::json!({
            "id": "a1",
            "kind": "artifact",
            "layout": {"x": 0.0, "y": 0.0, "w": 100.0, "h": 50.0},
            "label": "Cfg",
            "value": "/etc/config",
            "variant": "path"
        });
        let w: MiniAppWidgetRecord =
            serde_json::from_value(json).expect("should decode old artifact without name");
        match w {
            MiniAppWidgetRecord::Artifact { name, persist, .. } => {
                assert_eq!(name, "");
                assert!(!persist);
            }
            _ => panic!("expected Artifact"),
        }
    }

    /// An `artifact` widget persisted BEFORE the `persist` field existed
    /// must still decode: `#[serde(default)]` on the field back-fills
    /// `false` instead of failing with `missing field persist`.
    #[test]
    fn artifact_widget_deserializes_without_persist_for_backward_compat() {
        let json = serde_json::json!({
            "id": "a1",
            "kind": "artifact",
            "layout": {"x": 0.0, "y": 0.0, "w": 100.0, "h": 50.0},
            "name": "configPath",
            "label": "Cfg",
            "value": "/etc/config",
            "variant": "path"
        });
        let w: MiniAppWidgetRecord =
            serde_json::from_value(json).expect("should decode old artifact without persist");
        match w {
            MiniAppWidgetRecord::Artifact { persist, .. } => {
                assert!(!persist);
            }
            _ => panic!("expected Artifact"),
        }
    }

    /// An `artifact` widget with `persist: true` camelCases on the wire and
    /// round-trips unchanged.
    #[test]
    fn artifact_widget_persist_true_camelcase_and_round_trip() {
        let widget = MiniAppWidgetRecord::Artifact {
            id: "a1".into(),
            layout: WidgetLayoutRecord {
                x: 0.0,
                y: 0.0,
                w: 100.0,
                h: 50.0,
            },
            name: "configPath".into(),
            label: "Cfg".into(),
            value: "/etc/config".into(),
            variant: "path".into(),
            persist: true,
        };
        let json = serde_json::to_value(&widget).unwrap();
        assert_eq!(json["persist"], true);
        let back: MiniAppWidgetRecord = serde_json::from_value(json).unwrap();
        assert_eq!(back, widget);
    }

    /// A `text` widget tags on `kind: "text"` and camelCases its style
    /// fields (`fontSize`, not `font_size`), and round-trips unchanged.
    #[test]
    fn text_widget_serializes_camelcase_and_round_trips() {
        let widget = MiniAppWidgetRecord::Text {
            id: "w-txt".into(),
            layout: WidgetLayoutRecord {
                x: 10.0,
                y: 20.0,
                w: 240.0,
                h: 40.0,
            },
            label: "Heading".into(),
            content: "Welcome to the panel".into(),
            style: TextStyleRecord {
                font_size: 18.0,
                color: Some("#ff0000".into()),
                bold: true,
                italic: false,
                align: "center".into(),
            },
        };
        let json = serde_json::to_value(&widget).unwrap();
        assert_eq!(json["kind"], "text");
        assert_eq!(json["content"], "Welcome to the panel");
        assert_eq!(json["style"]["fontSize"], 18.0);
        assert_eq!(json["style"]["color"], "#ff0000");
        assert_eq!(json["style"]["bold"], true);
        assert_eq!(json["style"]["align"], "center");
        // snake_case must NOT leak through.
        assert!(json["style"].get("font_size").is_none());
        let back: MiniAppWidgetRecord = serde_json::from_value(json).unwrap();
        assert_eq!(back, widget);
    }

    /// A `text` widget persisted BEFORE the `style` field existed (or without
    /// one) must still decode: `#[serde(default)]` back-fills the default
    /// style (fontSize 14, align "left") — mirrors the artifact/name and
    /// panelSize back-fill tests.
    #[test]
    fn text_widget_deserializes_without_style_for_backward_compat() {
        let json = serde_json::json!({
            "id": "t1",
            "kind": "text",
            "layout": {"x": 0.0, "y": 0.0, "w": 100.0, "h": 30.0},
            "label": "Note",
            "content": "hello"
        });
        let w: MiniAppWidgetRecord =
            serde_json::from_value(json).expect("should decode text widget without style");
        match w {
            MiniAppWidgetRecord::Text { style, .. } => {
                assert_eq!(style, TextStyleRecord::default());
                assert_eq!(style.font_size, 14.0);
                assert_eq!(style.align, "left");
                assert!(style.color.is_none());
                assert!(!style.bold);
                assert!(!style.italic);
            }
            _ => panic!("expected Text"),
        }
    }

    /// A `text` widget with a PARTIAL `style` (only `bold: true`) fills the
    /// remaining fields from `TextStyleRecord`'s per-field serde defaults
    /// (fontSize 14, align "left", italic false, no colour).
    #[test]
    fn text_widget_partial_style_fills_defaults() {
        let json = serde_json::json!({
            "id": "t2",
            "kind": "text",
            "layout": {"x": 0.0, "y": 0.0, "w": 100.0, "h": 30.0},
            "label": "Note",
            "content": "hi",
            "style": { "bold": true }
        });
        let w: MiniAppWidgetRecord =
            serde_json::from_value(json).expect("should decode text widget with partial style");
        match w {
            MiniAppWidgetRecord::Text { style, .. } => {
                assert!(style.bold);
                assert_eq!(style.font_size, 14.0);
                assert_eq!(style.align, "left");
                assert!(!style.italic);
                assert!(style.color.is_none());
            }
            _ => panic!("expected Text"),
        }
    }

    /// A `button` widget's `style` camelCases its fields (`color`,
    /// `variant`) and round-trips unchanged.
    #[test]
    fn button_widget_style_serializes_camelcase_and_round_trips() {
        let widget = MiniAppWidgetRecord::Button {
            id: "w-btn".into(),
            layout: WidgetLayoutRecord {
                x: 0.0,
                y: 0.0,
                w: 200.0,
                h: 60.0,
            },
            label: "Stop".into(),
            icon: None,
            action: Box::new(MiniAppActionRecord::CommandRef {
                command_id: "cmd-stop".into(),
            }),
            style: Some(WidgetStyleRecord {
                color: Some("var(--color-danger)".into()),
                variant: "outline".into(),
            }),
        };
        let json = serde_json::to_value(&widget).unwrap();
        assert_eq!(json["style"]["color"], "var(--color-danger)");
        assert_eq!(json["style"]["variant"], "outline");
        let back: MiniAppWidgetRecord = serde_json::from_value(json).unwrap();
        assert_eq!(back, widget);
    }

    /// A `button` widget persisted BEFORE the `style` field existed (or
    /// without one) must still decode: `#[serde(default)]` back-fills
    /// `None` — mirrors the artifact/name and text/style backward-compat
    /// tests.
    #[test]
    fn button_widget_deserializes_without_style_for_backward_compat() {
        let json = serde_json::json!({
            "id": "b1",
            "kind": "button",
            "layout": {"x": 0.0, "y": 0.0, "w": 100.0, "h": 30.0},
            "label": "Run",
            "action": { "kind": "commandRef", "commandId": "cmd-1" }
        });
        let w: MiniAppWidgetRecord =
            serde_json::from_value(json).expect("should decode button widget without style");
        match w {
            MiniAppWidgetRecord::Button { style, .. } => {
                assert!(style.is_none());
            }
            _ => panic!("expected Button"),
        }
    }

    /// A `toggle` widget persisted BEFORE the `style` field existed (or
    /// without one) must still decode: `#[serde(default)]` back-fills
    /// `None` — mirrors `toggle_status_deserializes_without_on_value_for_backward_compat`.
    #[test]
    fn toggle_widget_deserializes_without_style_for_backward_compat() {
        let json = serde_json::json!({
            "id": "tg1",
            "kind": "toggle",
            "layout": {"x": 0.0, "y": 0.0, "w": 100.0, "h": 30.0},
            "label": "VPN",
            "onAction": { "kind": "commandRef", "commandId": "cmd-on" },
            "offAction": { "kind": "commandRef", "commandId": "cmd-off" }
        });
        let w: MiniAppWidgetRecord =
            serde_json::from_value(json).expect("should decode toggle widget without style");
        match w {
            MiniAppWidgetRecord::Toggle { style, .. } => {
                assert!(style.is_none());
            }
            _ => panic!("expected Toggle"),
        }
    }

    /// A `style` object with only `variant` set (no `color`) decodes with
    /// `color: None`, per `WidgetStyleRecord`'s per-field serde defaults.
    #[test]
    fn widget_style_partial_decodes_with_default_color() {
        let json = serde_json::json!({
            "id": "b2",
            "kind": "button",
            "layout": {"x": 0.0, "y": 0.0, "w": 100.0, "h": 30.0},
            "label": "Run",
            "action": { "kind": "commandRef", "commandId": "cmd-1" },
            "style": { "variant": "outline" }
        });
        let w: MiniAppWidgetRecord =
            serde_json::from_value(json).expect("should decode button with partial style");
        match w {
            MiniAppWidgetRecord::Button { style, .. } => {
                let style = style.expect("style should be present");
                assert!(style.color.is_none());
                assert_eq!(style.variant, "outline");
            }
            _ => panic!("expected Button"),
        }
    }

    /// `WidgetStyleRecord::default()` agrees with the per-field serde
    /// defaults: fill variant, no colour.
    #[test]
    fn widget_style_record_default_is_fill_with_no_color() {
        let style = WidgetStyleRecord::default();
        assert_eq!(style.variant, "fill");
        assert!(style.color.is_none());
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

    fn fixture(id: &str, favorite: bool) -> MiniAppRecord {
        MiniAppRecord {
            id: id.into(),
            name: format!("name-{id}"),
            name_key: None,
            description: None,
            description_key: None,
            icon: None,
            widgets: vec![MiniAppWidgetRecord::Button {
                id: "w1".into(),
                layout: WidgetLayoutRecord {
                    x: 0.0,
                    y: 0.0,
                    w: 200.0,
                    h: 60.0,
                },
                label: "Run".into(),
                icon: None,
                action: Box::new(MiniAppActionRecord::CommandRef {
                    command_id: "cmd-1".into(),
                }),
                style: None,
            }],
            tags: vec!["x".into()],
            category_id: None,
            favorite,
            created_at: format!("2026-07-30T00:00:0{}", id.len() % 10),
            updated_at: "2026-07-30T00:00:00Z".into(),
            last_run_at: None,
            run_count: 0,
            os: None,
            panel_size: PanelSizeRecord { w: 400.0, h: 320.0 },
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
    async fn get_returns_some_for_existing_and_none_for_missing() {
        let pool = make_pool().await;
        let rec = fixture("one", false);
        upsert(&pool, &rec).await.unwrap();
        assert_eq!(get(&pool, "one").await.unwrap(), Some(rec));
        assert!(get(&pool, "missing").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_removes_record() {
        let pool = make_pool().await;
        let rec = fixture("one", false);
        upsert(&pool, &rec).await.unwrap();
        delete(&pool, "one").await.unwrap();
        assert!(list_all(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn delete_missing_id_is_noop() {
        let pool = make_pool().await;
        delete(&pool, "does-not-exist").await.unwrap();
    }

    /// A non-empty `os` array round-trips through the JSON column, and
    /// swapping it for `None` clears the stored value (the ON CONFLICT
    /// clause covers `os_json`).
    #[tokio::test]
    async fn os_array_round_trips_and_can_be_cleared() {
        let pool = make_pool().await;
        let mut rec = fixture("os", false);
        rec.os = Some(vec!["linux".into(), "macos".into()]);
        upsert(&pool, &rec).await.unwrap();
        let loaded = get(&pool, "os").await.unwrap().unwrap();
        assert_eq!(
            loaded.os,
            Some(vec!["linux".to_string(), "macos".to_string()])
        );

        rec.os = None;
        upsert(&pool, &rec).await.unwrap();
        let loaded = get(&pool, "os").await.unwrap().unwrap();
        assert!(loaded.os.is_none());
    }

    /// The seed i18n keys round-trip through their own scalar columns, and
    /// the ON CONFLICT clause clears them when a mini-app stops being a seed
    /// (the editor drops both keys when a user edits a seed).
    #[tokio::test]
    async fn name_and_description_keys_round_trip_and_can_be_cleared() {
        let pool = make_pool().await;
        let mut rec = fixture("keys", false);
        rec.name_key = Some("miniapps.seeds.openvpn3.name".into());
        rec.description_key = Some("miniapps.seeds.openvpn3.description".into());
        upsert(&pool, &rec).await.unwrap();
        let loaded = get(&pool, "keys").await.unwrap().unwrap();
        assert_eq!(
            loaded.name_key,
            Some("miniapps.seeds.openvpn3.name".to_string())
        );
        assert_eq!(
            loaded.description_key,
            Some("miniapps.seeds.openvpn3.description".to_string())
        );

        rec.name_key = None;
        rec.description_key = None;
        upsert(&pool, &rec).await.unwrap();
        let loaded = get(&pool, "keys").await.unwrap().unwrap();
        assert!(loaded.name_key.is_none());
        assert!(loaded.description_key.is_none());
    }

    /// A toggle widget's `status.on_value` survives the JSON widget column.
    #[tokio::test]
    async fn toggle_on_value_round_trips_through_widgets_json() {
        let pool = make_pool().await;
        let mut rec = fixture("toggle", false);
        rec.widgets = vec![MiniAppWidgetRecord::Toggle {
            id: "w-tog".into(),
            layout: WidgetLayoutRecord {
                x: 0.0,
                y: 0.0,
                w: 160.0,
                h: 44.0,
            },
            label: "VPN".into(),
            on_action: Box::new(MiniAppActionRecord::CommandRef {
                command_id: "cmd-on".into(),
            }),
            off_action: Box::new(MiniAppActionRecord::CommandRef {
                command_id: "cmd-off".into(),
            }),
            status: Some(ToggleStatusRecord {
                source: StatusSourceRecord::Inline {
                    script: "echo connected".into(),
                    shell: None,
                    variables: None,
                },
                interval_ms: Some(5000),
                mapping: StatusMappingRecord {
                    field: None,
                    mode: "raw".into(),
                    rules: None,
                },
                on_value: Some("connected".into()),
            }),
            style: None,
        }];
        upsert(&pool, &rec).await.unwrap();
        let loaded = get(&pool, "toggle").await.unwrap().unwrap();
        assert_eq!(loaded.widgets, rec.widgets);
    }

    /// The panel dimensions round-trip through the `panel_size_json` column,
    /// and the ON CONFLICT clause covers them on update.
    #[tokio::test]
    async fn panel_size_round_trips_and_updates() {
        let pool = make_pool().await;
        let mut rec = fixture("panel", false);
        rec.panel_size = PanelSizeRecord { w: 500.0, h: 360.0 };
        upsert(&pool, &rec).await.unwrap();
        let loaded = get(&pool, "panel").await.unwrap().unwrap();
        assert_eq!(loaded.panel_size, PanelSizeRecord { w: 500.0, h: 360.0 });

        rec.panel_size = PanelSizeRecord { w: 240.0, h: 200.0 };
        upsert(&pool, &rec).await.unwrap();
        let loaded = get(&pool, "panel").await.unwrap().unwrap();
        assert_eq!(loaded.panel_size, PanelSizeRecord { w: 240.0, h: 200.0 });
    }
}
