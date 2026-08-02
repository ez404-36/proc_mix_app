mod commands;
// `core` and `storage` are exposed publicly so the integration tests
// in `tests/` can reach the executor + storage types directly. `security`
// is public so the `procmix-askpass` sidecar binary (a sibling `[[bin]]`
// that links this lib) can call `security::ssh_oneshot::take`. Item
// visibility inside each module is unchanged — making the parent `pub`
// does not widen any private item.
pub mod core;
mod platform;
pub mod plugins;
pub mod security;
pub mod storage;

use std::sync::Arc;

use tauri::Manager;

use crate::core::executor::ExecutorState;
use crate::core::http_server::{self, HttpServerState};
use crate::core::scheduler::{self, SchedulerState};
use crate::core::terminal::TerminalState;
use crate::core::workflow::WorkflowExecutorState;
use crate::platform::process_watch::WatcherState;

/// Install the process-wide `tracing` subscriber exactly once, on startup.
///
/// The backend uses `tracing::{error,warn,info,debug}` for all diagnostic
/// output; without a subscriber those events are dropped. The `fmt` subscriber
/// writes them to stderr (matching the previous `eprintln!` destination), and
/// the `EnvFilter` honours the standard `RUST_LOG` env var, defaulting to
/// `info` so warnings and errors are visible out of the box. `try_init` is used
/// so a second call (e.g. in a test harness that already set a global default)
/// is a harmless no-op rather than a panic.
fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .try_init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load `app/.env` (if present) before anything reads the environment, so
    // local-dev overrides like PROCMIX_PLUGIN_CATALOG take effect. Best-effort:
    // a missing `.env` is normal and not an error. `.env` is gitignored;
    // `.env.example` documents the available keys.
    let _ = dotenvy::dotenv();

    init_tracing();

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

    // Autostart at system login (Settings → Autostart). Desktop-only — the
    // plugin (and the whole feature) is not available on mobile. The app is
    // registered with the `--autostart` argument so the setup hook can tell a
    // system-launched start from a manual one and apply the "start minimized to
    // tray" preference. macOS uses the LaunchAgent backend (not AppleScript) to
    // avoid a Terminal window / Automation prompt.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        Some(vec!["--autostart"]),
    ));

    // Native notifications for the tray "Favorites" quick-launch outcome
    // (v0.12.0). Desktop-only — the plugin (and the tray) are unavailable on
    // mobile. The notification is raised from Rust (`platform::tray`), so no JS
    // capability is required.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_notification::init());

    builder
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second launch can be the OS file-manager firing a favorite
            // (`--run-favorite <kind>:<id> --path <p>`). Route that to the
            // HEADLESS quick-launch path WITHOUT showing the window. `argv`
            // includes the program name at [0], so skip it before parsing.
            if let Some(run) = crate::core::launch::parse_run_args(argv.get(1..).unwrap_or(&[])) {
                crate::platform::tray::spawn_shell_launch(app, run);
            } else {
                // A normal second launch (user re-opened ProcMix) brings the
                // existing window to the front.
                let _ = crate::platform::tray::show_main_window(app);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Arc::new(ExecutorState::new()))
        .manage(Arc::new(WorkflowExecutorState::new()))
        // Interactive Terminal session registry (real PTY tabs opened from
        // the console). Deliberately separate from `ExecutorState` — see
        // `core::terminal` module docs and `docs/interactive-terminal.md`.
        .manage(Arc::new(TerminalState::new()))
        .manage(Arc::new(WatcherState::new()))
        // Cron Scheduler state (v0.2.0). The loop itself is spawned in the
        // setup hook once the DB pool exists; this holds the reload signal
        // the schedule commands pulse on every mutation.
        .manage(Arc::new(SchedulerState::new()))
        // Built-in HTTP API server state (v0.10.0). The server task itself is
        // spawned in the setup hook (autostart) once the DB pool exists; this
        // holds the running handle + shutdown signal + request log the Tauri
        // commands operate on.
        .manage(Arc::new(HttpServerState::new()))
        // Shared SSH inventory baseline: the watcher diffs against it and the
        // save/delete commands advance it to echo-suppress ProcMix's own
        // writes (so they aren't logged as external changes).
        .manage(Arc::new(crate::core::ssh::SshWatchState::new()))
        // Pending quick-launch prompt (v0.12.0): holds the command awaiting
        // interactive input while the standalone prompt dialog collects it.
        .manage(Arc::new(
            crate::platform::quick_prompt::QuickPromptState::new(),
        ))
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

            // Resolve the plugin roots once and store them in app state. The
            // catalog source comes from `PROCMIX_PLUGIN_CATALOG` (or a
            // build-aware default: the local `.mocks/plugins` in dev, the
            // bundled catalog in release); `installed` is the per-user app-data
            // dir. A missing directory is fine — treated as empty. Nothing is
            // executed here; install copies data only.
            {
                let resource_dir = app
                    .path()
                    .resource_dir()
                    .map_err(|e| format!("resolve resource_dir: {e}"))?;
                // `dev_root` is the `app/` directory: in dev the crate lives at
                // `app/src-tauri`, so its parent is `app/`. Used for the
                // `.mocks/plugins` default and relative env paths.
                let dev_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .map(std::path::Path::to_path_buf)
                    .unwrap_or_else(|| std::path::PathBuf::from("."));
                let roots =
                    crate::plugins::PluginRoots::new(&dev_root, &resource_dir, &app_data_dir);
                app.manage(Arc::new(crate::commands::plugins::PluginState { roots }));
            }

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
                    tracing::warn!(
                        "MIGRATION WARNING: legacy env-files.json found at {}. \
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

            // Autostart the built-in HTTP API server when the persisted config
            // has it enabled. Spawned AFTER `app.manage(pool)` so the pool /
            // executor states exist (same ordering discipline as the scheduler).
            // Best-effort: a bind failure is logged inside `autostart_if_enabled`
            // and never blocks startup.
            {
                let http_state = app.state::<Arc<HttpServerState>>().inner().clone();
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    http_server::autostart_if_enabled(&app_handle, &http_state).await;
                });
            }

            // Start the SSH config watcher: polls ~/.ssh/config for changes
            // made outside ProcMix (terminal/VS Code) and emits an event so
            // the Connections tab auto-refreshes. Runs for the process
            // lifetime; the manual Refresh button remains as a fallback.
            crate::core::ssh::spawn_ssh_config_watch(app.handle().clone());

            crate::platform::tray::build_tray(app.handle())?;

            // The main window is configured `"visible": false` so it never
            // flashes on screen before we decide whether to show it. Show it now
            // UNLESS the process was launched by the OS at login (`--autostart`)
            // AND the user enabled "start minimized to tray" — in that case the
            // app lives only in the tray until the user opens it. A manual launch
            // (no `--autostart`) always shows the window, regardless of the flag.
            //
            // The `tauri-plugin-window-state` plugin restores geometry on the
            // window independently of visibility, so the restored size/position
            // is correct whether we show it now or later from the tray.
            let launched_by_os = std::env::args().any(|arg| arg == "--autostart");

            // COLD-START shell launch: the OS file manager launched ProcMix
            // (no prior instance) with `--run-favorite …`. Fire the favorite
            // headlessly and keep the window hidden — the app behaves like a
            // background quick-launch, then lives in the tray. The state
            // (pool / executor) is already managed by this point in `setup`, so
            // the spawned task can resolve it. `args()` includes the program
            // name at [0]; skip it before parsing.
            let cli_args: Vec<String> = std::env::args().skip(1).collect();
            let shell_launch = crate::core::launch::parse_run_args(&cli_args);
            let is_shell_launch = shell_launch.is_some();
            if let Some(run) = shell_launch {
                crate::platform::tray::spawn_shell_launch(app.handle(), run);
            }

            // Start hidden when launched minimized at login OR when this is a
            // headless shell launch (which must never pop a window).
            let start_hidden = is_shell_launch
                || (launched_by_os && {
                    let pool = app.state::<crate::storage::DbPool>().inner().clone();
                    tauri::async_runtime::block_on(async move {
                        crate::storage::autostart::load(&pool)
                            .await
                            .map(|cfg| cfg.start_minimized)
                            .unwrap_or(false)
                    })
                });

            // Initialise the runtime "close to tray" cache from SQLite before the
            // CloseRequested handler can fire, so the very first window close
            // honours the persisted preference. Defaults to `true` (hide to tray)
            // if the load fails, matching the historical behaviour.
            {
                let pool = app.state::<crate::storage::DbPool>().inner().clone();
                let close_to_tray = tauri::async_runtime::block_on(async move {
                    crate::storage::window_behavior::load(&pool)
                        .await
                        .map(|cfg| cfg.close_to_tray)
                        .unwrap_or(true)
                });
                crate::platform::tray::set_close_to_tray(close_to_tray);
            }

            if let Some(main_window) = app.get_webview_window("main") {
                crate::platform::tray::install_close_to_tray(&main_window);

                if !start_hidden {
                    let _ = main_window.show();
                    let _ = main_window.set_focus();
                }

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
            commands::list_miniapps,
            commands::get_miniapp,
            commands::save_miniapp,
            commands::delete_miniapp,
            commands::run_miniapp_status_probe,
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
            commands::autostart_status,
            commands::set_autostart,
            commands::shell_integration_status,
            commands::set_shell_integration,
            crate::platform::quick_prompt::get_quick_prompt_request,
            crate::platform::quick_prompt::submit_quick_prompt,
            crate::platform::quick_prompt::cancel_quick_prompt,
            commands::get_window_behavior,
            commands::set_window_behavior,
            commands::http_server_status,
            commands::start_http_server,
            commands::set_http_server_language,
            commands::stop_http_server,
            commands::get_http_server_config,
            commands::set_http_server_config,
            commands::api_token_status,
            commands::regenerate_api_token,
            commands::clear_api_token,
            commands::list_request_log,
            commands::clear_request_log,
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
            commands::pick_artifact_path,
            commands::get_user_env_with_sources,
            commands::get_root_env_with_sources,
            commands::open_windows_env_dialog,
            commands::list_ssh_hosts,
            commands::check_ssh_host,
            commands::save_ssh_host,
            commands::delete_ssh_host,
            commands::has_ssh_password,
            commands::set_ssh_password,
            commands::clear_ssh_password,
            commands::get_sound_settings,
            commands::set_sound_settings,
            commands::list_sounds,
            commands::import_custom_sound,
            commands::delete_custom_sound,
            commands::preview_sound,
            commands::sftp::sftp_list_dir,
            commands::sftp::sftp_download,
            commands::sftp::sftp_upload,
            commands::sftp::sftp_delete,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_mkdir,
            commands::sftp::list_local_dir,
            commands::sftp::local_delete,
            commands::sftp::local_rename,
            commands::sftp::local_mkdir,
            commands::list_plugins,
            commands::set_plugin_enabled,
            commands::remove_plugin,
            commands::list_plugin_catalog,
            commands::install_plugin_version,
            commands::terminal_spawn,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_close,
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
                // Also kill every open interactive terminal session's shell —
                // otherwise a Terminal tab's child process (or anything it
                // spawned) would linger as an orphan after ProcMix exits.
                let terminal = app_handle.state::<Arc<TerminalState>>();
                crate::core::terminal::shutdown_all_sync(terminal.inner());
            }
        });
}
