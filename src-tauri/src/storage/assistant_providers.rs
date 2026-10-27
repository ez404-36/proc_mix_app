//! SQLite storage for configured assistant provider instances and cached models.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::core::assistant::providers::AssistantProviderKind;
use crate::storage::DbPool;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantProviderInput {
    pub name: String,
    pub kind: AssistantProviderKind,
    pub base_url: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantProvider {
    pub id: String,
    pub name: String,
    pub kind: AssistantProviderKind,
    pub base_url: String,
    pub enabled: bool,
    pub has_api_key: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantProviderModel {
    pub provider_id: String,
    pub model_id: String,
    pub name: String,
    pub verified: bool,
    pub hidden: bool,
    pub updated_at: String,
}

fn provider_from_row(
    row: sqlx::sqlite::SqliteRow,
    has_api_key: bool,
) -> Result<AssistantProvider, String> {
    let kind_text: String = row.try_get("kind").map_err(|e| format!("read kind: {e}"))?;
    let kind = AssistantProviderKind::from_stored(&kind_text)
        .ok_or_else(|| format!("unknown assistant provider kind: {kind_text}"))?;
    Ok(AssistantProvider {
        id: row.try_get("id").map_err(|e| format!("read id: {e}"))?,
        name: row.try_get("name").map_err(|e| format!("read name: {e}"))?,
        kind,
        base_url: row
            .try_get("base_url")
            .map_err(|e| format!("read base_url: {e}"))?,
        enabled: row
            .try_get::<i64, _>("enabled")
            .map_err(|e| format!("read enabled: {e}"))?
            != 0,
        has_api_key,
        created_at: row
            .try_get("created_at")
            .map_err(|e| format!("read created_at: {e}"))?,
        updated_at: row
            .try_get("updated_at")
            .map_err(|e| format!("read updated_at: {e}"))?,
    })
}

pub async fn list(pool: &DbPool) -> Result<Vec<AssistantProvider>, String> {
    let rows = sqlx::query(
        "SELECT id, name, kind, base_url, enabled, created_at, updated_at \
         FROM assistant_providers ORDER BY name COLLATE NOCASE, id",
    )
    .fetch_all(pool.as_ref())
    .await
    .map_err(|e| format!("list assistant_providers: {e}"))?;
    rows.into_iter()
        .map(|row| provider_from_row(row, false))
        .collect()
}

pub async fn find(pool: &DbPool, id: &str) -> Result<Option<AssistantProvider>, String> {
    let row = sqlx::query(
        "SELECT id, name, kind, base_url, enabled, created_at, updated_at \
         FROM assistant_providers WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool.as_ref())
    .await
    .map_err(|e| format!("find assistant_provider: {e}"))?;
    row.map(|row| provider_from_row(row, false)).transpose()
}

pub async fn upsert(
    pool: &DbPool,
    id: &str,
    input: &AssistantProviderInput,
) -> Result<AssistantProvider, String> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO assistant_providers \
         (id, name, kind, base_url, enabled, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET \
           name = excluded.name, kind = excluded.kind, base_url = excluded.base_url, \
           enabled = excluded.enabled, updated_at = excluded.updated_at",
    )
    .bind(id)
    .bind(input.name.trim())
    .bind(serde_plain(&input.kind)?)
    .bind(input.base_url.trim())
    .bind(i64::from(input.enabled))
    .bind(&now)
    .bind(&now)
    .execute(pool.as_ref())
    .await
    .map_err(|e| format!("upsert assistant_provider: {e}"))?;
    find(pool, id)
        .await?
        .ok_or_else(|| "assistant provider disappeared after save".to_string())
}

pub async fn set_enabled(pool: &DbPool, id: &str, enabled: bool) -> Result<(), String> {
    sqlx::query("UPDATE assistant_providers SET enabled = ?, updated_at = ? WHERE id = ?")
        .bind(i64::from(enabled))
        .bind(Utc::now().to_rfc3339())
        .bind(id)
        .execute(pool.as_ref())
        .await
        .map_err(|e| format!("update assistant_provider enabled: {e}"))?;
    Ok(())
}

pub async fn delete(pool: &DbPool, id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM assistant_provider_models WHERE provider_id = ?")
        .bind(id)
        .execute(pool.as_ref())
        .await
        .map_err(|e| format!("delete assistant_provider_models: {e}"))?;
    sqlx::query("DELETE FROM assistant_providers WHERE id = ?")
        .bind(id)
        .execute(pool.as_ref())
        .await
        .map_err(|e| format!("delete assistant_provider: {e}"))?;
    Ok(())
}

fn serde_plain(kind: &AssistantProviderKind) -> Result<String, String> {
    let json = serde_json::to_string(kind).map_err(|e| e.to_string())?;
    Ok(json.trim_matches('"').to_string())
}

pub async fn replace_models(
    pool: &DbPool,
    provider_id: &str,
    models: &[(String, String)],
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| format!("begin model cache tx: {e}"))?;
    for (model_id, name) in models {
        sqlx::query(
            "INSERT INTO assistant_provider_models \
             (provider_id, model_id, name, verified, hidden, updated_at) \
             VALUES (?, ?, ?, 1, 0, ?) \
             ON CONFLICT(provider_id, model_id) DO UPDATE SET \
               name = excluded.name, verified = 1, updated_at = excluded.updated_at",
        )
        .bind(provider_id)
        .bind(model_id)
        .bind(name)
        .bind(&now)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("insert cached model: {e}"))?;
    }
    sqlx::query(
        "DELETE FROM assistant_provider_models \
                 WHERE provider_id = ? AND updated_at <> ?",
    )
    .bind(provider_id)
    .bind(&now)
    .execute(&mut *tx)
    .await
    .map_err(|e| format!("remove stale model cache: {e}"))?;
    tx.commit()
        .await
        .map_err(|e| format!("commit model cache: {e}"))
}

pub async fn mark_models_unverified(pool: &DbPool, provider_id: &str) -> Result<(), String> {
    sqlx::query(
        "UPDATE assistant_provider_models SET verified = 0, updated_at = ? WHERE provider_id = ?",
    )
    .bind(Utc::now().to_rfc3339())
    .bind(provider_id)
    .execute(pool.as_ref())
    .await
    .map_err(|e| format!("mark models unverified: {e}"))?;
    Ok(())
}

pub async fn list_models(
    pool: &DbPool,
    provider_id: &str,
    include_hidden: bool,
) -> Result<Vec<AssistantProviderModel>, String> {
    let sql = if include_hidden {
        "SELECT provider_id, model_id, name, verified, hidden, updated_at \
         FROM assistant_provider_models WHERE provider_id = ? \
         ORDER BY name COLLATE NOCASE, model_id"
    } else {
        "SELECT provider_id, model_id, name, verified, hidden, updated_at \
         FROM assistant_provider_models WHERE provider_id = ? AND hidden = 0 \
         ORDER BY name COLLATE NOCASE, model_id"
    };
    let rows = sqlx::query(sql)
        .bind(provider_id)
        .fetch_all(pool.as_ref())
        .await
        .map_err(|e| format!("list assistant_provider_models: {e}"))?;
    rows.into_iter()
        .map(|row| {
            Ok(AssistantProviderModel {
                provider_id: row
                    .try_get("provider_id")
                    .map_err(|e| format!("read provider_id: {e}"))?,
                model_id: row
                    .try_get("model_id")
                    .map_err(|e| format!("read model_id: {e}"))?,
                name: row.try_get("name").map_err(|e| format!("read name: {e}"))?,
                verified: row
                    .try_get::<i64, _>("verified")
                    .map_err(|e| format!("read verified: {e}"))?
                    != 0,
                hidden: row
                    .try_get::<i64, _>("hidden")
                    .map_err(|e| format!("read hidden: {e}"))?
                    != 0,
                updated_at: row
                    .try_get("updated_at")
                    .map_err(|e| format!("read updated_at: {e}"))?,
            })
        })
        .collect()
}

pub async fn set_model_hidden(
    pool: &DbPool,
    provider_id: &str,
    model_id: &str,
    hidden: bool,
) -> Result<(), String> {
    sqlx::query(
        "UPDATE assistant_provider_models SET hidden = ?, updated_at = ? \
         WHERE provider_id = ? AND model_id = ?",
    )
    .bind(i64::from(hidden))
    .bind(Utc::now().to_rfc3339())
    .bind(provider_id)
    .bind(model_id)
    .execute(pool.as_ref())
    .await
    .map_err(|e| format!("update assistant_provider_model hidden: {e}"))?;
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
        Arc::new(pool)
    }

    #[tokio::test]
    async fn replace_models_preserves_hidden_state_and_removes_stale_models() {
        let pool = fresh_pool().await;
        replace_models(
            &pool,
            "provider",
            &[
                ("visible".to_string(), "Visible".to_string()),
                ("stale".to_string(), "Stale".to_string()),
            ],
        )
        .await
        .unwrap();
        set_model_hidden(&pool, "provider", "visible", true)
            .await
            .unwrap();

        replace_models(
            &pool,
            "provider",
            &[
                ("visible".to_string(), "Visible refreshed".to_string()),
                ("added".to_string(), "Added".to_string()),
            ],
        )
        .await
        .unwrap();

        let models = list_models(&pool, "provider", true).await.unwrap();
        assert_eq!(
            models
                .iter()
                .map(|model| model.model_id.as_str())
                .collect::<Vec<_>>(),
            ["added", "visible"]
        );
        let visible = models
            .iter()
            .find(|model| model.model_id == "visible")
            .unwrap();
        assert!(visible.verified);
        assert!(visible.hidden);
    }
}
