//! Workflow CRUD + execution commands.
//!
//! CRUD wrappers mirror the command-library trio exactly (list / upsert /
//! delete over `storage::workflows`). `execute_workflow` is the only one
//! with real logic: it resolves every `CommandRecord` referenced by a
//! `command` / `condition` node from storage, hands the graph + resolved
//! commands to the workflow engine, and returns the run id. The engine
//! itself never touches the DB — keeping it testable — so resolution lives
//! here at the command boundary.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::core::executor::ExecutorState;
use crate::core::workflow::{self, WorkflowExecutorState};
use crate::storage::commands as storage_commands;
use crate::storage::workflows as storage_workflows;
use crate::storage::DbPool;

#[tauri::command]
pub async fn list_workflows(
    pool: State<'_, DbPool>,
) -> Result<Vec<storage_workflows::WorkflowRecord>, String> {
    storage_workflows::list_all(pool.inner()).await
}

#[tauri::command]
pub async fn upsert_workflow(
    app: AppHandle,
    pool: State<'_, DbPool>,
    workflow: storage_workflows::WorkflowRecord,
) -> Result<(), String> {
    storage_workflows::upsert(pool.inner(), &workflow).await?;
    // Reflect a favorite toggle / rename in the tray "Favorites" submenu and
    // (when enabled) the OS file-manager menu.
    crate::platform::tray::rebuild_favorites(&app).await;
    crate::commands::command::refresh_shell_integration(pool.inner()).await;
    Ok(())
}

#[tauri::command]
pub async fn delete_workflow(
    app: AppHandle,
    pool: State<'_, DbPool>,
    id: String,
) -> Result<(), String> {
    storage_workflows::delete(pool.inner(), &id).await?;
    crate::platform::tray::rebuild_favorites(&app).await;
    crate::commands::command::refresh_shell_integration(pool.inner()).await;
    Ok(())
}

/// Start a workflow run. The frontend sends the full `WorkflowRecord`
/// (matching the `upsert` / `execute_command` convention of passing the
/// materialised record rather than re-fetching by id), so an unsaved
/// edit can be run without a round-trip through the DB. The referenced
/// commands ARE resolved from storage here: a node carries only a
/// `commandId`, and the engine needs the full `CommandRecord` (script,
/// shell, variables, …) to spawn it.
///
/// Returns the run id; graph progress arrives on the `workflow-event`
/// channel. A node whose `commandId` is not found in storage surfaces as
/// a `WorkflowError::UnknownCommand` from the engine (emitted as a
/// `workflowError` event), so we do not pre-validate here beyond loading
/// the table.
///
/// `node_variable_values` (camelCase `nodeVariableValues` on the wire)
/// carries the per-node variable values the frontend collected via
/// `resolveVariableValues` — spec defaults merged with the user's prompt
/// answers for any no-default variable. Each entry is keyed by node id
/// and handed to the engine, which substitutes it per command run. A
/// node with all-defaulted variables can be omitted from the map.
///
/// `node_working_dir_values` (camelCase `nodeWorkingDirValues`) mirrors it
/// for the single working-directory value a node's `atRun` working-dir
/// prompt collected (see `WorkflowNode.workingDirSource`). A node absent
/// from the map falls back to no override.
#[tauri::command]
pub async fn execute_workflow(
    app: AppHandle,
    executor_state: State<'_, Arc<ExecutorState>>,
    workflow_state: State<'_, Arc<WorkflowExecutorState>>,
    pool: State<'_, DbPool>,
    workflow: storage_workflows::WorkflowRecord,
    node_variable_values: HashMap<String, BTreeMap<String, String>>,
    node_working_dir_values: HashMap<String, String>,
) -> Result<String, String> {
    let commands = storage_commands::resolve_map(pool.inner()).await?;

    workflow::execute_workflow(
        app,
        executor_state.inner().clone(),
        workflow_state.inner().clone(),
        workflow,
        commands,
        node_variable_values,
        node_working_dir_values,
        // A direct UI run always streams to the live console.
        false,
    )
    .await
}

/// Run a workflow STARTING FROM a specific node, seeding that node's input
/// with `seed_input` (the editor's "example input" for the node — a prior
/// run's capture, a manual sample, or `null` when empty). The node and every
/// downstream node execute and stream the same per-node events as a full run,
/// so the editor recomputes their input/output previews. Cancellation reuses
/// `cancel_workflow` with the returned run id.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn run_workflow_from_node(
    app: AppHandle,
    executor_state: State<'_, Arc<ExecutorState>>,
    workflow_state: State<'_, Arc<WorkflowExecutorState>>,
    pool: State<'_, DbPool>,
    workflow: storage_workflows::WorkflowRecord,
    node_variable_values: HashMap<String, BTreeMap<String, String>>,
    node_working_dir_values: HashMap<String, String>,
    start_node_id: String,
    seed_input: Option<String>,
) -> Result<String, String> {
    let commands = storage_commands::resolve_map(pool.inner()).await?;

    workflow::execute_workflow_from(
        app,
        executor_state.inner().clone(),
        workflow_state.inner().clone(),
        workflow,
        commands,
        node_variable_values,
        node_working_dir_values,
        start_node_id,
        seed_input,
    )
    .await
}

#[tauri::command]
pub async fn cancel_workflow(
    workflow_state: State<'_, Arc<WorkflowExecutorState>>,
    run_id: String,
) -> Result<(), String> {
    workflow::cancel_workflow(workflow_state.inner().clone(), run_id).await
}
