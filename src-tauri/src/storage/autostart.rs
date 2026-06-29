// Storage for the autostart feature's BEHAVIOUR config.
//
// The config is a SINGLE ROW (`id = 1`) in the `autostart_config` table — the
// table's `CHECK(id = 1)` constraint plus the seed in
// `db::ensure_autostart_config` guarantee exactly one row, so this layer
// loads/saves without an id.
//
// IMPORTANT: this table does NOT record whether autostart is enabled. The OS
// registration (Windows `Run` key / macOS LaunchAgent / Linux `.desktop`,
// managed by `tauri-plugin-autostart`) is the single source of truth for that —
// it is read live via `AutoLaunchManager::is_enabled()`. SQLite would diverge
// the moment a user toggles autostart through the OS. This table stores ONLY the
// app-side behaviour flag `start_minimized`, which the OS registration cannot
// express. See `commands::autostart` and the Settings → Autostart section.

use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::storage::DbPool;

/// Autostart behaviour config mirrored to/from the single `autostart_config`
/// row. Serialised camelCase to match the TS `AutostartStatus.startMinimized`
/// field. The `enabled` flag is intentionally absent (it lives in the OS).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartConfig {
    /// `false` (default) → a system-launched ProcMix shows its window normally;
    /// `true` → it starts hidden in the tray (no visible window). Only takes
    /// effect when the process is launched by the OS with the `--autostart`
    /// argument; a manual launch always shows the window.
    pub start_minimized: bool,
}

/// Load the single config row. The row is guaranteed to exist by
/// `db::ensure_autostart_config`; if it is somehow missing (a hand-edited DB),
/// fall back to defaults rather than erroring.
pub async fn load(pool: &DbPool) -> Result<AutostartConfig, String> {
    let row = sqlx::query("SELECT start_minimized FROM autostart_config WHERE id = 1")
        .fetch_optional(pool.as_ref())
        .await
        .map_err(|e| format!("load autostart_config: {e}"))?;

    let Some(row) = row else {
        return Ok(AutostartConfig::default());
    };

    let start_minimized: i64 = row
        .try_get("start_minimized")
        .map_err(|e| format!("read start_minimized: {e}"))?;

    Ok(AutostartConfig {
        start_minimized: start_minimized != 0,
    })
}

/// Persist the config into the single row and bump `updated_at`. The row always
/// exists (seeded by the migration), so this is a plain `UPDATE`.
pub async fn save(pool: &DbPool, cfg: &AutostartConfig) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE autostart_config SET start_minimized = ?, updated_at = ? WHERE id = 1",
    )
    .bind(if cfg.start_minimized { 1_i64 } else { 0_i64 })
    .bind(&now)
    .execute(pool.as_ref())
    .await
    .map_err(|e| format!("save autostart_config: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::sync::Arc;

    async fn fresh_pool() -> DbPool {
        let opts = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("schema.sql"))
            .execute(&pool)
            .await
            .unwrap();
        // Seed the single default row (mirrors db::ensure_autostart_config).
        sqlx::query(
            "INSERT OR IGNORE INTO autostart_config \
             (id, start_minimized, created_at, updated_at) \
             VALUES (1, 0, '', '')",
        )
        .execute(&pool)
        .await
        .unwrap();
        Arc::new(pool)
    }

    #[tokio::test]
    async fn load_returns_seeded_defaults() {
        let pool = fresh_pool().await;
        let cfg = load(&pool).await.unwrap();
        assert_eq!(cfg, AutostartConfig::default());
    }

    #[tokio::test]
    async fn save_then_load_round_trips() {
        let pool = fresh_pool().await;
        let cfg = AutostartConfig {
            start_minimized: true,
        };
        save(&pool, &cfg).await.unwrap();
        let loaded = load(&pool).await.unwrap();
        assert_eq!(loaded, cfg);
    }
}
