//! Tauri commands for command execution and the Command-library CRUD.
//!
//! Execution wrappers hand off to `core::executor`; the CRUD trio wraps
//! `storage::commands`. Kept thin — all logic lives in the wrapped layers.

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::core::executor::{self, ExecuteRequest, ExecutorState};
use crate::storage::commands as storage_commands;
use crate::storage::DbPool;

#[tauri::command]
pub async fn execute_command(
    app: AppHandle,
    state: State<'_, Arc<ExecutorState>>,
    req: ExecuteRequest,
) -> Result<String, String> {
    executor::spawn_execution(app, state.inner().clone(), req).await
}

#[tauri::command]
pub async fn cancel_execution(
    state: State<'_, Arc<ExecutorState>>,
    execution_id: String,
) -> Result<(), String> {
    executor::cancel_execution(state.inner().clone(), execution_id).await
}

#[tauri::command]
pub async fn list_running_executions(
    state: State<'_, Arc<ExecutorState>>,
) -> Result<Vec<String>, String> {
    let map = state.inner().running.lock().await;
    Ok(map.keys().cloned().collect())
}

#[tauri::command]
pub async fn list_commands(
    pool: State<'_, DbPool>,
) -> Result<Vec<storage_commands::CommandRecord>, String> {
    storage_commands::list_all(pool.inner()).await
}

#[tauri::command]
pub async fn upsert_command(
    pool: State<'_, DbPool>,
    command: storage_commands::CommandRecord,
) -> Result<(), String> {
    storage_commands::upsert(pool.inner(), &command).await
}

#[tauri::command]
pub async fn delete_command(pool: State<'_, DbPool>, id: String) -> Result<(), String> {
    storage_commands::delete(pool.inner(), &id).await
}

/// Cascade-delete every `local`-scoped command owned by the given workflow.
/// Called by the frontend when a workflow is deleted so its private commands
/// go with it. Idempotent — a workflow with no local commands is a no-op.
#[tauri::command]
pub async fn delete_local_commands_for_workflow(
    pool: State<'_, DbPool>,
    workflow_id: String,
) -> Result<(), String> {
    storage_commands::delete_local_for_workflow(pool.inner(), &workflow_id).await
}
