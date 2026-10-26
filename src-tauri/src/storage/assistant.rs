//! Storage for opt-in AI-assistant settings.
//!
//! Provider instances live in their own tables. This row keeps only global
//! opt-ins and the selected instance/model; API keys are keychain-only.

use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::storage::DbPool;

pub const DEFAULT_TIMEOUT_MS: u32 = 60_000;
pub const MIN_TIMEOUT_MS: u32 = 1_000;
pub const MAX_TIMEOUT_MS: u32 = 300_000;

/// Non-secret global assistant settings.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSettings {
    pub enabled: bool,
    pub timeout_ms: u32,
    pub active_provider_id: Option<String>,
    pub active_model_id: Option<String>,
    pub allow_run_snapshots: bool,
    pub allow_remote_endpoints: bool,
}

impl Default for AssistantSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            active_provider_id: None,
            active_model_id: None,
            allow_run_snapshots: false,
            allow_remote_endpoints: false,
        }
    }
}

/// Validate user-editable settings before persistence or network use.
pub fn validate(settings: &AssistantSettings) -> Result<(), String> {
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&settings.timeout_ms) {
        return Err(format!(
            "INVALID_ASSISTANT_TIMEOUT: timeout must be {MIN_TIMEOUT_MS}–{MAX_TIMEOUT_MS} ms"
        ));
    }
    if settings.active_model_id.is_some() && settings.active_provider_id.is_none() {
        return Err("INVALID_ASSISTANT_MODEL_SELECTION".to_string());
    }
    Ok(())
}

/// Load the settings row, falling back to safe defaults if it is missing.
pub async fn load(pool: &DbPool) -> Result<AssistantSettings, String> {
    let row = sqlx::query(
        "SELECT enabled, timeout_ms, active_provider_id, active_model_id, \
                allow_run_snapshots, allow_remote_endpoints \
         FROM assistant_settings WHERE id = 1",
    )
    .fetch_optional(pool.as_ref())
    .await
    .map_err(|e| format!("load assistant_settings: {e}"))?;

    let Some(row) = row else {
        return Ok(AssistantSettings::default());
    };

    let read_i64 = |column: &str| -> Result<i64, String> {
        row.try_get(column)
            .map_err(|e| format!("read {column}: {e}"))
    };
    let timeout = u32::try_from(read_i64("timeout_ms")?).unwrap_or(DEFAULT_TIMEOUT_MS);
    Ok(AssistantSettings {
        enabled: read_i64("enabled")? != 0,
        timeout_ms: timeout,
        active_provider_id: row
            .try_get("active_provider_id")
            .map_err(|e| format!("read active_provider_id: {e}"))?,
        active_model_id: row
            .try_get("active_model_id")
            .map_err(|e| format!("read active_model_id: {e}"))?,
        allow_run_snapshots: read_i64("allow_run_snapshots")? != 0,
        allow_remote_endpoints: read_i64("allow_remote_endpoints")? != 0,
    })
}

/// Persist settings after validation. The row is seeded at startup.
pub async fn save(pool: &DbPool, settings: &AssistantSettings) -> Result<(), String> {
    validate(settings)?;
    let updated_at = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE assistant_settings SET \
            enabled = ?, timeout_ms = ?, active_provider_id = ?, active_model_id = ?, \
            allow_run_snapshots = ?, allow_remote_endpoints = ?, updated_at = ? \
         WHERE id = 1",
    )
    .bind(i64::from(settings.enabled))
    .bind(i64::from(settings.timeout_ms))
    .bind(settings.active_provider_id.as_deref())
    .bind(settings.active_model_id.as_deref())
    .bind(i64::from(settings.allow_run_snapshots))
    .bind(i64::from(settings.allow_remote_endpoints))
    .bind(updated_at)
    .execute(pool.as_ref())
    .await
    .map_err(|e| format!("save assistant_settings: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::sync::Arc;

    async fn fresh_pool() -> DbPool {
        let options = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("schema.sql"))
            .execute(&pool)
            .await
            .unwrap();
        crate::storage::db::ensure_assistant_settings(&pool)
            .await
            .unwrap();
        Arc::new(pool)
    }

    #[test]
    fn defaults_are_disabled_and_unselected() {
        let settings = AssistantSettings::default();
        assert!(!settings.enabled);
        assert!(settings.active_provider_id.is_none());
        assert!(settings.active_model_id.is_none());
        assert!(validate(&settings).is_ok());
    }

    #[test]
    fn provider_can_be_selected_before_model() {
        let settings = AssistantSettings {
            active_provider_id: Some("provider".to_string()),
            ..AssistantSettings::default()
        };
        assert!(validate(&settings).is_ok());
    }

    #[tokio::test]
    async fn settings_round_trip_and_seed_once() {
        let pool = fresh_pool().await;
        let default = load(&pool).await.unwrap();
        assert!(!default.enabled);

        let settings = AssistantSettings {
            enabled: true,
            timeout_ms: 45_000,
            active_provider_id: Some("provider-1".to_string()),
            active_model_id: Some("test-model".to_string()),
            allow_run_snapshots: true,
            allow_remote_endpoints: false,
        };
        save(&pool, &settings).await.unwrap();
        assert_eq!(load(&pool).await.unwrap(), settings);

        crate::storage::db::ensure_assistant_settings(&pool)
            .await
            .unwrap();
        assert_eq!(load(&pool).await.unwrap(), settings);
    }
}
