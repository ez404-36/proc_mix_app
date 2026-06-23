mod commands;
// `core` and `storage` are exposed publicly so the integration tests
// in `tests/` can reach the executor + storage types directly. `security`
// is public so the `procmix-askpass` sidecar binary (a sibling `[[bin]]`
// that links this lib) can call `security::ssh_oneshot::take`. Item
// visibility inside each module is unchanged — making the parent `pub`
// does not widen any private item.
pub mod core;
mod platform;
mod plugins;
pub mod security;
pub mod storage;

use std::sync::Arc;

use tauri::Manager;

use crate::core::executor::ExecutorState;
use crate::core::scheduler::{self, SchedulerState};
use crate::core::workflow::WorkflowExecutorState;
use crate::platform::process_watch::WatcherState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Restore the main window to the position, size and monitor it had on
    // the previous launch. Desktop-only — the plugin (and its dependency)
    // are not available on mobile targets.
    //
    // VISIBLE is deliberately excluded from the persisted flags: the window
    // is hidden (not closed) when sent to the tray, so persisting visibility
    // would make the app start up hidden after a restart. We only ever want
    // to restore geometry, never the hidden/shown state.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(
        tauri_plugin_window_state::Builder::default()
            .with_state_flags(
                tauri_plugin_window_state::StateFlags::SIZE
                    | tauri_plugin_window_state::StateFlags::POSITION
                    | tauri_plugin_window_state::StateFlags::MAXIMIZED
                    | tauri_plugin_window_state::StateFlags::FULLSCREEN,
            )
            .build(),
    );

    builder
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = crate::platform::tray::show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Arc::new(ExecutorState::new()))
        .manage(Arc::new(WorkflowExecutorState::new()))
        .manage(Arc::new(WatcherState::new()))
        // Cron Scheduler state (v0.2.0). The loop itself is spawned in the
        // setup hook once the DB pool exists; this holds the reload signal
        // the schedule commands pulse on every mutation.
        .manage(Arc::new(SchedulerState::new()))
        // Shared SSH inventory baseline: the watcher diffs against it and the
        // save/delete commands advance it to echo-suppress ProcMix's own
        // writes (so they aren't logged as external changes).
        .manage(Arc::new(crate::core::ssh::SshWatchState::new()))
        .setup(|app| {
            // Initialise the SQLite-backed command library. `setup` is a
            // synchronous Tauri hook, so we block_on the async pool
            // bootstrap; this happens exactly once on startup and the
            // resulting `Arc<SqlitePool>` is stored in app state for
            // every subsequent IPC handler.
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("resolve app_data_dir: {e}"))?;
            let db_path = app_data_dir.join("procmix.db");
            let pool =
                tauri::async_runtime::block_on(async { crate::storage::init_pool(db_path).await })?;
            app.manage(pool);

            // One-time security migration: move any PLAINTEXT sensitive
            // scheduled-variable values a pre-upgrade database stored in the
            // `schedules.variable_values` column into the OS keychain. Runs
            // once per launch and is a cheap no-op once migrated. Best-effort
            // (keychain failures are logged, never fatal) so the app always
            // starts. See `scheduler::migrate_plaintext_schedule_secrets`.
            {
                let pool = app.state::<crate::storage::DbPool>().inner().clone();
                tauri::async_runtime::block_on(async {
                    scheduler::migrate_plaintext_schedule_secrets(&pool).await;
                });
            }

            // Migration notice: if the user has a `env-files.json` left over
            // from the old "global .env manager" feature, log a warning so it
            // is visible in the dev console. The file is intentionally left
            // on disk (it is harmless) — we do not try to automatically migrate
            // it because global files had no per-command association.
            if let Ok(cfg_dir) = app.path().app_config_dir() {
                let legacy = cfg_dir.join("env-files.json");
                if legacy.exists() {
                    eprintln!(
                        "[procmix] MIGRATION WARNING: legacy env-files.json found at {}. \
                         The global .env manager feature has been removed. \
                         This file is no longer read. If you registered .env files there, \
                         add them to individual commands via the Env tab in the command form.",
                        legacy.display()
                    );
                }
            }

            // Start the cron Scheduler loop now that the DB pool exists. It
            // runs for the lifetime of the process, firing enabled schedules
            // while the app is running (incl. minimized to tray). Missed
            // occurrences (app was closed) are skipped — the loop recomputes
            // each schedule's next run from `now` on startup.
            {
                let scheduler_state = app.state::<Arc<SchedulerState>>().inner().clone();
                let pool = app.state::<crate::storage::DbPool>().inner().clone();
                let executor_state = app.state::<Arc<ExecutorState>>().inner().clone();
                let workflow_state = app.state::<Arc<WorkflowExecutorState>>().inner().clone();
                scheduler::spawn_scheduler_loop(
                    app.handle().clone(),
                    scheduler_state,
                    pool,
                    executor_state,
                    workflow_state,
                );
            }

            // Start the SSH config watcher: polls ~/.ssh/config for changes
            // made outside ProcMix (terminal/VS Code) and emits an event so
            // the Connections tab auto-refreshes. Runs for the process
            // lifetime; the manual Refresh button remains as a fallback.
            crate::core::ssh::spawn_ssh_config_watch(app.handle().clone());

            crate::platform::tray::build_tray(app.handle())?;

            if let Some(main_window) = app.get_webview_window("main") {
                crate::platform::tray::install_close_to_tray(&main_window);

                #[cfg(debug_assertions)]
                main_window.open_devtools();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::execute_command,
            commands::cancel_execution,
            commands::list_running_executions,
            commands::update_tray_menu,
            commands::get_platform,
            commands::get_available_shells,
            commands::fetch_utility_help,
            commands::parse_utility_flags,
            commands::preview_extraction,
            commands::list_commands,
            commands::upsert_command,
            commands::delete_command,
            commands::delete_local_commands_for_workflow,
            commands::list_workflows,
            commands::upsert_workflow,
            commands::delete_workflow,
            commands::execute_workflow,
            commands::run_workflow_from_node,
            commands::cancel_workflow,
            commands::list_schedules,
            commands::upsert_schedule,
            commands::delete_schedule,
            commands::set_schedule_enabled,
            commands::run_schedule_now,
            commands::preview_next_runs,
            commands::admin_password_status,
            commands::set_admin_password,
            commands::clear_admin_password,
            commands::list_history,
            commands::get_history_event,
            commands::record_history_event,
            commands::update_run_history_event,
            commands::delete_history_event,
            commands::clear_history,
            commands::export_data,
            commands::import_data,
            commands::start_process_capture,
            commands::stop_process_capture,
            commands::process_capture_status,
            commands::list_capture_targets,
            commands::get_process_env,
            commands::list_env_files,
            commands::add_env_file,
            commands::remove_env_file,
            commands::read_env_file,
            commands::write_env_file_entry,
            commands::delete_env_file_entry,
            commands::pick_env_file,
            commands::get_user_env_with_sources,
            commands::get_root_env_with_sources,
            commands::open_windows_env_dialog,
            commands::list_ssh_hosts,
            commands::check_ssh_host,
            commands::save_ssh_host,
            commands::delete_ssh_host,
        ])
        // Build (not `run`) so we can observe `RunEvent`s. The exit hook below
        // needs `app` and the managed `ExecutorState` to tear running children
        // down synchronously before the process goes away.
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // On exit, synchronously SIGTERM every in-flight run's process
            // group (so a remote run's detached `ssh` doesn't linger as an
            // orphan) and clear any one-shot SSH-password keychain entries.
            // `ExitRequested` fires while the app state is still available and
            // before the runtime is fully gone — the right moment for a
            // best-effort cleanup. We don't prevent the exit.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let executor = app_handle.state::<Arc<ExecutorState>>();
                crate::core::executor::shutdown_all_sync(executor.inner());
            }
        });
}
