// Data persistence layer: SQLite via sqlx.
//
// `db` owns the connection-pool bootstrap; `commands` contains the CRUD
// helpers for the `commands` table that backs the command library;
// `workflows` contains the CRUD helpers for the `workflows` table that
// backs the visual automation editor; `history` records action events
// (create / edit / delete / run) for the "History" view and powers the
// undo/restore flows; `schedules` backs the cron Scheduler (v0.2.0) that
// fires commands / workflows automatically while the app is running.

pub mod commands;
pub mod db;
pub mod env_config;
pub mod history;
pub mod http_server;
pub mod schedules;
pub mod ssh_host_meta;
pub mod workflows;

pub use db::{init_pool, DbPool};
