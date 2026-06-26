// Storage for per-plugin user state (plugin system, Phase 1).
//
// Keyed by the plugin's manifest `id`, this table stores only the bits that
// have no home in a `plugin.json`: whether the user enabled the plugin. The
// plugin's definition itself lives on disk and is parsed read-only by
// `plugins::discovery`. Mirrors the keyed-meta-table pattern of
// `storage/ssh_host_meta.rs`.
//
// Default: a plugin with NO row is ENABLED. A freshly discovered, compatible
// plugin is on until the user explicitly turns it off, so absence-of-row means
// "on" rather than "off".

use std::collections::HashSet;

use sqlx::Row;

use crate::storage::DbPool;

/// Load the set of plugin ids the user has explicitly DISABLED.
///
/// We store the disabled set (not the enabled set) so the "enabled by default"
/// semantics fall out naturally: any id absent from this set is enabled. The
/// registry consults this via a closure `|id| !disabled.contains(id)`.
pub async fn load_disabled(pool: &DbPool) -> Result<HashSet<String>, String> {
    let rows = sqlx::query("SELECT plugin_id FROM plugin_state WHERE enabled = 0")
        .fetch_all(pool.as_ref())
        .await
        .map_err(|e| format!("load plugin_state: {e}"))?;

    let mut disabled = HashSet::new();
    for row in rows {
        let id: String = row
            .try_get("plugin_id")
            .map_err(|e| format!("read plugin_id: {e}"))?;
        disabled.insert(id);
    }
    Ok(disabled)
}

/// Set a plugin's enabled flag. Upserts the keyed row (lazy creation on first
/// toggle), bumping `updated_at`.
pub async fn set_enabled(pool: &DbPool, plugin_id: &str, enabled: bool) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO plugin_state (plugin_id, enabled, updated_at) \
         VALUES (?, ?, ?) \
         ON CONFLICT(plugin_id) DO UPDATE SET enabled = excluded.enabled, \
            updated_at = excluded.updated_at",
    )
    .bind(plugin_id)
    .bind(if enabled { 1_i64 } else { 0_i64 })
    .bind(&now)
    .execute(pool.as_ref())
    .await
    .map_err(|e| format!("set plugin_state: {e}"))?;
    Ok(())
}

/// Remove a plugin's state row (used when a plugin is removed, so a later
/// reinstall of the same id starts from the default-enabled state).
pub async fn forget(pool: &DbPool, plugin_id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM plugin_state WHERE plugin_id = ?")
        .bind(plugin_id)
        .execute(pool.as_ref())
        .await
        .map_err(|e| format!("forget plugin_state: {e}"))?;
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
        Arc::new(pool)
    }

    #[tokio::test]
    async fn unknown_plugin_is_enabled_by_default() {
        let pool = fresh_pool().await;
        let disabled = load_disabled(&pool).await.unwrap();
        // No rows → nothing disabled → an unknown id is enabled.
        assert!(!disabled.contains("com.example.x"));
    }

    #[tokio::test]
    async fn disabling_then_loading_reports_disabled() {
        let pool = fresh_pool().await;
        set_enabled(&pool, "com.example.x", false).await.unwrap();
        let disabled = load_disabled(&pool).await.unwrap();
        assert!(disabled.contains("com.example.x"));
    }

    #[tokio::test]
    async fn re_enabling_clears_from_disabled_set() {
        let pool = fresh_pool().await;
        set_enabled(&pool, "com.example.x", false).await.unwrap();
        set_enabled(&pool, "com.example.x", true).await.unwrap();
        let disabled = load_disabled(&pool).await.unwrap();
        assert!(!disabled.contains("com.example.x"));
    }

    #[tokio::test]
    async fn forget_removes_state() {
        let pool = fresh_pool().await;
        set_enabled(&pool, "com.example.x", false).await.unwrap();
        forget(&pool, "com.example.x").await.unwrap();
        let disabled = load_disabled(&pool).await.unwrap();
        // After forgetting, the id reverts to default-enabled.
        assert!(!disabled.contains("com.example.x"));
    }
}
