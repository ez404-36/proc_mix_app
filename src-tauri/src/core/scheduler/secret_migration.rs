//! One-time startup migration that purges pre-upgrade PLAINTEXT secrets
//! from the database. Run from the Tauri `setup` hook after the pool
//! exists — it does NOT belong to the live scheduling loop, only to
//! startup. Idempotent and best-effort: per-row failures are logged,
//! never fatal.

use crate::storage::history::{self as storage_history};
use crate::storage::schedules::{self as storage_schedules};
use crate::storage::DbPool;

use super::fire::load_command;

/// One-time security migration that purges any pre-upgrade PLAINTEXT secret
/// from the database, then physically reclaims the freed pages.
///
/// Two leak paths are swept:
///  1. **Schedules** — a scheduled command's `sensitive` variable values that
///     were stored as plaintext in `schedules.variable_values` are moved into
///     the OS keychain (column keeps only the sentinel).
///  2. **History** — a `sensitive` variable's `defaultValue` captured inside an
///     old `command*` snapshot's `payload_json` is stripped.
///
/// When EITHER sweep rewrote at least one row, the file still holds the old
/// plaintext on free pages, so we run `VACUUM` to rebuild it and discard those
/// bytes. VACUUM is skipped on a clean launch (nothing rewritten) so steady
/// state stays cheap.
///
/// Idempotent and best-effort: per-row failures are logged, never fatal — the
/// app must always start. Called from the Tauri `setup` hook after the pool
/// exists.
pub async fn migrate_plaintext_schedule_secrets(pool: &DbPool) {
    let schedules_changed = migrate_schedule_secrets(pool).await;

    // History snapshots: strip sensitive defaults from old command* events.
    let history_changed = match storage_history::redact_sensitive_history_defaults(pool).await {
        Ok(n) => n > 0,
        Err(e) => {
            tracing::error!("scheduler: failed to redact sensitive history defaults: {e}");
            false
        }
    };

    // Only rewrite the file when something actually changed — VACUUM is costly.
    if schedules_changed || history_changed {
        if let Err(e) = crate::storage::db::vacuum(pool).await {
            tracing::error!("scheduler: VACUUM after secret migration failed: {e}");
        }
    }
}

/// Move plaintext sensitive scheduled values into the keychain. Returns `true`
/// when at least one schedule was rewritten (so the caller knows to VACUUM).
async fn migrate_schedule_secrets(pool: &DbPool) -> bool {
    let schedules = match storage_schedules::list_all(pool).await {
        Ok(list) => list,
        Err(e) => {
            tracing::error!("scheduler: secret migration failed to list schedules: {e}");
            return false;
        }
    };

    let mut changed = false;
    for rec in &schedules {
        // Only command targets carry the flat, command-spec-backed value shape.
        if rec.target_kind != "command" {
            continue;
        }
        // Learn which of this command's variables are sensitive.
        let cmd = match load_command(pool, &rec.target_id).await {
            Ok(Some(cmd)) => cmd,
            // Missing command / load error → nothing we can safely redact.
            _ => continue,
        };
        let sensitive: std::collections::BTreeSet<String> = cmd
            .variables
            .iter()
            .filter(|spec| spec.sensitive)
            .map(|spec| spec.name.clone())
            .collect();
        if sensitive.is_empty() {
            continue;
        }
        // Does the stored JSON still hold a PLAINTEXT value for any sensitive
        // var (i.e. not already the sentinel)? If not, skip the write entirely.
        let needs_migration = rec
            .variable_values
            .as_object()
            .map(|obj| {
                obj.iter().any(|(name, value)| {
                    sensitive.contains(name)
                        && value.as_str().is_some_and(|s| {
                            !crate::security::schedule_secrets::is_secret_ref(s) && !s.is_empty()
                        })
                })
            })
            .unwrap_or(false);
        if !needs_migration {
            continue;
        }
        // Re-persist through the redaction path: this stores the plaintext
        // secret(s) in the keychain and rewrites the column with sentinels.
        if let Err(e) = storage_schedules::upsert(pool, rec, &sensitive).await {
            tracing::error!(
                schedule_id = %rec.id,
                "scheduler: failed to migrate plaintext secrets for schedule: {e}"
            );
        } else {
            changed = true;
        }
    }
    changed
}
