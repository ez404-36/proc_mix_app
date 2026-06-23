-- Schema for the local SQLite database backing the command library.
-- Applied on every app launch via `CREATE TABLE IF NOT EXISTS` so the
-- migration is idempotent. v0.2.0 will introduce a real schema_version
-- table and incremental migrations; for the MVP a single table is enough.

CREATE TABLE IF NOT EXISTS commands (
  id              TEXT PRIMARY KEY NOT NULL,
  name            TEXT NOT NULL,
  name_key        TEXT,
  description     TEXT,
  description_key TEXT,
  icon            TEXT,
  script          TEXT NOT NULL,
  shell           TEXT,
  args_json       TEXT,
  working_dir     TEXT,
  env_json        TEXT,
  tags_json       TEXT NOT NULL DEFAULT '[]',
  category_id     TEXT,
  favorite        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_run_at     TEXT,
  run_count       INTEGER NOT NULL DEFAULT 0,
  -- Whether this command should be spawned with elevated privileges
  -- (sudo on Unix, UAC on Windows). Default 0. Added in v0.2.0; the
  -- companion idempotent ALTER in db.rs::ensure_commands_columns
  -- handles databases created before this column existed.
  run_as_admin    INTEGER NOT NULL DEFAULT 0,
  -- JSON-encoded array of VariableSpec (see storage/commands.rs).
  -- Used by the parser layer to resolve `${name}` / `${name:default}`
  -- references in script, args, workingDir, and env values. Added in
  -- v0.5.0; the companion ALTER in db.rs::ensure_commands_columns
  -- handles databases created before this column existed.
  variables       TEXT NOT NULL DEFAULT '[]',
  -- Optional execution timeout in seconds. NULL means no limit. When
  -- set, the executor kills the spawned process after this many seconds.
  -- Added in v0.6.0; the companion ALTER in db.rs::ensure_commands_columns
  -- handles databases created before this column existed.
  timeout_seconds INTEGER,
  -- JSON-encoded OutputSchemaRecord (see storage/commands.rs). NULL when
  -- the command has no output schema. Consumed by core::extractor after a
  -- run finishes to parse stdout into named fields. Added in v0.7.0; the
  -- companion ALTER in db.rs::ensure_commands_columns handles databases
  -- created before this column existed.
  output_schema   TEXT,
  -- Visibility scope: 'global' (default, shared library) or 'local' (private
  -- to one workflow — hidden from the global library, usable only inside its
  -- owning workflow's editor; see `workflow_id`). Added in v0.7.1; the
  -- companion ALTER in db.rs::ensure_commands_columns handles databases
  -- created before this column existed.
  scope           TEXT NOT NULL DEFAULT 'global',
  -- Owning workflow id for a 'local'-scoped command (NULL for globals). When
  -- the owning workflow is deleted, its local commands are cascade-deleted
  -- (see storage/commands.rs::delete_local_for_workflow). Added in v0.7.1.
  workflow_id     TEXT,
  -- Where the command runs: JSON-encoded ExecutionTarget
  -- ({"kind":"local"} / {"kind":"remote","alias":...} / {"kind":"remotePrompt"}).
  -- NULL means local (legacy rows / commands that never set a target). Added
  -- in v0.9.1; see docs/ssh-remote-execution.md and core::executor::ExecutionTarget.
  target          TEXT
);

CREATE INDEX IF NOT EXISTS idx_commands_favorite ON commands(favorite);
CREATE INDEX IF NOT EXISTS idx_commands_last_run_at ON commands(last_run_at);

-- Action history. Records create/edit/delete/run events for commands so the
-- "History" view can show a paginated, filterable timeline AND so the user
-- can undo an edit / restore a deleted command from the snapshot stored in
-- `payload_json`. `command_name` is denormalised on purpose:
-- (1) filter by name without JOIN, (2) records survive deletion of the
-- referenced command. `kind` is the serde discriminator from
-- HistoryEventPayload. `payload_json` holds the full serialised variant.
-- The dedicated run columns (`execution_id`, `exit_code`, `duration_ms`,
-- `status`) exist so run events can be updated when the Finished/Cancelled
-- bridge event arrives without a JSON decode/encode round-trip.
CREATE TABLE IF NOT EXISTS history_events (
  id            TEXT PRIMARY KEY NOT NULL,
  created_at    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  command_id    TEXT,
  command_name  TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  execution_id  TEXT,
  exit_code     INTEGER,
  duration_ms   INTEGER,
  status        TEXT,
  -- Denormalised schedule id for `scheduledRun` events (NULL for every other
  -- kind). Lets the schedule view's History tab filter a single schedule's
  -- run history without a JSON scan. Added in v0.8.0; the companion ALTER in
  -- db.rs::ensure_history_columns handles databases created before it existed.
  schedule_id   TEXT
);

CREATE INDEX IF NOT EXISTS idx_history_created_at ON history_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_kind ON history_events(kind);
CREATE INDEX IF NOT EXISTS idx_history_command_name ON history_events(command_name);
CREATE INDEX IF NOT EXISTS idx_history_execution_id ON history_events(execution_id);
-- NOTE: the `schedule_id` index is intentionally NOT created here. On a
-- database that predates the `schedule_id` column, `CREATE TABLE IF NOT
-- EXISTS` above is a no-op (so the column is still missing at this point) and
-- this script runs BEFORE the idempotent `ALTER TABLE … ADD COLUMN schedule_id`
-- in db.rs::ensure_history_columns — indexing a not-yet-added column panics
-- with "no such column: schedule_id". The index is created in
-- ensure_history_columns instead, AFTER the column is guaranteed to exist.

-- Workflows: the visual-editor automation graphs (v0.5.0). A workflow is a
-- directed graph of nodes (start / command / condition / end) connected by
-- branch-labelled edges. The graph is persisted as two JSON-encoded TEXT
-- columns (`nodes_json`, `edges_json`) decoded by storage/workflows.rs —
-- the same pattern the `commands` table uses for `args_json` / `env_json`.
-- The execution engine (core/workflow.rs) traverses the decoded graph; the
-- visual editor owns the node `position` coordinates carried inside
-- `nodes_json`.
CREATE TABLE IF NOT EXISTS workflows (
  id            TEXT PRIMARY KEY NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  icon          TEXT,
  nodes_json    TEXT NOT NULL DEFAULT '[]',
  edges_json    TEXT NOT NULL DEFAULT '[]',
  tags_json     TEXT NOT NULL DEFAULT '[]',
  category_id   TEXT,
  favorite      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_run_at   TEXT,
  run_count     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_workflows_favorite ON workflows(favorite);
CREATE INDEX IF NOT EXISTS idx_workflows_last_run_at ON workflows(last_run_at);

-- Schedules: cron-driven automatic runs of a command OR a workflow (v0.2.0).
-- The Scheduler (core/scheduler.rs) runs a single in-process Tokio loop that
-- fires each enabled schedule when its `cron` expression becomes due. Runs
-- only happen while the app is running (incl. minimized to tray); missed runs
-- while closed are skipped (next_run is recomputed from now on startup).
--
-- `cron` is a 5-field Unix cron string as typed by the user; the scheduler
-- normalises it to the 7-field form the `cron` crate expects. `target_kind`
-- discriminates the run target ('command' | 'workflow'); `target_id` is the
-- logical FK into commands.id / workflows.id. `variable_values` stores the
-- per-run variable values resolved AT CREATION (headless runs cannot prompt):
-- for a command target it is a JSON object of name->value; for a workflow it
-- is a JSON object of nodeId->(name->value). `skip_if_running` suppresses a
-- fire when the schedule's previous run is still in flight.
--
-- Schedules are intentionally NOT part of export/import — they are local to a
-- machine's clock and not portable.
CREATE TABLE IF NOT EXISTS schedules (
  id                TEXT PRIMARY KEY NOT NULL,
  name              TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  target_kind       TEXT NOT NULL,
  target_id         TEXT NOT NULL,
  cron              TEXT NOT NULL,
  variable_values   TEXT NOT NULL DEFAULT '{}',
  skip_if_running   INTEGER NOT NULL DEFAULT 0,
  -- Whether this schedule's background-fire output (console log + output-schema
  -- result) is persisted to history. Default 1 (ON). When 0, a scheduled fire
  -- still records its `scheduledRun` history event but without the captured
  -- output/result detail. Added in v0.8.0; the companion idempotent ALTER in
  -- db.rs::ensure_schedules_columns handles databases created before this
  -- column existed.
  capture_output    INTEGER NOT NULL DEFAULT 1,
  -- Missed-run policy when the app was closed across a fire time:
  -- 'none' (skip, default), 'once' (run a single catch-up), or 'all'
  -- (run one catch-up per missed occurrence, capped).
  catch_up_policy   TEXT NOT NULL DEFAULT 'none',
  -- Optional per-run timeout in seconds for a COMMAND target, overriding the
  -- command's own timeout. NULL = use the command's timeout (or none).
  timeout_seconds   INTEGER,
  -- How many times to re-run the target after a failed attempt (0 = no
  -- retries). A run succeeds as soon as one attempt exits cleanly.
  max_retries       INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  last_run_at       TEXT,
  last_run_status   TEXT,
  next_run_at       TEXT,
  run_count         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled);

-- SSH host metadata (v0.9.0). ProcMix-owned state for SSH connections whose
-- PARAMETERS live in their source of truth (`~/.ssh/config`, …) and are parsed
-- read-only by `core::ssh` — never duplicated here. This table stores only the
-- bits that have no home in an SSH config: the outcome/time of the last
-- reachability check. Keyed by the composite host key `"<source>:<name>"`
-- (see `core::ssh::SshHostId::key`) so the same alias in different sources keeps
-- independent metadata. Rows are created lazily on first check; a host with no
-- row simply renders as "not checked yet". See `storage/ssh_host_meta.rs`.
CREATE TABLE IF NOT EXISTS ssh_host_meta (
  host_key      TEXT PRIMARY KEY NOT NULL,
  -- RFC 3339 timestamp of the last reachability check (NULL = never).
  last_check_at TEXT,
  -- Last check result as INTEGER 0/1 (SQLite has no bool); NULL = never checked.
  last_check_ok INTEGER
);
