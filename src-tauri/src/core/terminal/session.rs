// Session lifecycle for the interactive Terminal feature: spawn, write,
// resize, close, and app-shutdown teardown.
//
// Unlike `core::executor`, which owns the child's stdout/stderr as tokio
// pipes and reads them line-by-line on the tokio runtime, a PTY read is a
// long-lived BLOCKING read on a native fd/handle with no natural
// cancellation point. It therefore runs on a plain OS thread
// (`std::thread::spawn`), never `tokio::task::spawn_blocking` — the tokio
// blocking pool is sized for short-lived blocking calls and reserving one of
// its threads for the entire lifetime of a terminal tab (which can be left
// open indefinitely) would starve it under enough concurrent sessions.

use std::io::{Read, Write as _};
use std::sync::{Arc, Mutex};

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter, Runtime};
use uuid::Uuid;

use super::types::{
    TerminalEvent, TerminalSessionHandle, TerminalState, MAX_TERMINAL_SESSIONS, TERMINAL_EVENT,
};

/// Size in bytes of each blocking PTY read. Chunked (not line-buffered) —
/// interactive programs (vim, htop, a shell prompt) rely on partial writes
/// with no trailing newline reaching the terminal immediately.
const READ_CHUNK_BYTES: usize = 8192;

/// Emit a `terminal-event`, logging (but not failing on) a transport error.
/// Mirrors `core::executor::emit_event`.
fn emit_event<R: Runtime>(app: &AppHandle<R>, event: &TerminalEvent) {
    if let Err(err) = app.emit(TERMINAL_EVENT, event) {
        tracing::error!("failed to emit terminal event: {err}");
    }
}

/// Build the `CommandBuilder` for a NEW interactive session.
///
/// When `shell` is absent/blank (the common case — no override picked in
/// the UI), this uses `CommandBuilder::new_default_prog()`: `portable-pty`'s
/// OWN login-shell resolution, which reads `$SHELL` (falling back to the
/// password-database entry on Unix, `ComSpec`/`cmd.exe` on Windows) and
/// spawns it directly via `std::process::Command::new` — bypassing
/// `portable-pty`'s PATH search entirely, so it doesn't matter whether
/// `$SHELL` is an absolute path or a bare name. It also prefixes argv[0]
/// with `-` internally so the shell behaves as a LOGIN shell (reads
/// `.profile`/`.zprofile` etc.), matching what a real terminal emulator
/// launches — WE MUST NOT replicate that prefixing ourselves: mutating
/// argv[0] on a `CommandBuilder::new(program)` builder breaks resolution,
/// because `portable-pty`'s Unix PATH search resolves the executable FROM
/// argv[0] itself (see `search_path` in `cmdbuilder.rs`) — a builder whose
/// argv[0] we rewrote to `-bash` would search PATH for a file literally
/// named `-bash` and fail with "No viable candidates found in PATH", which
/// is the exact bug this comment exists to prevent regressing.
///
/// When `shell` IS supplied (a future shell-picker override), we fall back
/// to `CommandBuilder::new(shell)` — ordinary PATH/absolute-path resolution,
/// argv[0] left untouched, no login-shell prefixing (an explicit override is
/// a one-off program name, not necessarily even a login-capable shell).
fn build_shell_command(shell: Option<&str>) -> CommandBuilder {
    match shell.filter(|s| !s.trim().is_empty()) {
        Some(s) => CommandBuilder::new(s),
        None => CommandBuilder::new_default_prog(),
    }
}

/// Resolve the working directory for a NEW session: the caller-supplied
/// `cwd` when it is an existing directory, otherwise the user's home
/// directory. A caller-supplied path that does not exist is silently
/// ignored (falls back to home) rather than failing the spawn — this is a
/// convenience default, not a security boundary (the user picks their own
/// terminal's starting directory).
fn resolve_cwd(cwd: Option<&str>) -> Option<std::path::PathBuf> {
    if let Some(dir) = cwd.filter(|s| !s.trim().is_empty()) {
        let path = std::path::PathBuf::from(dir);
        if path.is_dir() {
            return Some(path);
        }
    }
    dirs::home_dir()
}

/// Spawn a new interactive PTY session and register it in `state`.
///
/// Returns the generated session id, which the caller (the Tauri command)
/// hands back to the frontend and which tags every subsequent `terminal-event`
/// and every `write_to_session` / `resize_session` / `close_session` call.
pub fn spawn_session<R: Runtime>(
    app: AppHandle<R>,
    state: Arc<TerminalState>,
    shell: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "terminal session registry lock poisoned".to_string())?;
        if sessions.len() >= MAX_TERMINAL_SESSIONS {
            return Err(format!(
                "too many open terminal sessions (max {MAX_TERMINAL_SESSIONS})"
            ));
        }
    }

    let session_id = Uuid::new_v4().to_string();
    let working_dir = resolve_cwd(cwd.as_deref());

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("failed to open pty: {e}"))?;

    let mut cmd = build_shell_command(shell.as_deref());
    if let Some(dir) = working_dir {
        cmd.cwd(dir);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to spawn shell: {e}"))?;
    // The slave end belongs to the child now; dropping our copy does not
    // affect the child (portable-pty's slave holds its own duplicated fd
    // internally until the child exits on Unix, and is a distinct handle on
    // Windows), but we must NOT keep it open past this point or some
    // backends never see EOF on the master when the child exits.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("failed to clone pty reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("failed to take pty writer: {e}"))?;

    let reader_app = app.clone();
    let reader_session_id = session_id.clone();
    let reader_state = state.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; READ_CHUNK_BYTES];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let encoded = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    emit_event(
                        &reader_app,
                        &TerminalEvent::Data {
                            session_id: reader_session_id.clone(),
                            data: encoded,
                        },
                    );
                }
                Err(_) => break,
            }
        }

        // Reap the child now that the PTY closed (EOF), so we can report its
        // exit code and are not left waiting on a zombie. `try_wait`-style
        // polling is unnecessary here — the EOF on the master read means the
        // slave side is fully closed, so `wait()` should return promptly.
        let exit_code = {
            let mut sessions = match reader_state.sessions.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            match sessions.remove(&reader_session_id) {
                Some(mut handle) => handle.child.wait().ok().map(|status| status.exit_code()),
                None => None,
            }
        };
        emit_event(
            &reader_app,
            &TerminalEvent::Exit {
                session_id: reader_session_id,
                exit_code,
            },
        );
    });

    {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "terminal session registry lock poisoned".to_string())?;
        sessions.insert(
            session_id.clone(),
            TerminalSessionHandle {
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
                child,
            },
        );
    }

    Ok(session_id)
}

/// Write raw bytes to a session's PTY master (i.e. deliver them to the
/// child's stdin). Errors when the session is unknown (already closed/exited)
/// or the underlying write fails.
pub fn write_to_session(
    state: &TerminalState,
    session_id: &str,
    data: &[u8],
) -> Result<(), String> {
    let writer = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "terminal session registry lock poisoned".to_string())?;
        let handle = sessions
            .get(session_id)
            .ok_or_else(|| format!("unknown terminal session: {session_id}"))?;
        handle.writer.clone()
    };
    let mut writer = writer
        .lock()
        .map_err(|_| "terminal session writer lock poisoned".to_string())?;
    writer
        .write_all(data)
        .and_then(|_| writer.flush())
        .map_err(|e| format!("failed to write to terminal session: {e}"))
}

/// Resize a session's PTY to the given terminal dimensions (in character
/// cells). Called when the frontend's `FitAddon` recomputes the fit.
pub fn resize_session(
    state: &TerminalState,
    session_id: &str,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "terminal session registry lock poisoned".to_string())?;
    let handle = sessions
        .get(session_id)
        .ok_or_else(|| format!("unknown terminal session: {session_id}"))?;
    handle
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("failed to resize terminal session: {e}"))
}

/// Close a session: kill the child process and drop its PTY handle. The
/// registry removal races the reader thread's own removal-on-EOF (both use
/// `remove`, which is idempotent), so calling this on an already-exited
/// session is a harmless no-op rather than an error — mirrors
/// `core::executor::cancel_execution`'s idempotent-cancel contract.
pub fn close_session(state: &TerminalState, session_id: &str) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "terminal session registry lock poisoned".to_string())?;
    if let Some(mut handle) = sessions.remove(session_id) {
        let _ = handle.child.kill();
    }
    Ok(())
}

/// Synchronously kill every live session's child process. Called from the
/// Tauri exit hook (`RunEvent::ExitRequested`), mirroring
/// `core::executor::shutdown_all_sync` — must not be async, must not depend
/// on the reader threads noticing (they are daemon-like OS threads that die
/// with the process on hard exit anyway).
pub fn shutdown_all_sync(state: &TerminalState) {
    let mut sessions = match state.sessions.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    for (_id, mut handle) in sessions.drain() {
        let _ = handle.child.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_shell_command_falls_back_to_default_prog_on_blank_and_none() {
        assert!(build_shell_command(None).is_default_prog());
        assert!(build_shell_command(Some("")).is_default_prog());
        assert!(build_shell_command(Some("   ")).is_default_prog());
    }

    #[test]
    fn build_shell_command_honours_override() {
        let cmd = build_shell_command(Some("/bin/zsh"));
        assert!(!cmd.is_default_prog());
        assert_eq!(cmd.get_argv()[0], std::ffi::OsString::from("/bin/zsh"));
    }

    #[test]
    fn resolve_cwd_falls_back_to_home_on_missing_dir() {
        let resolved = resolve_cwd(Some("/this/path/does/not/exist/procmix-test"));
        assert_eq!(resolved, dirs::home_dir());
    }

    #[test]
    fn resolve_cwd_falls_back_to_home_on_blank() {
        assert_eq!(resolve_cwd(Some("")), dirs::home_dir());
        assert_eq!(resolve_cwd(None), dirs::home_dir());
    }

    #[test]
    fn resolve_cwd_honours_existing_dir() {
        let tmp = std::env::temp_dir();
        assert_eq!(resolve_cwd(Some(tmp.to_str().unwrap())), Some(tmp));
    }

    /// The write/resize/close paths must return a clear error (not panic) for
    /// an id that was never registered — the frontend can race a close
    /// against an already-exited session.
    #[test]
    fn operations_on_unknown_session_return_errors_not_panics() {
        let state = TerminalState::new();
        assert!(write_to_session(&state, "nope", b"x").is_err());
        assert!(resize_session(&state, "nope", 80, 24).is_err());
        // close is intentionally idempotent/ok for an unknown id.
        assert!(close_session(&state, "nope").is_ok());
    }
}
