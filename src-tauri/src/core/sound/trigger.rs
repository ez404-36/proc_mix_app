//! Run-completion sound trigger.
//!
//! A single entry point, [`play_outcome`], that every terminal-status site
//! calls to (maybe) play a notification sound: the command executor's terminal
//! path, `core::launch` (tray/shell quick-launch), and the Scheduler's fire
//! path. Centralising it here guarantees all three resolve the sound the same
//! way (via [`resolve::resolve_outcome_sound`]) instead of duplicating the
//! per-outcome logic.
//!
//! Everything here is best-effort and non-blocking: it loads the global
//! settings + custom-sound filename, resolves the sound id → path, and hands
//! off to `play_file` (which spawns the blocking playback). Any failure —
//! including a disabled/absent configuration, an unknown id, or a DB error —
//! results in silence, never a propagated error, so a run's outcome is never
//! affected by its notification sound.

use tauri::{AppHandle, Manager, Runtime};

use crate::core::sound::{self, resolve::Outcome};
use crate::storage::sound::{self as store, EntitySoundConfig};
use crate::storage::DbPool;

/// Resolve and play the notification sound for a finished run, if the
/// resolution rules say one should play. `entity` is the command's / workflow's
/// per-entity `sound` override (already loaded by the caller); `outcome` is the
/// terminal success/error status.
///
/// Loads the pool from app state; if none is managed yet (very early startup),
/// it is a silent no-op. Never blocks the caller — playback is spawned.
pub async fn play_outcome<R: Runtime>(
    app: &AppHandle<R>,
    entity: Option<&EntitySoundConfig>,
    outcome: Outcome,
) {
    // A managed pool is required to read settings / resolve custom ids. Absent
    // only during very early startup — treat as "no sound".
    let Some(pool) = app.try_state::<DbPool>() else {
        return;
    };
    let pool = pool.inner().clone();

    let settings = match store::get_settings(&pool).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(target: "procmix::sound", "load sound settings: {e}");
            return;
        }
    };

    let Some(sound_id) = sound::resolve::resolve_outcome_sound(entity, &settings, outcome) else {
        return; // resolution says: silent
    };

    // Resolve the id → path. Built-ins need only the resource dir; a custom id
    // needs its stored filename from the DB.
    let custom = match store::find_custom(&pool, &sound_id).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(target: "procmix::sound", "lookup custom sound: {e}");
            return;
        }
    };

    let resource_dir = match app.path().resource_dir() {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(target: "procmix::sound", "resolve resource_dir: {e}");
            return;
        }
    };
    let custom_dir = match app.path().app_data_dir() {
        Ok(d) => d.join("sounds"),
        Err(e) => {
            tracing::warn!(target: "procmix::sound", "resolve app_data_dir: {e}");
            return;
        }
    };

    if let Some(path) = sound::resolve::resolve_path(&sound_id, &resource_dir, &custom_dir, |_| {
        custom.map(|c| c.stored_filename)
    }) {
        sound::play_file(path, settings.volume);
    }
}

/// Map a boolean success flag to an [`Outcome`]. A small convenience for the
/// trigger sites, which mostly know "did it succeed" as a bool.
pub fn outcome_of(success: bool) -> Outcome {
    if success {
        Outcome::Success
    } else {
        Outcome::Error
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outcome_of_maps_bool() {
        assert_eq!(outcome_of(true), Outcome::Success);
        assert_eq!(outcome_of(false), Outcome::Error);
    }
}
