//! Sound-notification data types + SQLite persistence.
//!
//! This module owns three things:
//!   - the shared serde types (`EntitySoundConfig`, `SoundOutcomeConfig`,
//!     `SoundSettings`, `SoundDescriptor`) that mirror `src/types/sound.ts`;
//!   - the global `sound_settings` singleton row (master on/off + fallback
//!     success/error sound + volume), **disabled by default**;
//!   - the `custom_sounds` table listing user-uploaded sounds (metadata only —
//!     the audio files live under `<app_data>/sounds/`).
//!
//! The per-entity override (`EntitySoundConfig`) is NOT stored here — it rides
//! on the `commands.sound_config` / `workflows.sound_config` JSON columns via
//! the command/workflow records. Only the GLOBAL settings and the custom-sound
//! library have their own tables.

use sqlx::Row;

use crate::storage::DbPool;

/// Per-outcome sound configuration: whether a cue plays for this outcome and,
/// if so, which sound. Mirrors the TS `SoundOutcomeConfig`.
///
/// `sound_id` semantics: `Some(id)` → play that specific sound; `None` → play
/// the global default sound for this outcome.
///
/// `enabled` semantics relative to the global default: `true` → play (using
/// `sound_id` or the global default), even when the global master switch is
/// off; `false` → explicitly silent for this outcome, suppressing any global
/// default that would otherwise fire.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundOutcomeConfig {
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sound_id: Option<String>,
}

/// Per-entity sound override attached to a `Command` / `Workflow` (JSON column).
/// Both slots are optional: an absent slot inherits the global default for that
/// outcome, a present slot overrides it. Mirrors the TS `EntitySoundConfig`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntitySoundConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub success: Option<SoundOutcomeConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<SoundOutcomeConfig>,
}

/// Global fallback sound settings (single-row `sound_settings` table).
/// **Disabled by default**: `get_settings` returns `enabled: false` when no row
/// exists, so nothing plays until the user opts in.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundSettings {
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub success_sound_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_sound_id: Option<String>,
    pub volume: f32,
}

impl Default for SoundSettings {
    fn default() -> Self {
        // Off by default; a sensible mid volume for when the user enables it.
        Self {
            enabled: false,
            success_sound_id: None,
            error_sound_id: None,
            volume: 0.8,
        }
    }
}

/// Whether a selectable sound is a bundled built-in or a user upload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SoundKind {
    Builtin,
    Custom,
}

/// A selectable sound surfaced by `list_sounds`: the built-in tones plus every
/// user-uploaded custom sound. Mirrors the TS `SoundDescriptor`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundDescriptor {
    pub id: String,
    pub label: String,
    pub kind: SoundKind,
}

/// One user-uploaded custom sound's metadata (the `custom_sounds` table). The
/// audio bytes live at `<app_data>/sounds/<stored_filename>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomSound {
    pub id: String,
    pub original_name: String,
    pub stored_filename: String,
    pub created_at: String,
}

// ---- Global settings (single row keyed id = 'global') ----------------------

const SETTINGS_ROW_ID: &str = "global";

/// Load the global sound settings, or the (disabled) default when no row
/// exists yet. Always succeeds with a value so callers never special-case
/// first-run.
pub async fn get_settings(pool: &DbPool) -> Result<SoundSettings, String> {
    let row = sqlx::query(
        "SELECT enabled, success_sound_id, error_sound_id, volume \
         FROM sound_settings WHERE id = ?1",
    )
    .bind(SETTINGS_ROW_ID)
    .fetch_optional(pool.as_ref())
    .await
    .map_err(|e| format!("load sound_settings: {e}"))?;

    let Some(row) = row else {
        return Ok(SoundSettings::default());
    };

    let enabled: i64 = row
        .try_get("enabled")
        .map_err(|e| format!("read enabled: {e}"))?;
    let success_sound_id: Option<String> = row
        .try_get("success_sound_id")
        .map_err(|e| format!("read success_sound_id: {e}"))?;
    let error_sound_id: Option<String> = row
        .try_get("error_sound_id")
        .map_err(|e| format!("read error_sound_id: {e}"))?;
    let volume: f64 = row
        .try_get("volume")
        .map_err(|e| format!("read volume: {e}"))?;

    Ok(SoundSettings {
        enabled: enabled != 0,
        success_sound_id,
        error_sound_id,
        volume: volume as f32,
    })
}

/// Upsert the global sound settings singleton.
pub async fn set_settings(pool: &DbPool, settings: &SoundSettings) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO sound_settings (id, enabled, success_sound_id, error_sound_id, volume) \
         VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(id) DO UPDATE SET \
           enabled = excluded.enabled, \
           success_sound_id = excluded.success_sound_id, \
           error_sound_id = excluded.error_sound_id, \
           volume = excluded.volume",
    )
    .bind(SETTINGS_ROW_ID)
    .bind(i64::from(settings.enabled))
    .bind(settings.success_sound_id.as_deref())
    .bind(settings.error_sound_id.as_deref())
    .bind(f64::from(settings.volume))
    .execute(pool.as_ref())
    .await
    .map_err(|e| format!("save sound_settings: {e}"))?;
    Ok(())
}

// ---- Custom sound library --------------------------------------------------

/// List every custom sound, oldest first.
pub async fn list_custom(pool: &DbPool) -> Result<Vec<CustomSound>, String> {
    let rows = sqlx::query(
        "SELECT id, original_name, stored_filename, created_at \
         FROM custom_sounds ORDER BY created_at ASC",
    )
    .fetch_all(pool.as_ref())
    .await
    .map_err(|e| format!("list custom_sounds: {e}"))?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(CustomSound {
            id: row.try_get("id").map_err(|e| format!("read id: {e}"))?,
            original_name: row
                .try_get("original_name")
                .map_err(|e| format!("read original_name: {e}"))?,
            stored_filename: row
                .try_get("stored_filename")
                .map_err(|e| format!("read stored_filename: {e}"))?,
            created_at: row
                .try_get("created_at")
                .map_err(|e| format!("read created_at: {e}"))?,
        });
    }
    Ok(out)
}

/// Look up one custom sound by id.
pub async fn find_custom(pool: &DbPool, id: &str) -> Result<Option<CustomSound>, String> {
    let row = sqlx::query(
        "SELECT id, original_name, stored_filename, created_at \
         FROM custom_sounds WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(pool.as_ref())
    .await
    .map_err(|e| format!("find custom_sound: {e}"))?;

    let Some(row) = row else { return Ok(None) };
    Ok(Some(CustomSound {
        id: row.try_get("id").map_err(|e| format!("read id: {e}"))?,
        original_name: row
            .try_get("original_name")
            .map_err(|e| format!("read original_name: {e}"))?,
        stored_filename: row
            .try_get("stored_filename")
            .map_err(|e| format!("read stored_filename: {e}"))?,
        created_at: row
            .try_get("created_at")
            .map_err(|e| format!("read created_at: {e}"))?,
    }))
}

/// Insert a custom-sound metadata row.
pub async fn insert_custom(pool: &DbPool, sound: &CustomSound) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO custom_sounds (id, original_name, stored_filename, created_at) \
         VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(&sound.id)
    .bind(&sound.original_name)
    .bind(&sound.stored_filename)
    .bind(&sound.created_at)
    .execute(pool.as_ref())
    .await
    .map_err(|e| format!("insert custom_sound: {e}"))?;
    Ok(())
}

/// Delete a custom-sound metadata row. Idempotent — a missing id is not an
/// error. Returns the deleted row's stored filename (if any) so the caller can
/// remove the file on disk.
pub async fn delete_custom(pool: &DbPool, id: &str) -> Result<Option<String>, String> {
    let existing = find_custom(pool, id).await?;
    sqlx::query("DELETE FROM custom_sounds WHERE id = ?1")
        .bind(id)
        .execute(pool.as_ref())
        .await
        .map_err(|e| format!("delete custom_sound: {e}"))?;
    Ok(existing.map(|s| s.stored_filename))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use std::sync::Arc;

    async fn test_pool() -> DbPool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory db");
        sqlx::query(
            "CREATE TABLE sound_settings (
               id               TEXT PRIMARY KEY NOT NULL,
               enabled          INTEGER NOT NULL DEFAULT 0,
               success_sound_id TEXT,
               error_sound_id   TEXT,
               volume           REAL NOT NULL DEFAULT 0.8
             )",
        )
        .execute(&pool)
        .await
        .expect("create sound_settings");
        sqlx::query(
            "CREATE TABLE custom_sounds (
               id              TEXT PRIMARY KEY NOT NULL,
               original_name   TEXT NOT NULL,
               stored_filename TEXT NOT NULL,
               created_at      TEXT NOT NULL
             )",
        )
        .execute(&pool)
        .await
        .expect("create custom_sounds");
        Arc::new(pool)
    }

    #[tokio::test]
    async fn settings_default_is_disabled_when_absent() {
        let pool = test_pool().await;
        let s = get_settings(&pool).await.unwrap();
        assert!(!s.enabled, "global sound must be OFF by default");
        assert_eq!(s.success_sound_id, None);
        assert_eq!(s.error_sound_id, None);
    }

    #[tokio::test]
    async fn settings_round_trip() {
        let pool = test_pool().await;
        let want = SoundSettings {
            enabled: true,
            success_sound_id: Some("builtin:success".into()),
            error_sound_id: Some("custom-1".into()),
            volume: 0.5,
        };
        set_settings(&pool, &want).await.unwrap();
        let got = get_settings(&pool).await.unwrap();
        assert_eq!(got, want);
    }

    #[tokio::test]
    async fn settings_upsert_replaces_single_row() {
        let pool = test_pool().await;
        set_settings(
            &pool,
            &SoundSettings {
                enabled: true,
                volume: 0.3,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        set_settings(
            &pool,
            &SoundSettings {
                enabled: false,
                volume: 0.9,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let got = get_settings(&pool).await.unwrap();
        assert!(!got.enabled);
        assert!((got.volume - 0.9).abs() < f32::EPSILON);
        // Only one settings row exists.
        let n: i64 = sqlx::query("SELECT COUNT(*) AS c FROM sound_settings")
            .fetch_one(pool.as_ref())
            .await
            .unwrap()
            .get("c");
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn custom_sound_insert_list_delete() {
        let pool = test_pool().await;
        let sound = CustomSound {
            id: "uuid-1".into(),
            original_name: "alarm.wav".into(),
            stored_filename: "uuid-1.wav".into(),
            created_at: "2026-07-04T00:00:00Z".into(),
        };
        insert_custom(&pool, &sound).await.unwrap();

        let all = list_custom(&pool).await.unwrap();
        assert_eq!(all, vec![sound.clone()]);

        let removed = delete_custom(&pool, "uuid-1").await.unwrap();
        assert_eq!(removed.as_deref(), Some("uuid-1.wav"));
        assert!(list_custom(&pool).await.unwrap().is_empty());

        // Deleting a missing id is a no-op returning None.
        assert_eq!(delete_custom(&pool, "nope").await.unwrap(), None);
    }

    #[test]
    fn entity_sound_config_serialises_camel_case_and_skips_none() {
        let cfg = EntitySoundConfig {
            success: Some(SoundOutcomeConfig {
                enabled: true,
                sound_id: Some("x".into()),
            }),
            error: None,
        };
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("\"success\""));
        assert!(json.contains("\"soundId\":\"x\""));
        // `error` is None → skipped entirely.
        assert!(!json.contains("\"error\""));
    }

    #[test]
    fn outcome_config_without_sound_id_omits_the_key() {
        let slot = SoundOutcomeConfig {
            enabled: false,
            sound_id: None,
        };
        let json = serde_json::to_string(&slot).unwrap();
        assert_eq!(json, "{\"enabled\":false}");
    }
}
