//! The standalone "quick-launch prompt" dialog window (v0.12.0).
//!
//! When a tray / file-manager quick-launch targets a command that needs
//! interactive input (see `core::launch::command_needs_interaction`), we open a
//! small separate webview (`prompt.html`) instead of firing headlessly, so the
//! MAIN window never has to be shown. The dialog collects variable values and,
//! on Unix, a one-shot admin password, then submits them back here for a single
//! headless run recorded as a `quickLaunch` history event — exactly like the
//! non-interactive path.
//!
//! ## No extra fetch
//!
//! The backend already holds the loaded [`CommandRecord`] (the launch path
//! fetched it), so the pending request bundles everything the window needs:
//! the command's variable specs, the admin flag, and the shell context. The
//! window reads it once via [`get_quick_prompt_request`] and never calls back
//! for command data.
//!
//! ## Lifecycle
//!
//! 1. `open(app, pending)` stores the pending request and creates (or focuses)
//!    the `quick-prompt` window.
//! 2. The window mounts, calls `get_quick_prompt_request`, drives the prompts.
//! 3. `submit_quick_prompt(values, admin_password)` runs the command headless
//!    and clears the pending state; `cancel_quick_prompt` just clears it.
//! 4. The window closes itself either way.

use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder};

use crate::core::executor::ExecutorState;
use crate::core::launch::{self, LaunchSource, QuickPromptRequest, SELECTED_PATH_VAR};
use crate::storage::commands::CommandRecord;
use crate::storage::DbPool;

/// Window label of the quick-prompt dialog. A single instance at a time; a new
/// request while one is open focuses the existing window.
const QUICK_PROMPT_LABEL: &str = "quick-prompt";

/// The server-side pending quick-launch awaiting user input. Holds the FULL
/// command (so submit needs no re-fetch) plus the launch context. Distinct from
/// the serializable [`QuickPromptRequest`] sent to the window, which carries
/// only the non-secret subset the UI needs.
#[derive(Clone)]
pub struct PendingQuickPrompt {
    pub command: CommandRecord,
    /// Keychain-aware: whether the window must collect a one-shot admin
    /// password (decided once at launch by `resolve_command_launch`, so a saved
    /// keychain password means `false` and no password field is shown).
    pub needs_admin: bool,
    pub source: LaunchSource,
    pub selected_path: Option<String>,
    pub working_dir_override: Option<String>,
}

/// Managed state holding the single pending quick-prompt (if any).
#[derive(Default)]
pub struct QuickPromptState(Mutex<Option<PendingQuickPrompt>>);

impl QuickPromptState {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    fn set(&self, pending: PendingQuickPrompt) {
        if let Ok(mut guard) = self.0.lock() {
            *guard = Some(pending);
        }
    }

    fn take(&self) -> Option<PendingQuickPrompt> {
        self.0.lock().ok().and_then(|mut g| g.take())
    }

    fn peek(&self) -> Option<PendingQuickPrompt> {
        self.0.lock().ok().and_then(|g| g.clone())
    }

    fn clear(&self) {
        if let Ok(mut guard) = self.0.lock() {
            *guard = None;
        }
    }
}

/// Open (or focus) the quick-prompt dialog for a command that needs interactive
/// input. Stores `pending` in managed state, then builds a small always-on-top
/// dialog window loading `prompt.html`. Returns an error string if the window
/// fails to build (the caller logs it and falls back gracefully).
pub fn open<R: Runtime>(app: &AppHandle<R>, pending: PendingQuickPrompt) -> Result<(), String> {
    let state = app.state::<Arc<QuickPromptState>>();
    state.set(pending);

    // If a prompt window is already open, focus it rather than stacking a
    // second one (the new pending request replaces the old in state).
    if let Some(win) = app.get_webview_window(QUICK_PROMPT_LABEL) {
        let _ = win.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(
        app,
        QUICK_PROMPT_LABEL,
        WebviewUrl::App("prompt.html".into()),
    )
    .title("ProcMix")
    .inner_size(480.0, 340.0)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .always_on_top(true)
    .center()
    .skip_taskbar(true)
    .build()
    .map_err(|e| format!("failed to open quick-prompt window: {e}"))?;

    Ok(())
}

/// Read the pending quick-prompt request for the window to render. Returns the
/// serializable subset (no secrets); `None` if nothing is pending (e.g. the
/// window reloaded after submit). The window uses this to know what to ask.
#[tauri::command]
pub fn get_quick_prompt_request(
    state: State<'_, Arc<QuickPromptState>>,
) -> Option<QuickPromptRequest> {
    state.peek().map(|p| {
        QuickPromptRequest::from_command(
            &p.command,
            p.needs_admin,
            p.selected_path.clone(),
            p.working_dir_override.clone(),
        )
    })
}

/// Submit the collected values and run the command headlessly. `values` is the
/// per-run variable map the window assembled (prompt results); `admin_password`
/// is a one-shot sudo password (Unix elevation) — never persisted. Records the
/// `quickLaunch` history event and clears the pending state.
#[tauri::command]
pub async fn submit_quick_prompt<R: Runtime>(
    app: AppHandle<R>,
    pool: State<'_, DbPool>,
    executor_state: State<'_, Arc<ExecutorState>>,
    state: State<'_, Arc<QuickPromptState>>,
    values: std::collections::BTreeMap<String, String>,
    admin_password: Option<String>,
) -> Result<(), String> {
    let Some(pending) = state.take() else {
        // Nothing pending — a duplicate / stale submit. Treat as a no-op.
        return Ok(());
    };

    // Merge the shell-selected path into the value map under the reserved name
    // (the window may not have surfaced it as a prompt field) and — when the
    // command opted a variable in via `explorer_path_variable` — under that
    // named variable too. An explicit user-entered value for either name still
    // wins (`or_insert_with`).
    let mut variable_values = values;
    if let Some(ref path) = pending.selected_path {
        variable_values
            .entry(SELECTED_PATH_VAR.to_string())
            .or_insert_with(|| path.clone());
        if let Some(var) = pending
            .command
            .explorer_path_variable
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            variable_values
                .entry(var.to_string())
                .or_insert_with(|| path.clone());
        }
    }

    launch::fire_command_resolved(
        &app,
        pool.inner(),
        executor_state.inner(),
        &pending.command,
        pending.source,
        pending.selected_path,
        variable_values,
        pending.working_dir_override,
        admin_password,
    )
    .await;

    Ok(())
}

/// Cancel a pending quick-prompt: clear the state and record nothing. Called
/// when the user dismisses the dialog.
#[tauri::command]
pub fn cancel_quick_prompt(state: State<'_, Arc<QuickPromptState>>) -> Result<(), String> {
    state.clear();
    Ok(())
}
