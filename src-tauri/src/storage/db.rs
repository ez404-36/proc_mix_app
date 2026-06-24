// SQLite connection-pool bootstrap for the local command library.
//
// The DB file lives in the Tauri-resolved app data directory (e.g.
// `~/.config/app.procmix.desktop/procmix.db` on Linux). The pool is
// created once during `tauri::Builder::setup` and held in app state via
// `app.manage(pool)`; IPC handlers retrieve it through `State<DbPool>`.

use std::path::PathBuf;
use std::sync::Arc;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use sqlx::Row;

/// Shared handle to the SQLite connection pool. `Arc` so it can be cloned
/// cheaply across tasks; the pool itself is internally `Arc`-counted, but
/// the explicit alias keeps the Tauri state type stable.
pub type DbPool = Arc<SqlitePool>;

/// Build (or open) the SQLite database at `db_path`, ensuring the parent
/// directory exists and the schema is applied. Returns an `Arc<SqlitePool>`
/// suitable for `app.manage`.
pub async fn init_pool(db_path: PathBuf) -> Result<DbPool, String> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create db parent dir: {e}"))?;
    }

    let opts = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .map_err(|e| {
            format!(
                "failed to connect to sqlite db at {}: {e}",
                db_path.display()
            )
        })?;

    // Apply the schema. `raw_sql` supports multi-statement scripts (the
    // single-statement `query` API was deprecated for multi-statement
    // usage in sqlx 0.9).
    sqlx::raw_sql(include_str!("schema.sql"))
        .execute(&pool)
        .await
        .map_err(|e| format!("failed to apply db schema: {e}"))?;

    // Run idempotent column-additions for users whose DB was created
    // before a column existed. SQLite has no `ADD COLUMN IF NOT EXISTS`,
    // so we inspect `PRAGMA table_info` first.
    ensure_commands_columns(&pool).await?;
    ensure_workflows_columns(&pool).await?;
    ensure_schedules_columns(&pool).await?;
    ensure_history_columns(&pool).await?;
    ensure_ssh_host_meta_columns(&pool).await?;
    ensure_http_server_config(&pool).await?;

    Ok(Arc::new(pool))
}

/// Rewrite the database file to reclaim free pages, physically discarding the
/// stale bytes of rows an `UPDATE`/`DELETE` left behind.
///
/// SQLite never zeroes the old content of a changed row — it just marks the
/// page free for reuse. After a secret-redaction migration the plaintext secret
/// is still recoverable from those free pages with a raw hex dump of the file.
/// `VACUUM` rebuilds the file from live rows only, so the old bytes are gone.
///
/// This is comparatively expensive (it rewrites the whole file), so the caller
/// runs it ONLY when a redaction actually rewrote at least one row — never on a
/// clean launch.
pub async fn vacuum(pool: &DbPool) -> Result<(), String> {
    sqlx::query("VACUUM")
        .execute(pool.as_ref())
        .await
        .map_err(|e| format!("vacuum: {e}"))?;
    Ok(())
}

/// Idempotent `ALTER TABLE … ADD COLUMN …` for the `commands` table.
///
/// `CREATE TABLE IF NOT EXISTS` only creates the schema as it was on
/// first launch; columns added in later releases (like `run_as_admin`,
/// v0.2.0) won't be applied to existing databases. SQLite has no
/// `ADD COLUMN IF NOT EXISTS`, so we ask `PRAGMA table_info` what is
/// there and add what isn't.
///
/// New columns must be NULLable or have a DEFAULT — both apply to
/// `run_as_admin INTEGER NOT NULL DEFAULT 0`, so the migration is safe
/// regardless of how many existing rows the user has.
async fn ensure_commands_columns(pool: &SqlitePool) -> Result<(), String> {
    let rows = sqlx::query("PRAGMA table_info(commands)")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("inspect commands table: {e}"))?;

    let existing: std::collections::HashSet<String> = rows
        .into_iter()
        .filter_map(|r| r.try_get::<String, _>("name").ok())
        .collect();

    // (column_name, "ADD COLUMN …" fragment). Append future columns
    // here. The SQL must be a `&'static str` for sqlx 0.9's
    // `SqlSafeStr` bound — that's also a desirable property because
    // a runtime-built ALTER would invite injection bugs.
    let migrations: &[(&str, &'static str)] = &[
        (
            "run_as_admin",
            "ALTER TABLE commands ADD COLUMN run_as_admin INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "variables",
            "ALTER TABLE commands ADD COLUMN variables TEXT NOT NULL DEFAULT '[]'",
        ),
        (
            "timeout_seconds",
            "ALTER TABLE commands ADD COLUMN timeout_seconds INTEGER",
        ),
        (
            "output_schema",
            "ALTER TABLE commands ADD COLUMN output_schema TEXT",
        ),
        (
            "scope",
            "ALTER TABLE commands ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'",
        ),
        (
            "workflow_id",
            "ALTER TABLE commands ADD COLUMN workflow_id TEXT",
        ),
        (
            // JSON-encoded `ExecutionTarget` ({"kind":"local"|"remote"|...}).
            // NULL on existing rows → decoded as `Local`, so a pre-upgrade
            // command keeps running locally.
            "target",
            "ALTER TABLE commands ADD COLUMN target TEXT",
        ),
        (
            // Optional HTTP-API slug (v0.10.0). NULL on existing rows.
            "api_slug",
            "ALTER TABLE commands ADD COLUMN api_slug TEXT",
        ),
        (
            // HTTP-API opt-in flag (v0.10.0). Default 0 → existing commands
            // stay invisible to the API until the user opts in.
            "api_enabled",
            "ALTER TABLE commands ADD COLUMN api_enabled INTEGER NOT NULL DEFAULT 0",
        ),
    ];

    for &(col, sql) in migrations {
        if !existing.contains(col) {
            sqlx::query(sql)
                .execute(pool)
                .await
                .map_err(|e| format!("add column {col} to commands: {e}"))?;
        }
    }

    // Create the PARTIAL unique index on `api_slug` HERE rather than in
    // schema.sql: on an existing database `CREATE TABLE IF NOT EXISTS` does not
    // add the column, and schema.sql runs before the ALTER above — so indexing
    // `api_slug` there panics with "no such column: api_slug". By this point the
    // column is guaranteed to exist (fresh DB: created by schema.sql; old DB:
    // just added by the ALTER). `WHERE api_slug IS NOT NULL` makes uniqueness
    // apply only to commands that actually have a slug — many NULLs coexist.
    sqlx::query(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_commands_api_slug \
         ON commands(api_slug) WHERE api_slug IS NOT NULL",
    )
    .execute(pool)
    .await
    .map_err(|e| format!("create idx_commands_api_slug: {e}"))?;

    Ok(())
}

/// Idempotent `ALTER TABLE … ADD COLUMN …` for the `workflows` table.
///
/// The `workflows` table was introduced whole in v0.5.0, so on first
/// release there are no missing columns to backfill — the migration list
/// is intentionally empty. It exists now (rather than being added later)
/// so future workflow columns have an established, tested home that mirrors
/// [`ensure_commands_columns`]. The same `PRAGMA table_info` inspection
/// guards idempotency once entries are added.
async fn ensure_workflows_columns(pool: &SqlitePool) -> Result<(), String> {
    let rows = sqlx::query("PRAGMA table_info(workflows)")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("inspect workflows table: {e}"))?;

    let existing: std::collections::HashSet<String> = rows
        .into_iter()
        .filter_map(|r| r.try_get::<String, _>("name").ok())
        .collect();

    // (column_name, "ADD COLUMN …" fragment). Append future columns here.
    // The SQL must be a `&'static str` for sqlx 0.9's `SqlSafeStr` bound —
    // a runtime-built ALTER would also invite injection bugs.
    let migrations: &[(&str, &'static str)] = &[
        (
            // Optional HTTP-API slug (v0.10.0). NULL on existing rows.
            "api_slug",
            "ALTER TABLE workflows ADD COLUMN api_slug TEXT",
        ),
        (
            // HTTP-API opt-in flag (v0.10.0). Default 0.
            "api_enabled",
            "ALTER TABLE workflows ADD COLUMN api_enabled INTEGER NOT NULL DEFAULT 0",
        ),
    ];

    for &(col, sql) in migrations {
        if !existing.contains(col) {
            sqlx::query(sql)
                .execute(pool)
                .await
                .map_err(|e| format!("add column {col} to workflows: {e}"))?;
        }
    }

    // Partial unique index on `api_slug`, created AFTER the column is guaranteed
    // to exist (same ordering reason as idx_commands_api_slug). Uniqueness is
    // SEPARATE from commands — a workflow and a command may share a slug string.
    sqlx::query(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_api_slug \
         ON workflows(api_slug) WHERE api_slug IS NOT NULL",
    )
    .execute(pool)
    .await
    .map_err(|e| format!("create idx_workflows_api_slug: {e}"))?;

    Ok(())
}

/// Idempotent `ALTER TABLE … ADD COLUMN …` for the `ssh_host_meta` table.
///
/// The table was introduced whole in v0.9.0, so on first release there are no
/// missing columns to backfill — the migration list is intentionally empty.
/// It exists now (rather than being added later) so future columns have an
/// established, tested home that mirrors [`ensure_workflows_columns`]. The
/// same `PRAGMA table_info` inspection guards idempotency once entries are
/// added.
async fn ensure_ssh_host_meta_columns(pool: &SqlitePool) -> Result<(), String> {
    let rows = sqlx::query("PRAGMA table_info(ssh_host_meta)")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("inspect ssh_host_meta table: {e}"))?;

    let existing: std::collections::HashSet<String> = rows
        .into_iter()
        .filter_map(|r| r.try_get::<String, _>("name").ok())
        .collect();

    // (column_name, "ADD COLUMN …" fragment). Append future columns here.
    // The SQL must be a `&'static str` for sqlx 0.9's `SqlSafeStr` bound —
    // a runtime-built ALTER would also invite injection bugs. Empty for the
    // v0.9.0 initial release; see the doc comment above.
    let migrations: &[(&str, &'static str)] = &[];

    for &(col, sql) in migrations {
        if !existing.contains(col) {
            sqlx::query(sql)
                .execute(pool)
                .await
                .map_err(|e| format!("add column {col} to ssh_host_meta: {e}"))?;
        }
    }
    Ok(())
}

/// Ensure the single default row of the `http_server_config` table exists.
///
/// The table itself is created by `schema.sql`'s `CREATE TABLE IF NOT EXISTS`;
/// this guarantees its one-and-only row (id = 1) is present so `storage::http_server::load`
/// always finds a config to read. `INSERT OR IGNORE` is idempotent: on first
/// launch it inserts the defaults (server disabled, port 48610, localhost-only,
/// console logging on); on every later launch the row already exists and the
/// insert is a no-op. The `CHECK(id = 1)` constraint on the table plus this
/// fixed-id insert make a second row impossible.
async fn ensure_http_server_config(pool: &SqlitePool) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT OR IGNORE INTO http_server_config \
         (id, enabled, port, bind_lan, log_to_console, created_at, updated_at) \
         VALUES (1, 0, 48610, 0, 1, ?, ?)",
    )
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await
    .map_err(|e| format!("seed http_server_config default row: {e}"))?;
    Ok(())
}

/// Idempotent `ALTER TABLE … ADD COLUMN …` for the `schedules` table.
///
/// The `schedules` table was introduced whole in v0.2.0, so on first release
/// there are no missing columns to backfill — the migration list is
/// intentionally empty. It exists now (rather than being added later) so
/// future schedule columns have an established, tested home that mirrors
/// [`ensure_workflows_columns`]. The same `PRAGMA table_info` inspection
/// guards idempotency once entries are added.
async fn ensure_schedules_columns(pool: &SqlitePool) -> Result<(), String> {
    let rows = sqlx::query("PRAGMA table_info(schedules)")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("inspect schedules table: {e}"))?;

    let existing: std::collections::HashSet<String> = rows
        .into_iter()
        .filter_map(|r| r.try_get::<String, _>("name").ok())
        .collect();

    // (column_name, "ADD COLUMN …" fragment). Append future columns here.
    // The SQL must be a `&'static str` for sqlx 0.9's `SqlSafeStr` bound —
    // a runtime-built ALTER would also invite injection bugs.
    let migrations: &[(&str, &'static str)] = &[
        (
            "catch_up_policy",
            "ALTER TABLE schedules ADD COLUMN catch_up_policy TEXT NOT NULL DEFAULT 'none'",
        ),
        (
            "timeout_seconds",
            "ALTER TABLE schedules ADD COLUMN timeout_seconds INTEGER",
        ),
        (
            "max_retries",
            "ALTER TABLE schedules ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "capture_output",
            "ALTER TABLE schedules ADD COLUMN capture_output INTEGER NOT NULL DEFAULT 1",
        ),
    ];

    for &(col, sql) in migrations {
        if !existing.contains(col) {
            sqlx::query(sql)
                .execute(pool)
                .await
                .map_err(|e| format!("add column {col} to schedules: {e}"))?;
        }
    }
    Ok(())
}

/// Idempotent `ALTER TABLE … ADD COLUMN …` for the `history_events` table.
///
/// `schedule_id` (added in v0.8.0) denormalises the schedule id for
/// `scheduledRun` events so the schedule view can filter a single schedule's
/// run history without scanning `payload_json`. NULLable, so the migration is
/// safe for existing rows. Mirrors [`ensure_schedules_columns`]; the same
/// `PRAGMA table_info` inspection guards idempotency.
async fn ensure_history_columns(pool: &SqlitePool) -> Result<(), String> {
    let rows = sqlx::query("PRAGMA table_info(history_events)")
        .fetch_all(pool)
        .await
        .map_err(|e| format!("inspect history_events table: {e}"))?;

    let existing: std::collections::HashSet<String> = rows
        .into_iter()
        .filter_map(|r| r.try_get::<String, _>("name").ok())
        .collect();

    // (column_name, "ADD COLUMN …" fragment). Append future columns here.
    // The SQL must be a `&'static str` for sqlx 0.9's `SqlSafeStr` bound —
    // a runtime-built ALTER would also invite injection bugs.
    let migrations: &[(&str, &'static str)] = &[(
        "schedule_id",
        "ALTER TABLE history_events ADD COLUMN schedule_id TEXT",
    )];

    for &(col, sql) in migrations {
        if !existing.contains(col) {
            sqlx::query(sql)
                .execute(pool)
                .await
                .map_err(|e| format!("add column {col} to history_events: {e}"))?;
        }
    }

    // Back-fill `schedule_id` for rows written BEFORE the column existed.
    // The `ALTER TABLE … ADD COLUMN schedule_id TEXT` above leaves every
    // pre-existing row NULL, so a schedule that fired many times before the
    // upgrade would show an empty History tab (the view filters
    // `WHERE schedule_id = ?`). The denormalised id is already inside each
    // `scheduledRun` event's `payload_json` as the camelCase `scheduleId`
    // (serde wire format), so we recover it via SQLite's JSON1 `json_extract`.
    // Guarded by `schedule_id IS NULL`, this is idempotent and a no-op once
    // every row is populated, so it is safe to run on every launch.
    sqlx::query(
        "UPDATE history_events \
         SET schedule_id = json_extract(payload_json, '$.scheduleId') \
         WHERE kind = 'scheduledRun' AND schedule_id IS NULL",
    )
    .execute(pool)
    .await
    .map_err(|e| format!("back-fill history schedule_id: {e}"))?;

    // Create the `schedule_id` index HERE rather than in schema.sql: on an
    // existing database `CREATE TABLE IF NOT EXISTS` does not add the column,
    // and schema.sql runs before the ALTER above — so indexing `schedule_id`
    // there panics with "no such column: schedule_id". By this point the
    // column is guaranteed to exist (fresh DB: created by schema.sql; old DB:
    // just added by the ALTER), so the idempotent index creation is safe.
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_history_schedule_id \
         ON history_events(schedule_id)",
    )
    .execute(pool)
    .await
    .map_err(|e| format!("create idx_history_schedule_id: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fresh_pool() -> SqlitePool {
        let opts = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true);
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap()
    }

    /// Simulate an old database that was created BEFORE `run_as_admin`
    /// existed. The migration must add the column and leave existing
    /// rows untouched (defaulting to 0).
    #[tokio::test]
    async fn ensure_commands_columns_adds_missing_run_as_admin() {
        let pool = fresh_pool().await;
        // Create the "old" schema by hand — same as schema.sql but
        // WITHOUT the run_as_admin column.
        sqlx::raw_sql(
            "CREATE TABLE commands (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                script TEXT NOT NULL,
                tags_json TEXT NOT NULL DEFAULT '[]',
                favorite INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                run_count INTEGER NOT NULL DEFAULT 0
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO commands (id, name, script, created_at, updated_at)
             VALUES ('a', 'n', 'echo', '2026-05-28', '2026-05-28')",
        )
        .execute(&pool)
        .await
        .unwrap();

        ensure_commands_columns(&pool).await.unwrap();

        let row = sqlx::query("SELECT run_as_admin FROM commands WHERE id = 'a'")
            .fetch_one(&pool)
            .await
            .unwrap();
        let v: i64 = row.try_get("run_as_admin").unwrap();
        assert_eq!(v, 0, "existing row must default to run_as_admin = 0");
    }

    /// Running the migration twice must NOT fail (no duplicate-column
    /// error). This is the idempotency invariant.
    #[tokio::test]
    async fn ensure_commands_columns_is_idempotent() {
        let pool = fresh_pool().await;
        sqlx::raw_sql(include_str!("schema.sql"))
            .execute(&pool)
            .await
            .unwrap();
        // The schema already has run_as_admin; the migration should
        // detect it and skip the ALTER.
        ensure_commands_columns(&pool).await.unwrap();
        ensure_commands_columns(&pool).await.unwrap();
    }

    /// The schema must create the `history_events` table on a fresh
    /// database. We check the table is present with the columns the
    /// history module relies on — column-by-column assertions live in
    /// the history module's own tests. This guards against accidental
    /// schema removal during refactors.
    #[tokio::test]
    async fn schema_creates_history_events_table() {
        let pool = fresh_pool().await;
        sqlx::raw_sql(include_str!("schema.sql"))
            .execute(&pool)
            .await
            .unwrap();
        let rows = sqlx::query("PRAGMA table_info(history_events)")
            .fetch_all(&pool)
            .await
            .unwrap();
        let cols: std::collections::HashSet<String> = rows
            .into_iter()
            .filter_map(|r| r.try_get::<String, _>("name").ok())
            .collect();
        for required in [
            "id",
            "created_at",
            "kind",
            "command_id",
            "command_name",
            "payload_json",
            "execution_id",
            "exit_code",
            "duration_ms",
            "status",
            "schedule_id",
        ] {
            assert!(
                cols.contains(required),
                "history_events missing column `{required}`; got {cols:?}"
            );
        }
    }

    /// Simulate an old database created BEFORE `schedule_id` existed. The
    /// migration must add the (NULLable) column and remain idempotent across
    /// repeated calls.
    #[tokio::test]
    async fn ensure_history_columns_adds_missing_schedule_id() {
        let pool = fresh_pool().await;
        // Old history_events schema WITHOUT schedule_id.
        sqlx::raw_sql(
            "CREATE TABLE history_events (
                id TEXT PRIMARY KEY NOT NULL,
                created_at TEXT NOT NULL,
                kind TEXT NOT NULL,
                command_id TEXT,
                command_name TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                execution_id TEXT,
                exit_code INTEGER,
                duration_ms INTEGER,
                status TEXT
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        ensure_history_columns(&pool).await.unwrap();

        let rows = sqlx::query("PRAGMA table_info(history_events)")
            .fetch_all(&pool)
            .await
            .unwrap();
        let cols: std::collections::HashSet<String> = rows
            .into_iter()
            .filter_map(|r| r.try_get::<String, _>("name").ok())
            .collect();
        assert!(cols.contains("schedule_id"), "schedule_id must be added");

        // Running again must remain a no-op (idempotent).
        ensure_history_columns(&pool).await.unwrap();
    }

    /// Re-applying the schema must remain a no-op (CREATE TABLE IF NOT
    /// EXISTS). Same idempotency invariant as for the `commands` table.
    #[tokio::test]
    async fn schema_history_events_creation_is_idempotent() {
        let pool = fresh_pool().await;
        sqlx::raw_sql(include_str!("schema.sql"))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("schema.sql"))
            .execute(&pool)
            .await
            .unwrap();
    }

    /// Simulate an old database that was created BEFORE `variables`
    /// existed. The migration must add the column and default existing
    /// rows to the empty JSON array `'[]'` so list/decode keeps working.
    #[tokio::test]
    async fn ensure_commands_columns_adds_missing_variables() {
        let pool = fresh_pool().await;
        // Old schema — has run_as_admin (so we only test the variables
        // migration step) but no `variables` column.
        sqlx::raw_sql(
            "CREATE TABLE commands (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                script TEXT NOT NULL,
                tags_json TEXT NOT NULL DEFAULT '[]',
                favorite INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                run_count INTEGER NOT NULL DEFAULT 0,
                run_as_admin INTEGER NOT NULL DEFAULT 0
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO commands (id, name, script, created_at, updated_at)
             VALUES ('a', 'n', 'echo', '2026-05-28', '2026-05-28')",
        )
        .execute(&pool)
        .await
        .unwrap();

        ensure_commands_columns(&pool).await.unwrap();

        let row = sqlx::query("SELECT variables FROM commands WHERE id = 'a'")
            .fetch_one(&pool)
            .await
            .unwrap();
        let v: String = row.try_get("variables").unwrap();
        assert_eq!(v, "[]", "existing rows must default to an empty array");

        // Running the migration again must remain a no-op (idempotent).
        ensure_commands_columns(&pool).await.unwrap();
    }

    /// Simulate an old database created BEFORE `scope` / `workflow_id`
    /// existed (v0.7.1). The migration must add both columns, default the
    /// existing row's `scope` to `'global'` and leave `workflow_id` NULL,
    /// and remain idempotent.
    #[tokio::test]
    async fn ensure_commands_columns_adds_missing_scope_and_workflow_id() {
        let pool = fresh_pool().await;
        // Old schema — has the earlier columns but no scope/workflow_id.
        sqlx::raw_sql(
            "CREATE TABLE commands (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                script TEXT NOT NULL,
                tags_json TEXT NOT NULL DEFAULT '[]',
                favorite INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                run_count INTEGER NOT NULL DEFAULT 0,
                run_as_admin INTEGER NOT NULL DEFAULT 0,
                variables TEXT NOT NULL DEFAULT '[]'
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO commands (id, name, script, created_at, updated_at)
             VALUES ('a', 'n', 'echo', '2026-06-15', '2026-06-15')",
        )
        .execute(&pool)
        .await
        .unwrap();

        ensure_commands_columns(&pool).await.unwrap();

        let row = sqlx::query("SELECT scope, workflow_id FROM commands WHERE id = 'a'")
            .fetch_one(&pool)
            .await
            .unwrap();
        let scope: String = row.try_get("scope").unwrap();
        let workflow_id: Option<String> = row.try_get("workflow_id").unwrap();
        assert_eq!(
            scope, "global",
            "existing rows must default to scope='global'"
        );
        assert!(workflow_id.is_none(), "workflow_id must default to NULL");

        // Running the migration again must remain a no-op (idempotent).
        ensure_commands_columns(&pool).await.unwrap();
    }

    /// Simulate a database created BEFORE the `target` column existed
    /// (pre-v0.9.1). The migration must add it, leave existing rows NULL (read
    /// back as `Local`), and remain idempotent.
    #[tokio::test]
    async fn ensure_commands_columns_adds_missing_target() {
        let pool = fresh_pool().await;
        // Schema just before the remote-execution feature: has scope/workflow_id
        // but no `target`.
        sqlx::raw_sql(
            "CREATE TABLE commands (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                script TEXT NOT NULL,
                tags_json TEXT NOT NULL DEFAULT '[]',
                favorite INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                run_count INTEGER NOT NULL DEFAULT 0,
                run_as_admin INTEGER NOT NULL DEFAULT 0,
                variables TEXT NOT NULL DEFAULT '[]',
                scope TEXT NOT NULL DEFAULT 'global',
                workflow_id TEXT
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO commands (id, name, script, created_at, updated_at)
             VALUES ('a', 'n', 'echo', '2026-06-22', '2026-06-22')",
        )
        .execute(&pool)
        .await
        .unwrap();

        ensure_commands_columns(&pool).await.unwrap();

        let row = sqlx::query("SELECT target FROM commands WHERE id = 'a'")
            .fetch_one(&pool)
            .await
            .unwrap();
        let target: Option<String> = row.try_get("target").unwrap();
        assert!(target.is_none(), "existing rows must have a NULL target");

        // Running the migration again must remain a no-op (idempotent).
        ensure_commands_columns(&pool).await.unwrap();
    }

    /// The schema must create the `workflows` table on a fresh database
    /// with the columns the workflows module relies on. Guards against
    /// accidental schema removal during refactors (mirrors the
    /// `history_events` schema test above).
    #[tokio::test]
    async fn schema_creates_workflows_table() {
        let pool = fresh_pool().await;
        sqlx::raw_sql(include_str!("schema.sql"))
            .execute(&pool)
            .await
            .unwrap();
        let rows = sqlx::query("PRAGMA table_info(workflows)")
            .fetch_all(&pool)
            .await
            .unwrap();
        let cols: std::collections::HashSet<String> = rows
            .into_iter()
            .filter_map(|r| r.try_get::<String, _>("name").ok())
            .collect();
        for required in [
            "id",
            "name",
            "description",
            "icon",
            "nodes_json",
            "edges_json",
            "tags_json",
            "category_id",
            "favorite",
            "created_at",
            "updated_at",
            "last_run_at",
            "run_count",
        ] {
            assert!(
                cols.contains(required),
                "workflows missing column `{required}`; got {cols:?}"
            );
        }
    }

    /// `ensure_workflows_columns` must be a no-op on the current schema
    /// and remain idempotent across repeated calls (the invariant future
    /// column-additions rely on).
    #[tokio::test]
    async fn ensure_workflows_columns_is_idempotent() {
        let pool = fresh_pool().await;
        sqlx::raw_sql(include_str!("schema.sql"))
            .execute(&pool)
            .await
            .unwrap();
        ensure_workflows_columns(&pool).await.unwrap();
        ensure_workflows_columns(&pool).await.unwrap();
    }

    /// The schema must create the `schedules` table on a fresh database
    /// with the columns the schedules module relies on. Guards against
    /// accidental schema removal during refactors (mirrors the workflows
    /// schema test above).
    #[tokio::test]
    async fn schema_creates_schedules_table() {
        let pool = fresh_pool().await;
        sqlx::raw_sql(include_str!("schema.sql"))
            .execute(&pool)
            .await
            .unwrap();
        let rows = sqlx::query("PRAGMA table_info(schedules)")
            .fetch_all(&pool)
            .await
            .unwrap();
        let cols: std::collections::HashSet<String> = rows
            .into_iter()
            .filter_map(|r| r.try_get::<String, _>("name").ok())
            .collect();
        for required in [
            "id",
            "name",
            "enabled",
            "target_kind",
            "target_id",
            "cron",
            "variable_values",
            "skip_if_running",
            "catch_up_policy",
            "timeout_seconds",
            "max_retries",
            "capture_output",
            "created_at",
            "updated_at",
            "last_run_at",
            "last_run_status",
            "next_run_at",
            "run_count",
        ] {
            assert!(
                cols.contains(required),
                "schedules missing column `{required}`; got {cols:?}"
            );
        }
    }

    /// `ensure_schedules_columns` must be a no-op on the current schema and
    /// remain idempotent across repeated calls (the invariant future
    /// column-additions rely on).
    #[tokio::test]
    async fn ensure_schedules_columns_is_idempotent() {
        let pool = fresh_pool().await;
        sqlx::raw_sql(include_str!("schema.sql"))
            .execute(&pool)
            .await
            .unwrap();
        ensure_schedules_columns(&pool).await.unwrap();
        ensure_schedules_columns(&pool).await.unwrap();
    }

    /// Regression for the startup panic "no such column: schedule_id".
    ///
    /// Reproduces the REAL upgrade path on a database that predates the
    /// `schedule_id` column: an existing `history_events` table WITHOUT the
    /// column, then `schema.sql` (whose `CREATE TABLE IF NOT EXISTS` is a
    /// no-op for the existing table) followed by `ensure_history_columns`,
    /// exactly as `init_pool` runs them. If `schema.sql` were to index
    /// `schedule_id` (it must NOT — the index lives in ensure_history_columns),
    /// the `CREATE INDEX` would fire before the column existed and panic. This
    /// test fails iff that ordering bug is reintroduced.
    #[tokio::test]
    async fn upgrade_old_history_db_does_not_panic_on_schedule_id_index() {
        let pool = fresh_pool().await;
        // Pre-create an "old" history_events table WITHOUT schedule_id (the
        // pre-v0.8.0 shape) so schema.sql's CREATE TABLE IF NOT EXISTS is a
        // no-op against it.
        sqlx::raw_sql(
            "CREATE TABLE history_events (
                id TEXT PRIMARY KEY NOT NULL,
                created_at TEXT NOT NULL,
                kind TEXT NOT NULL,
                command_id TEXT,
                command_name TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                execution_id TEXT,
                exit_code INTEGER,
                duration_ms INTEGER,
                status TEXT
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Apply schema.sql exactly like init_pool. This must NOT fail with
        // "no such column: schedule_id" (the original startup panic).
        sqlx::raw_sql(include_str!("schema.sql"))
            .execute(&pool)
            .await
            .expect("schema.sql must not reference schedule_id before the ALTER");

        // Then the idempotent column-add + index creation.
        ensure_history_columns(&pool).await.unwrap();

        // The column now exists.
        let rows = sqlx::query("PRAGMA table_info(history_events)")
            .fetch_all(&pool)
            .await
            .unwrap();
        let cols: std::collections::HashSet<String> = rows
            .into_iter()
            .filter_map(|r| r.try_get::<String, _>("name").ok())
            .collect();
        assert!(cols.contains("schedule_id"), "schedule_id must be added");

        // And the index exists (created by ensure_history_columns).
        let idx = sqlx::query(
            "SELECT name FROM sqlite_master \
             WHERE type = 'index' AND name = 'idx_history_schedule_id'",
        )
        .fetch_optional(&pool)
        .await
        .unwrap();
        assert!(idx.is_some(), "idx_history_schedule_id must be created");

        // Whole upgrade is idempotent on a second pass.
        sqlx::raw_sql(include_str!("schema.sql"))
            .execute(&pool)
            .await
            .unwrap();
        ensure_history_columns(&pool).await.unwrap();
    }

    /// Regression for the empty "История" tab: a schedule with runs recorded
    /// BEFORE the `schedule_id` column existed must still appear in the
    /// schedule-history filter after upgrade. `ensure_history_columns` must
    /// back-fill `schedule_id` from each `scheduledRun` row's
    /// `payload_json.scheduleId`; without the back-fill those rows stay NULL
    /// and `WHERE schedule_id = ?` matches nothing.
    #[tokio::test]
    async fn ensure_history_columns_backfills_schedule_id_from_payload() {
        let pool = fresh_pool().await;
        // Old history_events table WITHOUT schedule_id.
        sqlx::raw_sql(
            "CREATE TABLE history_events (
                id TEXT PRIMARY KEY NOT NULL,
                created_at TEXT NOT NULL,
                kind TEXT NOT NULL,
                command_id TEXT,
                command_name TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                execution_id TEXT,
                exit_code INTEGER,
                duration_ms INTEGER,
                status TEXT
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        // An old scheduledRun row: the schedule id lives only inside
        // payload_json (camelCase `scheduleId`, the serde wire shape).
        sqlx::query(
            "INSERT INTO history_events \
             (id, created_at, kind, command_name, payload_json) \
             VALUES (?, ?, 'scheduledRun', ?, ?)",
        )
        .bind("evt-1")
        .bind("2026-06-01T00:00:00Z")
        .bind("Nightly backup")
        .bind(
            r#"{"kind":"scheduledRun","scheduleId":"sched-42",
                "scheduleName":"Nightly backup","targetKind":"command",
                "targetId":"cmd-1","status":"success"}"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        // A non-scheduled row must stay NULL (back-fill is scheduledRun-only).
        sqlx::query(
            "INSERT INTO history_events \
             (id, created_at, kind, command_name, payload_json) \
             VALUES (?, ?, 'commandCreated', ?, ?)",
        )
        .bind("evt-2")
        .bind("2026-06-01T00:00:01Z")
        .bind("Greet")
        .bind(r#"{"kind":"commandCreated"}"#)
        .execute(&pool)
        .await
        .unwrap();

        ensure_history_columns(&pool).await.unwrap();

        // The old scheduledRun row is back-filled from payload_json.
        let sched: Option<String> =
            sqlx::query("SELECT schedule_id FROM history_events WHERE id = 'evt-1'")
                .fetch_one(&pool)
                .await
                .unwrap()
                .try_get("schedule_id")
                .unwrap();
        assert_eq!(
            sched.as_deref(),
            Some("sched-42"),
            "scheduledRun row must be back-filled from payload_json.scheduleId"
        );

        // The non-scheduled row stays NULL.
        let non_sched: Option<String> =
            sqlx::query("SELECT schedule_id FROM history_events WHERE id = 'evt-2'")
                .fetch_one(&pool)
                .await
                .unwrap()
                .try_get("schedule_id")
                .unwrap();
        assert_eq!(non_sched, None, "non-scheduled rows must remain NULL");

        // Idempotent: a second pass changes nothing and does not error.
        ensure_history_columns(&pool).await.unwrap();
        let sched2: Option<String> =
            sqlx::query("SELECT schedule_id FROM history_events WHERE id = 'evt-1'")
                .fetch_one(&pool)
                .await
                .unwrap()
                .try_get("schedule_id")
                .unwrap();
        assert_eq!(sched2.as_deref(), Some("sched-42"));
    }

    /// A fresh database must seed exactly ONE `http_server_config` row with the
    /// documented defaults (disabled, port 48610, localhost, console-log on).
    /// Running the seeder twice must remain a no-op (idempotent) and must NOT
    /// create a second row.
    #[tokio::test]
    async fn ensure_http_server_config_seeds_single_default_row() {
        let pool = fresh_pool().await;
        sqlx::raw_sql(include_str!("schema.sql"))
            .execute(&pool)
            .await
            .unwrap();
        ensure_http_server_config(&pool).await.unwrap();
        // Second pass must not duplicate the row.
        ensure_http_server_config(&pool).await.unwrap();

        let count: i64 = sqlx::query("SELECT COUNT(*) AS n FROM http_server_config")
            .fetch_one(&pool)
            .await
            .unwrap()
            .try_get("n")
            .unwrap();
        assert_eq!(count, 1, "exactly one config row must exist");

        let row = sqlx::query(
            "SELECT enabled, port, bind_lan, log_to_console FROM http_server_config WHERE id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.try_get::<i64, _>("enabled").unwrap(), 0);
        assert_eq!(row.try_get::<i64, _>("port").unwrap(), 48610);
        assert_eq!(row.try_get::<i64, _>("bind_lan").unwrap(), 0);
        assert_eq!(row.try_get::<i64, _>("log_to_console").unwrap(), 1);
    }

    /// Simulate a database created BEFORE the `api_slug` / `api_enabled` columns
    /// existed (pre-v0.10.0). The migration must add both, leave the existing
    /// row's `api_slug` NULL and `api_enabled` 0, create the partial unique
    /// index, and remain idempotent.
    #[tokio::test]
    async fn ensure_commands_columns_adds_missing_api_fields() {
        let pool = fresh_pool().await;
        sqlx::raw_sql(
            "CREATE TABLE commands (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                script TEXT NOT NULL,
                tags_json TEXT NOT NULL DEFAULT '[]',
                favorite INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                run_count INTEGER NOT NULL DEFAULT 0
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO commands (id, name, script, created_at, updated_at)
             VALUES ('a', 'n', 'echo', '2026-06-24', '2026-06-24')",
        )
        .execute(&pool)
        .await
        .unwrap();

        ensure_commands_columns(&pool).await.unwrap();

        let row = sqlx::query("SELECT api_slug, api_enabled FROM commands WHERE id = 'a'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(row.try_get::<Option<String>, _>("api_slug").unwrap().is_none());
        assert_eq!(row.try_get::<i64, _>("api_enabled").unwrap(), 0);

        // The partial unique index must exist.
        let idx = sqlx::query(
            "SELECT name FROM sqlite_master \
             WHERE type = 'index' AND name = 'idx_commands_api_slug'",
        )
        .fetch_optional(&pool)
        .await
        .unwrap();
        assert!(idx.is_some(), "idx_commands_api_slug must be created");

        // Idempotent on a second pass.
        ensure_commands_columns(&pool).await.unwrap();
    }

    /// The partial unique index must REJECT two commands sharing a non-NULL
    /// `api_slug`, while allowing many rows with NULL slug to coexist.
    #[tokio::test]
    async fn commands_api_slug_unique_index_rejects_duplicates() {
        let pool = fresh_pool().await;
        sqlx::raw_sql(include_str!("schema.sql"))
            .execute(&pool)
            .await
            .unwrap();
        ensure_commands_columns(&pool).await.unwrap();

        // Two NULL-slug rows are fine.
        for id in ["a", "b"] {
            sqlx::query(
                "INSERT INTO commands (id, name, script, created_at, updated_at)
                 VALUES (?, 'n', 'echo', '2026-06-24', '2026-06-24')",
            )
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        }

        sqlx::query(
            "INSERT INTO commands (id, name, script, created_at, updated_at, api_slug)
             VALUES ('c', 'n', 'echo', '2026-06-24', '2026-06-24', 'deploy')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // A second row with the SAME slug must fail.
        let dup = sqlx::query(
            "INSERT INTO commands (id, name, script, created_at, updated_at, api_slug)
             VALUES ('d', 'n', 'echo', '2026-06-24', '2026-06-24', 'deploy')",
        )
        .execute(&pool)
        .await;
        assert!(dup.is_err(), "duplicate api_slug must be rejected by the index");
    }
}
