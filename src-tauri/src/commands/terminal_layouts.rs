//! Tauri commands for terminal layout presets ("макеты терминала").
//!
//! Thin `#[tauri::command]` wrappers over `storage::terminal_layouts`. A
//! layout is a user-named snapshot of the Terminal mode (dock position,
//! fullscreen, panel size, region split tree, last typed command per saved
//! window) — created/overwritten ONLY by an explicit user action. Like the
//! rest of `core::terminal`/terminal UI, this surface is NOT reachable from
//! `core::http_server`, the scheduler, or the workflow runner.

use tauri::State;

use crate::storage::terminal_layouts as store;
use crate::storage::DbPool;

/// Payload of `save_terminal_layout`. `id` selects the mode:
/// `None` → create a new layout (fresh uuid), `Some(id)` → overwrite that
/// existing layout ("re-save" after the user changed a parameter).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveLayoutRequest {
    pub id: Option<String>,
    pub name: String,
    pub position: String,
    pub fullscreen: bool,
    pub size: store::LayoutSize,
    pub layout: store::LayoutSnapshotNode,
}

/// Reject empty/whitespace names up front; returns the trimmed name.
fn validated_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("terminal layout name must not be empty".into());
    }
    Ok(trimmed.to_string())
}

/// Reject duplicate names with a friendly message (the UNIQUE constraint is
/// the race-safe backstop; this pre-check produces a readable error).
async fn ensure_name_free(
    pool: &DbPool,
    name: &str,
    exclude_id: Option<&str>,
) -> Result<(), String> {
    if let Some(existing) = store::find_by_name(pool, name).await? {
        if existing.id != exclude_id.unwrap_or_default() {
            return Err(format!("a layout named \"{name}\" already exists"));
        }
    }
    Ok(())
}

/// List every saved layout, name-ordered.
#[tauri::command]
pub async fn list_terminal_layouts(
    pool: State<'_, DbPool>,
) -> Result<Vec<store::TerminalLayoutRecord>, String> {
    store::list(pool.inner()).await
}

/// Create a new layout (when `request.id` is `None`) or overwrite the
/// existing one (`Some(id)`). Returns the saved record (with generated id /
/// timestamps on create).
#[tauri::command]
pub async fn save_terminal_layout(
    pool: State<'_, DbPool>,
    request: SaveLayoutRequest,
) -> Result<store::TerminalLayoutRecord, String> {
    let name = validated_name(&request.name)?;
    store::validate_snapshot(&request.layout)?;

    let now = chrono::Utc::now().to_rfc3339();
    let (id, created_at) = match &request.id {
        Some(id) => {
            let existing = store::get(pool.inner(), id)
                .await?
                .ok_or_else(|| format!("terminal layout {id} not found"))?;
            ensure_name_free(pool.inner(), &name, Some(id)).await?;
            (id.clone(), existing.created_at)
        }
        None => {
            ensure_name_free(pool.inner(), &name, None).await?;
            (uuid::Uuid::new_v4().to_string(), now.clone())
        }
    };

    let record = store::TerminalLayoutRecord {
        id,
        name,
        position: request.position,
        fullscreen: request.fullscreen,
        size: request.size,
        layout: request.layout,
        created_at,
        updated_at: now,
    };
    store::upsert(pool.inner(), &record).await?;
    Ok(record)
}

/// Rename a layout (keeps its snapshot; bumps `updatedAt`).
#[tauri::command]
pub async fn rename_terminal_layout(
    pool: State<'_, DbPool>,
    id: String,
    name: String,
) -> Result<store::TerminalLayoutRecord, String> {
    let name = validated_name(&name)?;
    ensure_name_free(pool.inner(), &name, Some(&id)).await?;
    let now = chrono::Utc::now().to_rfc3339();
    store::rename(pool.inner(), &id, &name, &now).await?;
    store::get(pool.inner(), &id)
        .await?
        .ok_or_else(|| format!("terminal layout {id} not found"))
}

/// Delete a layout. Idempotent — a missing id is not an error.
#[tauri::command]
pub async fn delete_terminal_layout(pool: State<'_, DbPool>, id: String) -> Result<(), String> {
    store::delete(pool.inner(), &id).await
}
