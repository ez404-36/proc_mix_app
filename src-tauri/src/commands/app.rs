//! App-level / miscellaneous commands that do not belong to a single entity
//! domain: tray + platform, shell + utility-help introspection, output-schema
//! preview, JSON import/export, process env, .env-file management, and the
//! read-only "Environment" view snapshots.

use tauri::AppHandle;

use crate::core::shells;
use crate::platform::tray::{self, TrayLabels};
use crate::storage::commands as storage_commands;

#[tauri::command]
pub async fn update_tray_menu(app: AppHandle, labels: TrayLabels) -> Result<(), String> {
    tray::apply_labels(&app, &labels)
        .await
        .map_err(|e| e.to_string())
}

/// Returns the list of shell identifiers (matching the JS `Shell` union)
/// that resolve to an executable on the host PATH. The CRUD form on the
/// frontend uses this to filter the shell dropdown so users can't pick a
/// binary their system doesn't have.
#[tauri::command]
pub fn get_available_shells() -> Vec<String> {
    shells::detect_available_shells()
}

/// Fetch best-effort CLI help for `utility` so the CommandForm can show a
/// flag-hint tooltip beside the script field. The frontend extracts the
/// leading utility name from the script and validates it before calling;
/// the backend re-validates and only ever runs `<utility> --help` / `-h`
/// / `man` (never a shell). See `core::utility_help` for the security
/// model. An absent / unrecognised utility returns a `NotFound` result
/// rather than an error.
#[tauri::command]
pub async fn fetch_utility_help(
    utility: String,
) -> Result<crate::core::utility_help::UtilityHelp, String> {
    crate::core::utility_help::fetch_help(utility).await
}

/// Parse structured flag / positional-argument metadata from the raw
/// `--help` output of a utility. Fetches help text via `fetch_help`
/// (same security model and probes as `fetch_utility_help`) and runs the
/// heuristic `flag_parser::parse_flags` over it.
///
/// Returns an empty `ParsedCli` when the utility is not found or its help
/// text cannot be parsed — the frontend treats this as "no pre-fill
/// available" and falls back to the plain script editor.
#[tauri::command]
pub async fn parse_utility_flags(
    utility: String,
) -> Result<crate::core::flag_parser::ParsedCli, String> {
    let help = crate::core::utility_help::fetch_help(utility).await?;
    if help.status == crate::core::utility_help::UtilityHelpStatus::NotFound {
        return Ok(crate::core::flag_parser::ParsedCli {
            positional_args: vec![],
            flags: vec![],
        });
    }
    let text = help.text.unwrap_or_default();
    Ok(crate::core::flag_parser::parse_flags(&text))
}

/// Preview the result of running an output schema against a sample of
/// stdout, WITHOUT executing any command. The OutputSchemaEditor calls
/// this so the user can see the extracted fields / return value live as
/// they edit the schema. Parsing happens in the authoritative
/// `core::extractor` — the TS side never re-implements it.
///
/// Mirrors the `result` execution-event payload: on success `error` is
/// `None` and `fields` / `return_value` are populated; on a schema /
/// parse failure `error` carries the message and the other fields are
/// empty (the editor shows the error inline).
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewExtractionResult {
    pub fields: serde_json::Value,
    pub return_value: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[tauri::command]
pub fn preview_extraction(
    schema: storage_commands::OutputSchemaRecord,
    sample_stdout: String,
) -> PreviewExtractionResult {
    match crate::core::extractor::extract(&schema, &sample_stdout) {
        Ok(out) => PreviewExtractionResult {
            fields: serde_json::to_value(&out.fields).unwrap_or(serde_json::Value::Null),
            return_value: out.return_value,
            error: None,
        },
        Err(e) => PreviewExtractionResult {
            fields: serde_json::json!({}),
            return_value: serde_json::Value::Null,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
pub fn get_platform() -> String {
    if cfg!(target_os = "linux") {
        "linux".to_string()
    } else if cfg!(target_os = "macos") {
        "macos".to_string()
    } else if cfg!(target_os = "windows") {
        "windows".to_string()
    } else {
        "unknown".to_string()
    }
}

// ----------------------------------------------------------------------
// Import / Export.
//
// The JSON envelope is built, parsed and validated entirely in the TS
// layer (`utils/dataTransfer.ts`), where the `Command` / `Workflow` app
// types and their repositories already live. Rust's only job here is the
// native file dialog + raw file IO — it treats the document as an opaque
// String so the DTO shapes are never duplicated across the boundary.
//
// `rfd`'s dialog API is blocking; we run it on the blocking pool via
// `spawn_blocking` so it does not stall the async command runtime.
// ----------------------------------------------------------------------

/// Open a native "save" dialog and write `payload` (a JSON document
/// already serialized by the frontend) to the chosen path.
///
/// Returns `Ok(true)` when the file was written, `Ok(false)` when the
/// user cancelled the dialog. Filesystem errors surface as `Err(String)`
/// — never silently swallowed.
#[tauri::command]
pub async fn export_data(payload: String) -> Result<bool, String> {
    let path = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .add_filter("JSON", &["json"])
            .set_file_name("procmix-export.json")
            .save_file()
    })
    .await
    .map_err(|e| format!("file dialog task failed: {e}"))?;

    let Some(path) = path else {
        return Ok(false);
    };

    tokio::task::spawn_blocking(move || std::fs::write(&path, payload.as_bytes()))
        .await
        .map_err(|e| format!("write task failed: {e}"))?
        .map_err(|e| format!("write export file: {e}"))?;

    Ok(true)
}

/// Return a snapshot of the current process's environment variables.
///
/// Used by the frontend to detect key conflicts: when a command declares a
/// `Command.env` entry whose key already exists in the process environment,
/// the UI shows a warning that the command's value will override the
/// inherited one. The returned map is a point-in-time snapshot — environment
/// variables do not change at runtime for a GUI app, so the frontend caches
/// the result.
#[tauri::command]
pub async fn get_process_env() -> Result<std::collections::HashMap<String, String>, String> {
    Ok(std::env::vars().collect())
}

// --------------------------------------------------------------------------
// Env-file manager commands.
//
// These expose a simple config-file–backed list of .env file paths and
// per-file read/write/delete operations. The list is stored as a JSON array
// in `<app_config_dir>/env-files.json`. File content is read/written on the
// filesystem using `std::fs` (synchronous, but wrapped in spawn_blocking so
// the async executor is not blocked).
// --------------------------------------------------------------------------

/// Return the list of .env file paths currently registered in the config.
#[tauri::command]
pub async fn list_env_files(app: AppHandle) -> Result<Vec<String>, String> {
    crate::storage::env_config::load_env_file_paths(&app).await
}

/// Add a .env file path to the config list. Returns the updated list.
///
/// Holds the process-wide config lock for the whole load→mutate→save cycle so
/// a concurrent `add_env_file` / `remove_env_file` cannot clobber this update.
#[tauri::command]
pub async fn add_env_file(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    let _guard = crate::storage::env_config::lock_config().await;
    let mut paths = crate::storage::env_config::load_env_file_paths(&app).await?;
    if !paths.contains(&path) {
        paths.push(path);
        crate::storage::env_config::save_env_file_paths(&app, &paths).await?;
    }
    Ok(paths)
}

/// Remove a .env file path from the config list. Returns the updated list.
///
/// Holds the process-wide config lock for the whole load→mutate→save cycle so
/// a concurrent `add_env_file` / `remove_env_file` cannot clobber this update.
#[tauri::command]
pub async fn remove_env_file(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    let _guard = crate::storage::env_config::lock_config().await;
    let mut paths = crate::storage::env_config::load_env_file_paths(&app).await?;
    paths.retain(|p| p != &path);
    crate::storage::env_config::save_env_file_paths(&app, &paths).await?;
    Ok(paths)
}

/// Parse a .env file and return its entries (key/value/line).
///
/// Returns a summary that always succeeds at the IPC level; parse errors
/// are reported inside `EnvFileSummary.error` so the UI can surface them
/// inline without a full command failure.
#[tauri::command]
pub async fn read_env_file(path: String) -> Result<crate::core::env_files::EnvFileSummary, String> {
    let path_clone = path.clone();
    let result = tokio::task::spawn_blocking(move || {
        crate::core::env_files::parse_dotenv_file(std::path::Path::new(&path_clone))
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?;

    match result {
        Ok(entries) => Ok(crate::core::env_files::EnvFileSummary {
            path,
            entries,
            error: None,
        }),
        Err(msg) => Ok(crate::core::env_files::EnvFileSummary {
            path,
            entries: vec![],
            error: Some(msg),
        }),
    }
}

/// Update (or append) a single KEY=VALUE entry in a .env file.
///
/// Line-based: finds the existing `KEY=…` line and replaces only the value
/// part; if the key is not found, appends `KEY=VALUE` at the end. Comment
/// lines and blank lines are preserved verbatim.
#[tauri::command]
pub async fn write_env_file_entry(path: String, key: String, value: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        crate::core::env_files::write_entry(std::path::Path::new(&path), &key, &value)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

/// Remove a KEY line from a .env file.
///
/// Finds the line that declares KEY and removes it. Comment lines and blank
/// lines are preserved verbatim. If the key is not found the file is
/// unchanged and `Ok(())` is returned.
#[tauri::command]
pub async fn delete_env_file_entry(path: String, key: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        crate::core::env_files::delete_entry(std::path::Path::new(&path), &key)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

/// Open a native «open file» dialog filtered to .env files and return the
/// chosen path, or `None` when the user cancels.
#[tauri::command]
pub async fn pick_env_file() -> Result<Option<String>, String> {
    let path = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .add_filter(".env files", &["env", ""])
            .pick_file()
    })
    .await
    .map_err(|e| format!("file dialog task failed: {e}"))?;

    Ok(path.map(|p| p.to_string_lossy().into_owned()))
}

/// Open a native «open file» dialog with NO type filter and return the chosen
/// absolute path, or `None` when the user cancels. Used by Mini-App `path`
/// artifacts, which reference arbitrary files (not just .env), so the picked
/// value must be the full filesystem path — a browser `<input type="file">`
/// only exposes the file NAME inside the Tauri webview.
#[tauri::command]
pub async fn pick_artifact_path() -> Result<Option<String>, String> {
    let path = tokio::task::spawn_blocking(|| rfd::FileDialog::new().pick_file())
        .await
        .map_err(|e| format!("file dialog task failed: {e}"))?;

    Ok(path.map(|p| p.to_string_lossy().into_owned()))
}

// --------------------------------------------------------------------------
// "Environment" view: read-only snapshots with source detection.
//
// User snapshot is cheap (process env + reading a handful of small files) so
// it is computed on every call without caching at this layer — the frontend
// store handles UI-level memoisation. Root snapshot requires a stored admin
// password and reaches sudo, so the frontend gates the call behind
// `admin_password_status` (no surprise sudo prompts).
// --------------------------------------------------------------------------

/// Build the user-scope env snapshot: every variable in the current process
/// environment plus, for each known shell-startup file, the keys it assigns.
/// The result lets the UI render the "source" column without further IPC.
#[tauri::command]
pub async fn get_user_env_with_sources() -> Result<crate::core::env_sources::EnvSnapshot, String> {
    Ok(crate::core::env_sources::collect_user_snapshot().await)
}

/// Build the root-scope env snapshot. Requires a password stored in the OS
/// keychain (caller is expected to check `admin_password_status` first); when
/// none is stored we return an explicit `Err` so the UI can surface a "Enter
/// admin password" affordance rather than a generic IPC error.
///
/// The password is read from the keychain on this side and passed to a
/// `sudo -S env` invocation. The plaintext never leaves this function (the
/// IPC payload does NOT contain it), and the call times out so a hung sudo
/// cannot freeze the UI.
#[tauri::command]
pub async fn get_root_env_with_sources() -> Result<crate::core::env_sources::EnvSnapshot, String> {
    #[cfg(unix)]
    {
        let pw = match crate::security::admin_password::get() {
            Ok(Some(p)) => p,
            Ok(None) => return Err("ADMIN_PASSWORD_REQUIRED".to_string()),
            Err(e) => return Err(format!("keychain error: {e}")),
        };
        crate::core::env_sources::collect_root_snapshot(&pw).await
    }
    #[cfg(not(unix))]
    {
        Err("root snapshot is Unix-only".to_string())
    }
}

/// Open the Windows "System Properties → Environment Variables" dialog
/// (`SystemPropertiesAdvanced.exe`). On non-Windows this is a no-op that
/// returns `Ok(false)` so the frontend can hide the button when it would
/// have no effect.
#[tauri::command]
pub async fn open_windows_env_dialog() -> Result<bool, String> {
    #[cfg(windows)]
    {
        // We launch the system tool without arguments — it opens the
        // "System Properties" dialog, from which the user clicks
        // "Environment Variables…". A direct deep-link to the env page
        // does not exist in stable Windows APIs.
        match std::process::Command::new("SystemPropertiesAdvanced.exe").spawn() {
            Ok(_) => Ok(true),
            Err(e) => Err(format!("failed to launch SystemPropertiesAdvanced: {e}")),
        }
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

/// Open a native «open" dialog and read the chosen JSON file into a
/// String for the frontend to parse + validate.
///
/// Returns `Ok(Some(contents))` when a file was read, `Ok(None)` when the
/// user cancelled. Read errors surface as `Err(String)`.
#[tauri::command]
pub async fn import_data() -> Result<Option<String>, String> {
    let path = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .add_filter("JSON", &["json"])
            .pick_file()
    })
    .await
    .map_err(|e| format!("file dialog task failed: {e}"))?;

    let Some(path) = path else {
        return Ok(None);
    };

    let contents = tokio::task::spawn_blocking(move || std::fs::read_to_string(&path))
        .await
        .map_err(|e| format!("read task failed: {e}"))?
        .map_err(|e| format!("read import file: {e}"))?;

    Ok(Some(contents))
}
