// Storage for the window-behaviour config.
//
// The config is a SINGLE ROW (`id = 1`) in the `window_behavior_config` table —
// the table's `CHECK(id = 1)` constraint plus the seed in
// `db::ensure_window_behavior_config` guarantee exactly one row, so this layer
// loads/saves without an id (same discipline as `autostart_config` /
// `http_server_config`).
//
// It records ONE app-side flag, `close_to_tray`: when `true` (the default)
// closing the main window HIDES it to the system tray instead of quitting; when
// `false`, closing the window quits ProcMix. The flag is consumed by the
// `CloseRequested` handler installed in `platform::tray::install_close_to_tray`,
// which reads it through a synchronous runtime cache (the window event callback
// cannot await SQLite). See `commands::window_behavior` and the Settings → Tray
// section.

use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::storage::DbPool;

/// Window-behaviour config mirrored to/from the single `window_behavior_config`
/// row. Serialised camelCase to match the TS `WindowBehaviorConfig` type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBehaviorConfig {
    /// `true` (default) → closing the main window hides it to the tray;
    /// `false` → closing the window quits ProcMix.
    pub close_to_tray: bool,
}

impl Default for WindowBehaviorConfig {
    fn default() -> Self {
        // Hiding to the tray on close is the historical (and documented) default
        // behaviour; the new setting only lets the user OPT OUT of it.
        Self {
            close_to_tray: true,
        }
    }
}

/// Load the single config row. The row is guaranteed to exist by
/// `db::ensure_window_behavior_config`; if it is somehow missing (a hand-edited
/// DB), fall back to defaults rather than erroring.
pub async fn load(pool: &DbPool) -> Result<WindowBehaviorConfig, String> {
    let row = sqlx::query("SELECT close_to_tray FROM window_behavior_config WHERE id = 1")
        .fetch_optional(pool.as_ref())
        .await
        .map_err(|e| format!("load window_behavior_config: {e}"))?;

    let Some(row) = row else {
        return Ok(WindowBehaviorConfig::default());
    };

    let close_to_tray: i64 = row
        .try_get("close_to_tray")
        .map_err(|e| format!("read close_to_tray: {e}"))?;

    Ok(WindowBehaviorConfig {
        close_to_tray: close_to_tray != 0,
    })
}

/// Persist the config into the single row and bump `updated_at`. The row always
/// exists (seeded by the migration), so this is a plain `UPDATE`.
pub async fn save(pool: &DbPool, cfg: &WindowBehaviorConfig) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("UPDATE window_behavior_config SET close_to_tray = ?, updated_at = ? WHERE id = 1")
        .bind(if cfg.close_to_tray { 1_i64 } else { 0_i64 })
        .bind(&now)
        .execute(pool.as_ref())
        .await
        .map_err(|e| format!("save window_behavior_config: {e}"))?;
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
        // Seed the single default row (mirrors db::ensure_window_behavior_config).
        sqlx::query(
            "INSERT OR IGNORE INTO window_behavior_config \
             (id, close_to_tray, created_at, updated_at) \
             VALUES (1, 1, '', '')",
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
        assert_eq!(cfg, WindowBehaviorConfig::default());
        // The default must be "hide to tray on close".
        assert!(cfg.close_to_tray);
    }

    #[tokio::test]
    async fn save_then_load_round_trips() {
        let pool = fresh_pool().await;
        let cfg = WindowBehaviorConfig {
            close_to_tray: false,
        };
        save(&pool, &cfg).await.unwrap();
        let loaded = load(&pool).await.unwrap();
        assert_eq!(loaded, cfg);
    }
}
