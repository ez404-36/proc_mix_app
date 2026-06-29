// Storage for the built-in HTTP server's configuration.
//
// The config is a SINGLE ROW (`id = 1`) in the `http_server_config` table —
// the table's `CHECK(id = 1)` constraint plus the seed in
// `db::ensure_http_server_config` guarantee exactly one row, so this layer
// loads/saves without an id. The Bearer TOKEN is deliberately NOT part of this
// config: it lives only in the OS keychain via `security::api_token`. See
// docs/http-server.md.

use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::storage::DbPool;

/// Lowest TCP port we allow the server to bind. Ports below 1024 are
/// privileged on Unix and a foot-gun; the server is a user-level convenience,
/// not a system service.
pub const MIN_PORT: u16 = 1024;

/// Default port — a "rarely occupied" high port so a fresh install binds
/// cleanly without colliding with common dev servers (3000/5173/8080/…).
pub const DEFAULT_PORT: u16 = 48610;

/// HTTP server configuration mirrored to/from the single `http_server_config`
/// row. Serialised camelCase to match the TS `HttpServerConfig` type. The token
/// is intentionally absent (keychain-only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpServerConfig {
    /// Whether the server should be running. When `true`, the setup hook
    /// autostarts it on launch.
    pub enabled: bool,
    /// TCP port to bind. Validated into `[MIN_PORT, 65535]` by [`validate_port`].
    pub port: u16,
    /// `false` (default) → bind `127.0.0.1` only; `true` → bind `0.0.0.0` (LAN).
    pub bind_lan: bool,
    /// `true` (default) → an API-triggered run streams to the live console
    /// (`silent = false`); `false` → runs are silent (history-only).
    pub log_to_console: bool,
    /// `false` (default) → REST API only; `true` → also serve the browser-served
    /// read-only web UI over the same port. Off by default so an existing
    /// install's API-only posture is unchanged on upgrade.
    pub serve_web_ui: bool,
}

impl Default for HttpServerConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_PORT,
            bind_lan: false,
            log_to_console: true,
            serve_web_ui: false,
        }
    }
}

/// Validate a requested port. Rejects privileged / zero ports with a stable,
/// JS-matchable error string. Returns the port unchanged on success.
pub fn validate_port(port: u16) -> Result<u16, String> {
    if port < MIN_PORT {
        return Err(format!(
            "INVALID_PORT: port must be between {MIN_PORT} and 65535 (got {port})"
        ));
    }
    Ok(port)
}

/// Load the single config row. The row is guaranteed to exist by
/// `db::ensure_http_server_config`; if it is somehow missing (a hand-edited
/// DB), fall back to defaults rather than erroring.
pub async fn load(pool: &DbPool) -> Result<HttpServerConfig, String> {
    let row = sqlx::query(
        "SELECT enabled, port, bind_lan, log_to_console, serve_web_ui \
         FROM http_server_config WHERE id = 1",
    )
    .fetch_optional(pool.as_ref())
    .await
    .map_err(|e| format!("load http_server_config: {e}"))?;

    let Some(row) = row else {
        return Ok(HttpServerConfig::default());
    };

    let enabled: i64 = row
        .try_get("enabled")
        .map_err(|e| format!("read enabled: {e}"))?;
    let port: i64 = row.try_get("port").map_err(|e| format!("read port: {e}"))?;
    let bind_lan: i64 = row
        .try_get("bind_lan")
        .map_err(|e| format!("read bind_lan: {e}"))?;
    let log_to_console: i64 = row
        .try_get("log_to_console")
        .map_err(|e| format!("read log_to_console: {e}"))?;
    let serve_web_ui: i64 = row
        .try_get("serve_web_ui")
        .map_err(|e| format!("read serve_web_ui: {e}"))?;

    Ok(HttpServerConfig {
        enabled: enabled != 0,
        // A stored out-of-range port (hand-edited DB) clamps to the default
        // rather than panicking on the `as u16` cast.
        port: u16::try_from(port).unwrap_or(DEFAULT_PORT),
        bind_lan: bind_lan != 0,
        log_to_console: log_to_console != 0,
        serve_web_ui: serve_web_ui != 0,
    })
}

/// Persist the config into the single row. Validates the port first (so an
/// invalid port never reaches the DB) and bumps `updated_at`. The row always
/// exists (seeded by the migration), so this is a plain `UPDATE`.
pub async fn save(pool: &DbPool, cfg: &HttpServerConfig) -> Result<(), String> {
    validate_port(cfg.port)?;
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "UPDATE http_server_config SET \
            enabled = ?, port = ?, bind_lan = ?, log_to_console = ?, serve_web_ui = ?, \
            updated_at = ? \
         WHERE id = 1",
    )
    .bind(if cfg.enabled { 1_i64 } else { 0_i64 })
    .bind(cfg.port as i64)
    .bind(if cfg.bind_lan { 1_i64 } else { 0_i64 })
    .bind(if cfg.log_to_console { 1_i64 } else { 0_i64 })
    .bind(if cfg.serve_web_ui { 1_i64 } else { 0_i64 })
    .bind(&now)
    .execute(pool.as_ref())
    .await
    .map_err(|e| format!("save http_server_config: {e}"))?;
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
        // Seed the single default row (mirrors db::ensure_http_server_config).
        sqlx::query(
            "INSERT OR IGNORE INTO http_server_config \
             (id, enabled, port, bind_lan, log_to_console, serve_web_ui, created_at, updated_at) \
             VALUES (1, 0, 48610, 0, 1, 0, '', '')",
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
        assert_eq!(cfg, HttpServerConfig::default());
    }

    #[tokio::test]
    async fn save_then_load_round_trips() {
        let pool = fresh_pool().await;
        let cfg = HttpServerConfig {
            enabled: true,
            port: 50000,
            bind_lan: true,
            log_to_console: false,
            serve_web_ui: true,
        };
        save(&pool, &cfg).await.unwrap();
        let loaded = load(&pool).await.unwrap();
        assert_eq!(loaded, cfg);
    }

    #[tokio::test]
    async fn save_rejects_privileged_port() {
        let pool = fresh_pool().await;
        let cfg = HttpServerConfig {
            port: 80,
            ..HttpServerConfig::default()
        };
        let err = save(&pool, &cfg).await.unwrap_err();
        assert!(err.starts_with("INVALID_PORT:"), "got: {err}");
    }

    #[test]
    fn validate_port_bounds() {
        assert!(validate_port(0).is_err());
        assert!(validate_port(1023).is_err());
        assert_eq!(validate_port(1024).unwrap(), 1024);
        assert_eq!(validate_port(48610).unwrap(), 48610);
        assert_eq!(validate_port(65535).unwrap(), 65535);
    }
}
