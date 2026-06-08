// Config-file–backed storage for the list of .env file paths.
//
// The list is persisted as a JSON array in
// `<app_config_dir>/env-files.json`. Reads and writes use synchronous
// `std::fs` wrapped in `tokio::task::spawn_blocking`.
//
// Concurrency (C2): every mutation is a read-modify-write of the whole file.
// To avoid a lost-update race between two concurrent `add`/`remove` calls, the
// mutating helpers serialise through a process-wide async `Mutex`. The write
// itself is atomic (write-to-temp + rename) so a crash mid-write cannot leave
// a truncated `env-files.json`.

use std::sync::OnceLock;

use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::Mutex;

const CONFIG_FILE: &str = "env-files.json";

/// Process-wide lock serialising read-modify-write cycles on `env-files.json`.
/// `add_env_file` / `remove_env_file` (in `commands/mod.rs`) acquire this for
/// the whole load→mutate→save sequence so concurrent calls cannot clobber
/// each other's update.
fn config_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Acquire the config mutation lock. Callers that perform a read-modify-write
/// (add/remove) must hold the returned guard for the entire sequence.
pub async fn lock_config() -> tokio::sync::MutexGuard<'static, ()> {
    config_lock().lock().await
}

/// Resolve the path to `env-files.json` inside the app config directory.
fn config_path<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolve app_config_dir: {e}"))?;
    Ok(dir.join(CONFIG_FILE))
}

/// Load the list of .env file paths from `env-files.json`.
///
/// Returns an empty `Vec` when the file does not exist yet (first run).
/// Any deserialization failure (corrupted file) returns an error.
pub async fn load_env_file_paths<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<String>, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = tokio::task::spawn_blocking(move || std::fs::read_to_string(&path))
        .await
        .map_err(|e| format!("spawn_blocking failed: {e}"))?
        .map_err(|e| format!("read env-files.json: {e}"))?;

    serde_json::from_str::<Vec<String>>(&contents).map_err(|e| format!("parse env-files.json: {e}"))
}

/// Persist the list of .env file paths to `env-files.json`.
///
/// Creates the parent directory if it does not exist. Writes atomically:
/// the JSON is written to a temporary file in the same directory and then
/// renamed over the target, so a reader never observes a partial file and a
/// crash mid-write leaves the previous version intact.
pub async fn save_env_file_paths<R: Runtime>(
    app: &AppHandle<R>,
    paths: &[String],
) -> Result<(), String> {
    let file_path = config_path(app)?;
    let json = serde_json::to_string(paths).map_err(|e| format!("serialize paths: {e}"))?;

    tokio::task::spawn_blocking(move || {
        let dir = file_path
            .parent()
            .ok_or_else(|| "config path has no parent directory".to_string())?;
        std::fs::create_dir_all(dir).map_err(|e| format!("create config dir: {e}"))?;
        write_atomic(&file_path, json.as_bytes())
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

/// Atomically write `bytes` to `target`: write to a sibling temp file, then
/// rename it over the target. Rename is atomic on the same filesystem, so a
/// concurrent reader sees either the old or the new content, never a partial
/// write. The temp file is best-effort cleaned up on a write error.
fn write_atomic(target: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let dir = target
        .parent()
        .ok_or_else(|| "target path has no parent directory".to_string())?;
    let file_name = target
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "target path has no file name".to_string())?;
    // Unique-enough temp name in the same directory (same filesystem → atomic
    // rename). The process id + a nanosecond timestamp avoids collisions
    // between concurrent writers.
    let tmp_name = format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let tmp_path = dir.join(tmp_name);

    std::fs::write(&tmp_path, bytes).map_err(|e| format!("write temp file: {e}"))?;
    if let Err(e) = std::fs::rename(&tmp_path, target) {
        // Clean up the orphaned temp file; ignore secondary errors.
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("rename temp file over target: {e}"));
    }
    Ok(())
}
