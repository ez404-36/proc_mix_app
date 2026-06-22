//! SQLite-backed ProcMix metadata for SSH hosts.
//!
//! The host connection PARAMETERS are NOT stored here — they live in their
//! source of truth (`~/.ssh/config`, …) and are parsed read-only by
//! `core::ssh`. This table holds only the small bits of state that ProcMix
//! itself owns and that have no home in an SSH config: the outcome and time
//! of the last reachability check.
//!
//! Rows are keyed by the composite `host_key` (`"<source>:<name>"`, i.e.
//! [`crate::core::ssh::SshHostId::key`]) so the same alias in two different
//! sources keeps independent metadata. A row is created/updated lazily when a
//! check runs; a host with no metadata simply has no row (and the UI shows
//! "not checked yet").
//!
//! There is intentionally no delete path: an orphaned meta row (its host was
//! removed from the config) is harmless and tiny, and a host re-appearing
//! reuses its prior check result. A future cleanup pass can prune orphans if
//! it ever matters.

use sqlx::Row;

use crate::storage::DbPool;

/// One host's stored metadata. `last_check_at` is an RFC 3339 timestamp
/// string (matching the rest of the schema's time columns); `None` when the
/// host has never been checked.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostMeta {
    pub host_key: String,
    pub last_check_at: Option<String>,
    /// Result of the last check: `Some(true)` reachable, `Some(false)`
    /// unreachable, `None` never checked.
    pub last_check_ok: Option<bool>,
}

/// Load every stored metadata row, returned as a map keyed by `host_key` for
/// O(1) merge into the parsed host list.
pub async fn load_all(
    pool: &DbPool,
) -> Result<std::collections::HashMap<String, SshHostMeta>, String> {
    let rows = sqlx::query("SELECT host_key, last_check_at, last_check_ok FROM ssh_host_meta")
        .fetch_all(pool.as_ref())
        .await
        .map_err(|e| format!("load ssh_host_meta: {e}"))?;

    let mut out = std::collections::HashMap::with_capacity(rows.len());
    for row in rows {
        let host_key: String = row
            .try_get("host_key")
            .map_err(|e| format!("read host_key: {e}"))?;
        let last_check_at: Option<String> = row
            .try_get("last_check_at")
            .map_err(|e| format!("read last_check_at: {e}"))?;
        // Stored as INTEGER 0/1 (SQLite has no bool); map NULL → None.
        let last_check_ok: Option<i64> = row
            .try_get("last_check_ok")
            .map_err(|e| format!("read last_check_ok: {e}"))?;
        out.insert(
            host_key.clone(),
            SshHostMeta {
                host_key,
                last_check_at,
                last_check_ok: last_check_ok.map(|v| v != 0),
            },
        );
    }
    Ok(out)
}

/// Upsert the last-check result for `host_key`. `at` is an RFC 3339 string.
pub async fn record_check(pool: &DbPool, host_key: &str, ok: bool, at: &str) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO ssh_host_meta (host_key, last_check_at, last_check_ok)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(host_key) DO UPDATE SET
           last_check_at = excluded.last_check_at,
           last_check_ok = excluded.last_check_ok",
    )
    .bind(host_key)
    .bind(at)
    .bind(i64::from(ok))
    .execute(pool.as_ref())
    .await
    .map_err(|e| format!("record ssh check: {e}"))?;
    Ok(())
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
            "CREATE TABLE ssh_host_meta (
               host_key      TEXT PRIMARY KEY NOT NULL,
               last_check_at TEXT,
               last_check_ok INTEGER
             )",
        )
        .execute(&pool)
        .await
        .expect("create table");
        Arc::new(pool)
    }

    #[tokio::test]
    async fn empty_table_loads_empty_map() {
        let pool = test_pool().await;
        let all = load_all(&pool).await.unwrap();
        assert!(all.is_empty());
    }

    #[tokio::test]
    async fn record_then_load_round_trips() {
        let pool = test_pool().await;
        record_check(&pool, "openssh:prod", true, "2026-06-20T10:00:00+00:00")
            .await
            .unwrap();

        let all = load_all(&pool).await.unwrap();
        let meta = all.get("openssh:prod").expect("row present");
        assert_eq!(meta.last_check_ok, Some(true));
        assert_eq!(
            meta.last_check_at.as_deref(),
            Some("2026-06-20T10:00:00+00:00")
        );
    }

    #[tokio::test]
    async fn record_check_upserts_in_place() {
        let pool = test_pool().await;
        record_check(&pool, "openssh:prod", true, "2026-06-20T10:00:00+00:00")
            .await
            .unwrap();
        record_check(&pool, "openssh:prod", false, "2026-06-20T11:00:00+00:00")
            .await
            .unwrap();

        let all = load_all(&pool).await.unwrap();
        assert_eq!(all.len(), 1, "upsert must not create a second row");
        let meta = &all["openssh:prod"];
        assert_eq!(meta.last_check_ok, Some(false));
        assert_eq!(
            meta.last_check_at.as_deref(),
            Some("2026-06-20T11:00:00+00:00")
        );
    }

    #[tokio::test]
    async fn distinct_keys_are_independent() {
        let pool = test_pool().await;
        record_check(&pool, "openssh:prod", true, "t1")
            .await
            .unwrap();
        record_check(&pool, "putty:prod", false, "t2")
            .await
            .unwrap();
        let all = load_all(&pool).await.unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all["openssh:prod"].last_check_ok, Some(true));
        assert_eq!(all["putty:prod"].last_check_ok, Some(false));
    }
}
