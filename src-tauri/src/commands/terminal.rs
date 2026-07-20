//! Interactive Terminal commands.
//!
//! Thin `#[tauri::command]` wrappers over `core::terminal::session`. See
//! `core::terminal` module docs and `docs/interactive-terminal.md` for why
//! this is a deliberately separate feature from the sandboxed command
//! executor (`core::executor`) — nothing here runs a saved/templated script,
//! elevates, or redacts output; it opens a real interactive shell the user
//! types into directly.
//!
//! Not reachable from `core::http_server` (REST/API) or the scheduler /
//! workflow runner — every call originates from the frontend Terminal UI.

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::core::terminal::{self, TerminalState};

/// Spawn a new interactive terminal session. `shell` overrides the platform
/// default program (e.g. a specific shell picked in a future session
/// picker); `cwd` overrides the starting directory (falls back to the
/// user's home directory when absent or not an existing directory). Returns
/// the new session id, which the frontend uses to route
/// `terminal-event`s and to call `terminal_write`/`terminal_resize`/
/// `terminal_close`.
#[tauri::command]
pub async fn terminal_spawn(
    app: AppHandle,
    state: State<'_, Arc<TerminalState>>,
    shell: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || terminal::spawn_session(app, state, shell, cwd))
        .await
        .map_err(|e| format!("terminal spawn task panicked: {e}"))?
}

/// Write raw bytes (the user's keystrokes, or a paste) to a session's PTY.
#[tauri::command]
pub async fn terminal_write(
    state: State<'_, Arc<TerminalState>>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    terminal::write_to_session(state.inner(), &session_id, data.as_bytes())
}

/// Resize a session's PTY to the given terminal cell dimensions.
#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, Arc<TerminalState>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    terminal::resize_session(state.inner(), &session_id, cols, rows)
}

/// Close a terminal session (kills the child shell). Idempotent — closing an
/// already-exited session is a no-op, not an error.
#[tauri::command]
pub async fn terminal_close(
    state: State<'_, Arc<TerminalState>>,
    session_id: String,
) -> Result<(), String> {
    terminal::close_session(state.inner(), &session_id)
}
