//! Tauri commands for the sound-notification feature.
//!
//! These wrap `storage::sound` (settings + custom-sound library) and
//! `core::sound` (playback + path resolution). All are desktop-only — the
//! `core::sound` module (and `rodio`) is compiled out on mobile, where sound
//! notifications are meaningless.
//!
//! Custom-sound files live under `<app_data>/sounds/`; built-in tones are
//! bundled resources resolved via `BaseDirectory::Resource`. Uploaded files are
//! validated against an extension allow-list and copied in (never referenced in
//! place) so a stable id keeps working if the original is moved or deleted.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};

use crate::core::sound;
use crate::storage::sound as store;
use crate::storage::DbPool;

/// Audio extensions we accept for a custom upload — the same formats
/// `core::sound` (via rodio/symphonia) can decode. Lower-case, no dot.
const ALLOWED_EXTENSIONS: &[&str] = &["wav", "mp3", "ogg", "flac"];

/// Resolve `<app_data>/sounds`, creating it if needed. Custom uploads live here.
fn custom_sounds_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?
        .join("sounds");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create sounds dir: {e}"))?;
    Ok(dir)
}

/// Resolve the bundled resource directory (holds `sounds/<stem>.wav`).
fn resource_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resource_dir()
        .map_err(|e| format!("resolve resource_dir: {e}"))
}

/// Resolve a sound id to a playable file path, consulting the custom-sound
/// table for non-built-in ids. Returns `None` for an unknown/dangling id.
async fn resolve_sound_path(
    app: &AppHandle,
    pool: &DbPool,
    id: &str,
) -> Result<Option<PathBuf>, String> {
    // Look up the custom filename up front (async), then resolve purely.
    let custom = store::find_custom(pool, id).await?;
    let res_dir = resource_dir(app)?;
    let custom_dir = custom_sounds_dir(app)?;
    Ok(sound::resolve::resolve_path(
        id,
        &res_dir,
        &custom_dir,
        |_| custom.map(|c| c.stored_filename),
    ))
}

/// Load the global sound settings (disabled by default).
#[tauri::command]
pub async fn get_sound_settings(pool: State<'_, DbPool>) -> Result<store::SoundSettings, String> {
    store::get_settings(pool.inner()).await
}

/// Persist the global sound settings.
#[tauri::command]
pub async fn set_sound_settings(
    pool: State<'_, DbPool>,
    settings: store::SoundSettings,
) -> Result<(), String> {
    store::set_settings(pool.inner(), &settings).await
}

/// List every selectable sound: the built-in tones followed by user uploads.
#[tauri::command]
pub async fn list_sounds(pool: State<'_, DbPool>) -> Result<Vec<store::SoundDescriptor>, String> {
    let mut out = sound::resolve::builtin_descriptors();
    for custom in store::list_custom(pool.inner()).await? {
        out.push(store::SoundDescriptor {
            id: custom.id,
            label: custom.original_name,
            kind: store::SoundKind::Custom,
        });
    }
    Ok(out)
}

/// Open a native file picker, validate the chosen file's extension against the
/// allow-list, copy it into `<app_data>/sounds/<uuid>.<ext>`, and record its
/// metadata. Returns the new sound's descriptor, or `None` if the user
/// cancelled the dialog.
#[tauri::command]
pub async fn import_custom_sound(
    app: AppHandle,
    pool: State<'_, DbPool>,
) -> Result<Option<store::SoundDescriptor>, String> {
    // rfd's dialog is blocking — run it off the async runtime.
    let picked = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .add_filter("Audio", ALLOWED_EXTENSIONS)
            .pick_file()
    })
    .await
    .map_err(|e| format!("file dialog task failed: {e}"))?;

    let Some(source_path) = picked else {
        return Ok(None); // user cancelled
    };

    // Validate the extension against the allow-list (case-insensitive). The
    // file is only ever decoded by the audio player, never executed — but we
    // still gate the format so an unsupported file can't be imported and then
    // silently fail to play.
    let ext = source_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "unsupported sound format '.{ext}' — allowed: {}",
            ALLOWED_EXTENSIONS.join(", ")
        ));
    }

    let original_name = source_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("sound")
        .to_string();

    let id = uuid::Uuid::new_v4().to_string();
    let stored_filename = format!("{id}.{ext}");
    let dest_dir = custom_sounds_dir(&app)?;
    let dest_path = dest_dir.join(&stored_filename);

    // Copy the bytes in (blocking IO off the async runtime).
    let dest_for_copy = dest_path.clone();
    tokio::task::spawn_blocking(move || std::fs::copy(&source_path, &dest_for_copy))
        .await
        .map_err(|e| format!("copy task failed: {e}"))?
        .map_err(|e| format!("copy sound file: {e}"))?;

    let record = store::CustomSound {
        id: id.clone(),
        original_name: original_name.clone(),
        stored_filename,
        created_at: chrono::Local::now().to_rfc3339(),
    };
    if let Err(e) = store::insert_custom(pool.inner(), &record).await {
        // Roll back the copied file so a failed insert doesn't orphan bytes.
        let _ = std::fs::remove_file(&dest_path);
        return Err(e);
    }

    Ok(Some(store::SoundDescriptor {
        id,
        label: original_name,
        kind: store::SoundKind::Custom,
    }))
}

/// Delete a custom sound: remove its file and metadata row, and clear any
/// GLOBAL settings slot that referenced it (a per-entity reference is handled
/// at resolution time — a dangling id degrades to silence). Idempotent.
#[tauri::command]
pub async fn delete_custom_sound(
    app: AppHandle,
    pool: State<'_, DbPool>,
    id: String,
) -> Result<(), String> {
    let removed_filename = store::delete_custom(pool.inner(), &id).await?;
    if let Some(filename) = removed_filename {
        let path = custom_sounds_dir(&app)?.join(filename);
        // Best-effort: a missing file is fine (already gone).
        let _ = std::fs::remove_file(path);
    }

    // Clear any global settings slot pointing at the deleted sound so the
    // settings never carry a dangling reference.
    let mut settings = store::get_settings(pool.inner()).await?;
    let mut changed = false;
    if settings.success_sound_id.as_deref() == Some(id.as_str()) {
        settings.success_sound_id = None;
        changed = true;
    }
    if settings.error_sound_id.as_deref() == Some(id.as_str()) {
        settings.error_sound_id = None;
        changed = true;
    }
    if changed {
        store::set_settings(pool.inner(), &settings).await?;
    }
    Ok(())
}

/// Play a sound by id for the Settings/editor preview buttons. Uses the global
/// volume. Best-effort: an unknown id or a playback failure is a silent no-op
/// (the underlying `play_file` logs and swallows device/decode errors).
#[tauri::command]
pub async fn preview_sound(
    app: AppHandle,
    pool: State<'_, DbPool>,
    id: String,
) -> Result<(), String> {
    let settings = store::get_settings(pool.inner()).await?;
    if let Some(path) = resolve_sound_path(&app, pool.inner(), &id).await? {
        sound::play_file(path, settings.volume);
    }
    Ok(())
}
