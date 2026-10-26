//! Per-object overrides for assistant access to completed-run snapshots.
//!
//! Values live on the owning command/workflow row so an explicit policy
//! travels with the object. `Deny` is enforced here before a provider call;
//! the sidebar is only the UI for the same durable setting.

use sqlx::Row;

use crate::core::assistant::types::{AssistantRunAccess, AssistantTarget};
use crate::storage::DbPool;

fn parse(value: String) -> AssistantRunAccess {
    match value.as_str() {
        "allow" => AssistantRunAccess::Allow,
        "deny" => AssistantRunAccess::Deny,
        _ => AssistantRunAccess::Inherit,
    }
}

/// Load an object's policy. A missing object keeps the safe inherit default;
/// generation validates the object only when a snapshot is attached.
pub async fn load(
    pool: &DbPool,
    target: AssistantTarget,
    object_id: &str,
) -> Result<AssistantRunAccess, String> {
    let row = match target {
        AssistantTarget::Command => {
            sqlx::query("SELECT assistant_run_access FROM commands WHERE id = ?")
                .bind(object_id)
                .fetch_optional(pool.as_ref())
                .await
                .map_err(|e| format!("load assistant_run_access: {e}"))?
        }
        AssistantTarget::Workflow => {
            sqlx::query("SELECT assistant_run_access FROM workflows WHERE id = ?")
                .bind(object_id)
                .fetch_optional(pool.as_ref())
                .await
                .map_err(|e| format!("load assistant_run_access: {e}"))?
        }
        AssistantTarget::Miniapp | AssistantTarget::Schedule => {
            return Ok(AssistantRunAccess::Inherit)
        }
    };

    Ok(match row {
        Some(row) => parse(
            row.try_get("assistant_run_access")
                .map_err(|e| format!("read assistant_run_access: {e}"))?,
        ),
        None => AssistantRunAccess::Inherit,
    })
}

/// Persist an object's policy. Returns an IPC error if the object no longer
/// exists so the sidebar never reports success for stale history entries.
pub async fn save(
    pool: &DbPool,
    target: AssistantTarget,
    object_id: &str,
    access: AssistantRunAccess,
) -> Result<(), String> {
    let result = match target {
        AssistantTarget::Command => {
            sqlx::query("UPDATE commands SET assistant_run_access = ? WHERE id = ?")
                .bind(access.as_str())
                .bind(object_id)
                .execute(pool.as_ref())
                .await
                .map_err(|e| format!("save assistant_run_access: {e}"))?
        }
        AssistantTarget::Workflow => {
            sqlx::query("UPDATE workflows SET assistant_run_access = ? WHERE id = ?")
                .bind(access.as_str())
                .bind(object_id)
                .execute(pool.as_ref())
                .await
                .map_err(|e| format!("save assistant_run_access: {e}"))?
        }
        AssistantTarget::Miniapp | AssistantTarget::Schedule => {
            return Err("ASSISTANT_RUN_ACCESS_UNSUPPORTED_TARGET".to_string())
        }
    };

    if result.rows_affected() == 0 {
        return Err("ASSISTANT_RUN_ACCESS_OBJECT_NOT_FOUND".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::sync::Arc;

    async fn pool() -> DbPool {
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
    async fn loads_default_and_saves_command_override() {
        let pool = pool().await;
        sqlx::query(
            "INSERT INTO commands (id, name, script, created_at, updated_at) \
             VALUES ('cmd-1', 'Test', 'echo hi', '2026-01-01', '2026-01-01')",
        )
        .execute(pool.as_ref())
        .await
        .unwrap();

        let initial = load(&pool, AssistantTarget::Command, "cmd-1")
            .await
            .unwrap();
        assert_eq!(initial, AssistantRunAccess::Inherit);

        save(
            &pool,
            AssistantTarget::Command,
            "cmd-1",
            AssistantRunAccess::Deny,
        )
        .await
        .unwrap();
        assert_eq!(
            load(&pool, AssistantTarget::Command, "cmd-1")
                .await
                .unwrap(),
            AssistantRunAccess::Deny
        );
    }

    #[tokio::test]
    async fn saves_workflow_and_rejects_missing_object() {
        let pool = pool().await;
        sqlx::query(
            "INSERT INTO workflows (id, name, created_at, updated_at) \
             VALUES ('wf-1', 'Test', '2026-01-01', '2026-01-01')",
        )
        .execute(pool.as_ref())
        .await
        .unwrap();

        save(
            &pool,
            AssistantTarget::Workflow,
            "wf-1",
            AssistantRunAccess::Allow,
        )
        .await
        .unwrap();
        assert_eq!(
            load(&pool, AssistantTarget::Workflow, "wf-1")
                .await
                .unwrap(),
            AssistantRunAccess::Allow
        );

        let missing = save(
            &pool,
            AssistantTarget::Workflow,
            "missing",
            AssistantRunAccess::Allow,
        )
        .await
        .unwrap_err();
        assert_eq!(missing, "ASSISTANT_RUN_ACCESS_OBJECT_NOT_FOUND");
    }
}
