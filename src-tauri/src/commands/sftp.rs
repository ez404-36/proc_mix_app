//! Tauri commands for the SFTP dual-pane file manager.
//!
//! These wrap `core::sftp` (which spawns the system `sftp` binary with a fixed
//! argv) and a local-directory lister (`std::fs`). The remote ops resolve the
//! bundled `procmix-askpass` helper from the Tauri `PathResolver` so a
//! password-authenticated host works in an installed app, falling back to the
//! `current_exe()`-sibling layout in dev.
//!
//! The alias and every remote path are validated inside `core::sftp` before any
//! child is spawned; these commands stay thin and surface the error string
//! (which carries the `INVALID_SFTP_TARGET:` / `INVALID_REMOTE_PATH:` sentinel
//! the JS side matches on).

use tauri::AppHandle;

use crate::core::sftp::{self, LocalEntry, LocalListing, SftpEntryKind, SftpListing};

/// Resolve the bundled `procmix-askpass` helper path for the password-auth
/// branch. `None` (the resolver couldn't find it, or non-Unix) makes
/// `core::sftp` fall back to the `current_exe()`-sibling layout.
#[cfg(unix)]
fn askpass_resource_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path()
        .resolve("procmix-askpass", tauri::path::BaseDirectory::Resource)
        .ok()
}

#[cfg(not(unix))]
fn askpass_resource_path(_app: &AppHandle) -> Option<std::path::PathBuf> {
    None
}

/// List a remote directory over SFTP.
#[tauri::command]
pub async fn sftp_list_dir(
    app: AppHandle,
    alias: String,
    path: String,
) -> Result<SftpListing, String> {
    let resource = askpass_resource_path(&app);
    sftp::list_dir(&alias, &path, resource.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Download a remote file to a local path.
#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    alias: String,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    let resource = askpass_resource_path(&app);
    sftp::download(&alias, &remote_path, &local_path, resource.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Upload a local file to a remote path.
#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    alias: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    let resource = askpass_resource_path(&app);
    sftp::upload(&alias, &local_path, &remote_path, resource.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Delete a remote entry. `is_dir` selects `rmdir` vs `rm`.
#[tauri::command]
pub async fn sftp_delete(
    app: AppHandle,
    alias: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let resource = askpass_resource_path(&app);
    sftp::remove(&alias, &path, is_dir, resource.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Rename/move a remote entry.
#[tauri::command]
pub async fn sftp_rename(
    app: AppHandle,
    alias: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let resource = askpass_resource_path(&app);
    sftp::rename(&alias, &from, &to, resource.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// Create a remote directory.
#[tauri::command]
pub async fn sftp_mkdir(app: AppHandle, alias: String, path: String) -> Result<(), String> {
    let resource = askpass_resource_path(&app);
    sftp::mkdir(&alias, &path, resource.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// List a LOCAL directory (the left pane) via `std::fs`.
///
/// Reads `path` directly; an unreadable directory (permission denied, not a
/// directory, missing) surfaces the IO error. Entries that fail to stat are
/// skipped rather than failing the whole listing. `.`/`..` are not emitted (the
/// reader doesn't yield them), and entries are returned unsorted — the UI
/// sorts (dirs first, then by name).
#[tauri::command]
pub async fn list_local_dir(path: String) -> Result<LocalListing, String> {
    // `std::fs::read_dir` is blocking; run it off the async runtime so a slow
    // disk can't stall other IPC handlers.
    tokio::task::spawn_blocking(move || read_local_dir(&path))
        .await
        .map_err(|e| format!("local listing task failed: {e}"))?
        .map_err(|e| e.to_string())
}

/// Delete a LOCAL entry. `is_dir` selects a recursive directory removal vs a
/// single-file removal, mirroring the remote `sftp_delete` shape.
///
/// Runs off the async runtime (`std::fs` is blocking). A missing/permission
/// error surfaces the IO message. Deleting a directory is **recursive**
/// (`remove_dir_all`) to match the user's expectation of "delete this folder"
/// from the file manager; a file uses `remove_file`.
#[tauri::command]
pub async fn local_delete(path: String, is_dir: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let result = if is_dir {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        result.map_err(|e| sftp::SftpError::LocalIo(e.to_string()))
    })
    .await
    .map_err(|e| format!("local delete task failed: {e}"))?
    .map_err(|e| e.to_string())
}

/// Rename/move a LOCAL entry from `from` to `to` (both absolute local paths).
///
/// Uses `std::fs::rename`, which also serves as a local→local MOVE when `to`
/// is in a different directory (it is atomic within one filesystem; across
/// filesystems the OS returns an error, which is surfaced rather than silently
/// falling back to a copy).
#[tauri::command]
pub async fn local_rename(from: String, to: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        std::fs::rename(&from, &to).map_err(|e| sftp::SftpError::LocalIo(e.to_string()))
    })
    .await
    .map_err(|e| format!("local rename task failed: {e}"))?
    .map_err(|e| e.to_string())
}

/// Create a LOCAL directory at `path`.
///
/// Uses `create_dir` (not `create_dir_all`): the parent must exist, matching
/// "new folder here" from the file manager and surfacing a clear error if the
/// caller passed a path whose parent is missing.
#[tauri::command]
pub async fn local_mkdir(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir(&path).map_err(|e| sftp::SftpError::LocalIo(e.to_string()))
    })
    .await
    .map_err(|e| format!("local mkdir task failed: {e}"))?
    .map_err(|e| e.to_string())
}

fn read_local_dir(path: &str) -> Result<LocalListing, sftp::SftpError> {
    let read = std::fs::read_dir(path).map_err(|e| sftp::SftpError::LocalIo(e.to_string()))?;
    let mut entries = Vec::new();
    for item in read {
        let Ok(dir_entry) = item else { continue };
        let Ok(file_type) = dir_entry.file_type() else {
            continue;
        };
        let name = dir_entry.file_name().to_string_lossy().into_owned();
        let kind = if file_type.is_dir() {
            SftpEntryKind::Dir
        } else if file_type.is_symlink() {
            SftpEntryKind::Symlink
        } else {
            SftpEntryKind::File
        };
        // Size is best-effort (a broken symlink or a race can fail the stat).
        let size = dir_entry.metadata().ok().map(|m| m.len());
        entries.push(LocalEntry { name, kind, size });
    }
    Ok(LocalListing {
        path: path.to_string(),
        entries,
    })
}
