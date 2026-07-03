use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::{
    menu::{Menu, MenuEvent, MenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow,
};

use crate::core::launch::{self, LaunchKind, LaunchSource, LaunchStatus};
use crate::storage::DbPool;

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_ID: &str = "main-tray";

/// Prefix of a favorites-submenu item id. The full id is
/// `tray-fav:<kind>:<id>` where `<kind>` is `command` / `workflow` and `<id>`
/// is the entity's logical id. Parsed by [`parse_favorite_id`].
const FAVORITE_ID_PREFIX: &str = "tray-fav:";

/// Upper bound on how many favorites the submenu lists. A favorites list longer
/// than this is capped and a trailing "More… (open ProcMix)" item is shown so
/// the menu stays usable. Mirrors the shell-integration cap (Stage 2).
const MAX_FAVORITE_ITEMS: usize = 15;

/// Runtime cache of the user's "close to tray" preference, mirrored from
/// `storage::window_behavior`. The `CloseRequested` window-event callback is
/// synchronous and cannot await SQLite, so the flag is read from this atomic
/// instead. Initialised once at startup from the DB via [`set_close_to_tray`]
/// and updated live whenever the user toggles the setting (the
/// `set_close_to_tray` Tauri command writes both the DB and this cache).
///
/// Defaults to `true` so that if — for any reason — the startup load has not run
/// yet, closing the window hides to the tray (the historical behaviour) rather
/// than unexpectedly quitting the app.
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

/// Update the runtime "close to tray" preference. Called at startup with the
/// value loaded from SQLite, and again whenever the user toggles the Settings →
/// Tray switch. Read by the `CloseRequested` handler in
/// [`install_close_to_tray`].
pub fn set_close_to_tray(enabled: bool) {
    CLOSE_TO_TRAY.store(enabled, Ordering::Relaxed);
}

/// Current runtime "close to tray" preference. `true` (default) → closing the
/// window hides it to the tray; `false` → closing quits ProcMix.
fn close_to_tray() -> bool {
    CLOSE_TO_TRAY.load(Ordering::Relaxed)
}

/// The window's outer position and inner size captured immediately before it
/// is hidden to the tray. On X11/Wayland `hide()` unmaps the window and a
/// subsequent `show()` lets the window manager re-place it, so we must
/// restore the exact geometry ourselves to make tray toggling behave like a
/// fresh launch (which is what `tauri-plugin-window-state` does on restart).
#[derive(Clone, Copy)]
struct WindowGeometry {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
}

fn saved_geometry() -> &'static Mutex<Option<WindowGeometry>> {
    static GEOMETRY: OnceLock<Mutex<Option<WindowGeometry>>> = OnceLock::new();
    GEOMETRY.get_or_init(|| Mutex::new(None))
}

/// Record the window's current geometry so it can be restored after the next
/// `show()`. Failures to read the geometry are non-fatal: we simply keep the
/// previously stored value (or `None`) and let the OS decide on restore.
fn capture_geometry<R: Runtime>(window: &WebviewWindow<R>) {
    if let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) {
        if let Ok(mut guard) = saved_geometry().lock() {
            *guard = Some(WindowGeometry { position, size });
        }
    }

    // Persist to disk now, while the window is still visible and has valid
    // geometry. This is the only reliable moment: ProcMix hides to the tray
    // rather than closing, so the plugin's own close/exit hooks never fire.
    persist_window_state(window.app_handle());
}

/// Re-apply the geometry captured by [`capture_geometry`], if any. Called
/// right after the window is shown so it reappears exactly where the user
/// left it instead of wherever the window manager chose to map it.
fn restore_geometry<R: Runtime>(window: &WebviewWindow<R>) {
    let geometry = saved_geometry().lock().ok().and_then(|g| *g);
    if let Some(geometry) = geometry {
        let _ = window.set_size(geometry.size);
        let _ = window.set_position(geometry.position);
    }
}

/// Flush the current window geometry to disk via `tauri-plugin-window-state`.
///
/// The plugin normally only writes on `CloseRequested`/`Exit`, but ProcMix
/// hides its window to the tray instead of closing it, so those events never
/// fire in normal use. We therefore persist explicitly whenever the window is
/// hidden and on quit, so a subsequent launch restores the right geometry.
/// Desktop-only: the plugin is not linked on mobile targets.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn persist_window_state<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_window_state::{AppHandleExt, StateFlags};

    let flags =
        StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED | StateFlags::FULLSCREEN;
    let _ = app.save_window_state(flags);
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn persist_window_state<R: Runtime>(_app: &AppHandle<R>) {}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayLabels {
    pub show: String,
    pub hide: String,
    pub quit: String,
    pub tooltip: String,
    /// Title of the "Favorites" submenu.
    pub favorites: String,
    /// Disabled placeholder item shown when there are no favorites.
    pub favorites_empty: String,
    /// Trailing item shown when the favorites list is capped at
    /// [`MAX_FAVORITE_ITEMS`]; opens the main window.
    pub favorites_more: String,
    /// Title of the quick-launch outcome notification.
    pub notify_title: String,
    /// Notification body for a successful launch (`{{name}}` → entity name).
    pub notify_success: String,
    /// Notification body for a failed launch.
    pub notify_error: String,
    /// Notification body when the favorite needs a variable value.
    pub notify_missing_variable: String,
    /// Notification body when the favorite no longer exists.
    pub notify_not_found: String,
}

pub fn default_labels() -> TrayLabels {
    TrayLabels {
        show: dev_tag("Show ProcMix"),
        hide: dev_tag("Hide to Tray"),
        quit: dev_tag("Quit ProcMix"),
        tooltip: dev_tag("ProcMix"),
        favorites: "Favorites".to_string(),
        favorites_empty: "No favorites yet".to_string(),
        favorites_more: "More… (open ProcMix)".to_string(),
        notify_title: dev_tag("ProcMix"),
        notify_success: "\"{{name}}\" finished successfully".to_string(),
        notify_error: "\"{{name}}\" failed".to_string(),
        notify_missing_variable: "\"{{name}}\" needs a variable value".to_string(),
        notify_not_found: "Favorite is no longer available".to_string(),
    }
}

/// In a debug build, suffix the product name "ProcMix" with " (dev)" so the
/// FIRST tray menu/tooltip shown (before the frontend pushes localized
/// labels via `update_tray_menu`) is also marked as the dev build. In a
/// release build this is the identity. Mirrors `withDevSuffix` in
/// `src/utils/tray.ts` (which handles the localized labels at runtime).
fn dev_tag(label: &str) -> String {
    if cfg!(debug_assertions) {
        label.replacen("ProcMix", "ProcMix (dev)", 1)
    } else {
        label.to_string()
    }
}

/// A favorite command / workflow rendered as one item in the tray's
/// "Favorites" submenu. `kind` + `id` round-trip through the menu item id
/// (`tray-fav:<kind>:<id>`); `name` is the visible label.
#[derive(Debug, Clone)]
pub struct FavoriteEntry {
    pub kind: LaunchKind,
    pub id: String,
    pub name: String,
}

/// The most recently applied tray labels, cached so the synchronous
/// menu-event handler can format the quick-launch notification (it cannot
/// await a fresh fetch). Initialised to [`default_labels`] and overwritten by
/// every [`apply_labels`] (i.e. whenever the frontend pushes localized labels).
fn current_labels() -> &'static Mutex<TrayLabels> {
    static LABELS: OnceLock<Mutex<TrayLabels>> = OnceLock::new();
    LABELS.get_or_init(|| Mutex::new(default_labels()))
}

fn store_labels(labels: &TrayLabels) {
    if let Ok(mut guard) = current_labels().lock() {
        *guard = labels.clone();
    }
}

fn labels_snapshot() -> TrayLabels {
    current_labels()
        .lock()
        .map(|g| g.clone())
        .unwrap_or_else(|_| default_labels())
}

/// Load the favorite commands and workflows for the tray submenu. Failures are
/// logged and treated as "no favorites" — a tray that can't read the DB still
/// builds with an empty (disabled) submenu rather than failing to appear.
async fn load_favorites(pool: &DbPool) -> Vec<FavoriteEntry> {
    let mut out = Vec::new();
    match crate::storage::commands::list_all(pool).await {
        Ok(list) => {
            for c in list.into_iter().filter(|c| c.favorite) {
                out.push(FavoriteEntry {
                    kind: LaunchKind::Command,
                    id: c.id,
                    name: c.name,
                });
            }
        }
        Err(e) => tracing::error!("tray: failed to load favorite commands: {e}"),
    }
    match crate::storage::workflows::list_all(pool).await {
        Ok(list) => {
            for w in list.into_iter().filter(|w| w.favorite) {
                out.push(FavoriteEntry {
                    kind: LaunchKind::Workflow,
                    id: w.id,
                    name: w.name,
                });
            }
        }
        Err(e) => tracing::error!("tray: failed to load favorite workflows: {e}"),
    }
    out
}

/// Build the favorites submenu from the resolved favorite list. An empty list
/// renders a single disabled placeholder; a list longer than
/// [`MAX_FAVORITE_ITEMS`] is capped with a trailing "More…" item that opens the
/// main window.
fn build_favorites_submenu<R: Runtime>(
    app: &AppHandle<R>,
    labels: &TrayLabels,
    favorites: &[FavoriteEntry],
) -> tauri::Result<Submenu<R>> {
    let submenu = Submenu::with_id(app, "tray-favorites", &labels.favorites, true)?;

    if favorites.is_empty() {
        // A disabled placeholder so the submenu is never empty/confusing.
        let empty = MenuItem::with_id(
            app,
            "tray-fav-empty",
            &labels.favorites_empty,
            false,
            None::<&str>,
        )?;
        submenu.append(&empty)?;
        return Ok(submenu);
    }

    for fav in favorites.iter().take(MAX_FAVORITE_ITEMS) {
        let item_id = format!("{}{}:{}", FAVORITE_ID_PREFIX, fav.kind.as_str(), fav.id);
        let item = MenuItem::with_id(app, &item_id, &fav.name, true, None::<&str>)?;
        submenu.append(&item)?;
    }

    if favorites.len() > MAX_FAVORITE_ITEMS {
        let more = MenuItem::with_id(
            app,
            "tray-fav-more",
            &labels.favorites_more,
            true,
            None::<&str>,
        )?;
        submenu.append(&more)?;
    }

    Ok(submenu)
}

pub fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    labels: &TrayLabels,
    favorites: &[FavoriteEntry],
) -> tauri::Result<Menu<R>> {
    let show = MenuItem::with_id(app, "tray-show", &labels.show, true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "tray-hide", &labels.hide, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", &labels.quit, true, None::<&str>)?;
    let favorites_menu = build_favorites_submenu(app, labels, favorites)?;
    Menu::with_items(app, &[&favorites_menu, &show, &hide, &quit])
}

pub fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let labels = default_labels();
    store_labels(&labels);
    // The pool is managed before the tray is built (see `lib.rs` setup), so the
    // favorites are available here. A failed load yields an empty submenu.
    let favorites = match app.try_state::<DbPool>() {
        Some(pool) => {
            let pool = pool.inner().clone();
            tauri::async_runtime::block_on(async move { load_favorites(&pool).await })
        }
        None => Vec::new(),
    };
    let menu = build_menu(app, &labels, &favorites)?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;

    let _tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(&labels.tooltip)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(handle_tray_icon_event)
        .build(app)?;

    Ok(())
}

pub async fn apply_labels<R: Runtime>(
    app: &AppHandle<R>,
    labels: &TrayLabels,
) -> tauri::Result<()> {
    store_labels(labels);
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or_else(|| tauri::Error::AssetNotFound(format!("tray icon '{}' not found", TRAY_ID)))?;
    let favorites = match app.try_state::<DbPool>() {
        Some(pool) => {
            let pool = pool.inner().clone();
            load_favorites(&pool).await
        }
        None => Vec::new(),
    };
    let menu = build_menu(app, labels, &favorites)?;
    tray.set_menu(Some(menu))?;
    tray.set_tooltip(Some(&labels.tooltip))?;
    Ok(())
}

/// Rebuild ONLY the tray menu's favorites (keeping the cached labels), called
/// after a command / workflow mutation changes the favorite set. Async because
/// it reads the DB; a failure to read is logged and leaves the menu unchanged.
pub async fn rebuild_favorites<R: Runtime>(app: &AppHandle<R>) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        // Tray not built yet (very early startup) — nothing to refresh.
        return;
    };
    let labels = labels_snapshot();
    let favorites = match app.try_state::<DbPool>() {
        Some(pool) => {
            let pool = pool.inner().clone();
            load_favorites(&pool).await
        }
        None => Vec::new(),
    };
    match build_menu(app, &labels, &favorites) {
        Ok(menu) => {
            if let Err(e) = tray.set_menu(Some(menu)) {
                tracing::error!("tray: failed to apply rebuilt favorites menu: {e}");
            }
        }
        Err(e) => tracing::error!("tray: failed to build favorites menu: {e}"),
    }
}

/// Parse a favorites-submenu item id (`tray-fav:<kind>:<id>`) into its
/// [`LaunchKind`] and entity id. Returns `None` for any other menu id or a
/// malformed favorite id (unknown kind / empty id).
fn parse_favorite_id(menu_id: &str) -> Option<(LaunchKind, String)> {
    let rest = menu_id.strip_prefix(FAVORITE_ID_PREFIX)?;
    let (kind_str, id) = rest.split_once(':')?;
    if id.is_empty() {
        return None;
    }
    let kind = LaunchKind::parse_kind(kind_str)?;
    Some((kind, id.to_string()))
}

fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref().to_string();
    match id.as_str() {
        "tray-show" => {
            let _ = show_main_window(app);
        }
        "tray-hide" => {
            let _ = hide_main_window(app);
        }
        "tray-quit" => {
            if let Some(window) = main_window(app) {
                if window.is_visible().unwrap_or(false) {
                    capture_geometry(&window);
                }
            }
            app.exit(0);
        }
        // The "More…" overflow item and (defensively) the empty placeholder
        // open the main window so the user can pick from the full list.
        "tray-fav-more" | "tray-fav-empty" => {
            let _ = show_main_window(app);
        }
        other => {
            if let Some((kind, entity_id)) = parse_favorite_id(other) {
                spawn_launch(app, kind, entity_id, LaunchSource::Tray, None);
            }
        }
    }
}

/// Fire a favorite parsed from the OS file-manager launch argv (Stage 3). Used
/// by the single-instance hook and the cold-start path in `lib.rs`: routes the
/// `--run-favorite <kind>:<id> --path <p>` request to the SAME headless fire +
/// notification path the tray submenu uses, with `source = Shell` and the
/// validated selected path. The window is never opened.
pub fn spawn_shell_launch<R: Runtime>(app: &AppHandle<R>, args: launch::RunArgs) {
    spawn_launch(
        app,
        args.kind,
        args.id,
        LaunchSource::Shell,
        args.selected_path,
    );
}

/// Fire a favorite on the async runtime. The triggering callbacks are
/// synchronous and cannot await SQLite / the executor, so the run is spawned
/// (mirroring how `CloseRequested` defers work).
///
/// A WORKFLOW target always runs HEADLESS (no window) and its outcome is shown
/// via a brief native notification. A COMMAND target is first classified: if it
/// needs interactive input (variables / admin password) the standalone prompt
/// window is opened — the main window stays hidden — and the run happens after
/// the user submits; otherwise it runs headless like a workflow.
fn spawn_launch<R: Runtime>(
    app: &AppHandle<R>,
    kind: LaunchKind,
    id: String,
    source: LaunchSource,
    selected_path: Option<String>,
) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Resolve the shared state the fire path needs. If any is missing
        // (impossible after startup, but `try_state` is fallible), bail quietly.
        let (Some(pool), Some(executor_state), Some(workflow_state)) = (
            app.try_state::<DbPool>(),
            app.try_state::<std::sync::Arc<crate::core::executor::ExecutorState>>(),
            app.try_state::<std::sync::Arc<crate::core::workflow::WorkflowExecutorState>>(),
        ) else {
            tracing::error!("quick-launch state unavailable; skipping");
            return;
        };

        // Workflows never prompt — fire headless and notify.
        if kind == LaunchKind::Workflow {
            let outcome = launch::fire_favorite(
                &app,
                pool.inner(),
                executor_state.inner(),
                workflow_state.inner(),
                kind,
                &id,
                source,
                selected_path,
            )
            .await;
            notify_launch_outcome(&app, &outcome);
            return;
        }

        // Commands: classify headless vs needs-prompt.
        match launch::resolve_command_launch(pool.inner(), &id, source, selected_path).await {
            launch::CommandLaunchPlan::Unavailable => {
                // The "not found" event was already recorded; notify the user.
                notify_launch_outcome(
                    &app,
                    &launch::LaunchOutcome {
                        status: LaunchStatus::NotFound,
                        entity_name: String::new(),
                    },
                );
            }
            launch::CommandLaunchPlan::Headless {
                command,
                selected_path,
                working_dir_override,
            } => {
                let outcome = launch::fire_resolved_headless(
                    &app,
                    pool.inner(),
                    executor_state.inner(),
                    &command,
                    source,
                    selected_path,
                    working_dir_override,
                )
                .await;
                notify_launch_outcome(&app, &outcome);
            }
            launch::CommandLaunchPlan::NeedsPrompt {
                command,
                needs_admin,
                selected_path,
                working_dir_override,
            } => {
                // Open the standalone prompt dialog; the main window stays
                // hidden. The run + history happen on submit. No notification
                // here — the dialog is the immediate feedback.
                let pending = crate::platform::quick_prompt::PendingQuickPrompt {
                    command,
                    needs_admin,
                    source,
                    selected_path,
                    working_dir_override,
                };
                if let Err(e) = crate::platform::quick_prompt::open(&app, pending) {
                    tracing::error!("quick-launch: failed to open prompt window: {e}");
                }
            }
        }
    });
}

/// Show a brief native notification summarising a tray quick-launch outcome.
/// Best-effort: a notification failure (no daemon, permission denied) is logged
/// and never propagated. Desktop-only — the tray (and this handler) do not
/// exist on mobile.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn notify_launch_outcome<R: Runtime>(app: &AppHandle<R>, outcome: &launch::LaunchOutcome) {
    use tauri_plugin_notification::NotificationExt;

    let labels = labels_snapshot();
    let body = match outcome.status {
        LaunchStatus::Success => labels.notify_success.replace("{{name}}", &outcome.entity_name),
        LaunchStatus::Error => labels.notify_error.replace("{{name}}", &outcome.entity_name),
        LaunchStatus::MissingVariable => labels
            .notify_missing_variable
            .replace("{{name}}", &outcome.entity_name),
        LaunchStatus::NotFound => labels.notify_not_found.clone(),
    };

    if let Err(e) = app
        .notification()
        .builder()
        .title(&labels.notify_title)
        .body(&body)
        .show()
    {
        tracing::warn!("tray: failed to show quick-launch notification: {e}");
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn notify_launch_outcome<R: Runtime>(_app: &AppHandle<R>, _outcome: &launch::LaunchOutcome) {}

fn handle_tray_icon_event<R: Runtime>(tray: &TrayIcon<R>, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        let _ = toggle_main_window(tray.app_handle());
    }
}

fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(MAIN_WINDOW_LABEL)
}

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = main_window(app) {
        window.show()?;
        let _ = window.unminimize();
        restore_geometry(&window);
        window.set_focus()?;
    }
    Ok(())
}

fn hide_main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = main_window(app) {
        capture_geometry(&window);
        window.hide()?;
    }
    Ok(())
}

fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = main_window(app) {
        let visible = window.is_visible().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        if visible && focused {
            capture_geometry(&window);
            window.hide()?;
        } else {
            window.show()?;
            let _ = window.unminimize();
            restore_geometry(&window);
            window.set_focus()?;
        }
    }
    Ok(())
}

pub fn install_close_to_tray<R: Runtime>(window: &WebviewWindow<R>) {
    let window_clone = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            if close_to_tray() {
                // Default behaviour: keep the app alive in the tray. Cancel the
                // close, persist geometry while the window is still valid, and
                // hide it.
                api.prevent_close();
                capture_geometry(&window_clone);
                let _ = window_clone.hide();
            } else {
                // Opt-out: closing the window quits ProcMix. Persist geometry
                // first (the window is still visible here, so the values are
                // valid) and exit explicitly — mirrors the `tray-quit` path so
                // the next launch restores the right size/position. We do NOT
                // `prevent_close`, but `app.exit(0)` is the authoritative
                // shutdown that also tears down the tray + background tasks.
                capture_geometry(&window_clone);
                window_clone.app_handle().exit(0);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_favorite_id_accepts_command_and_workflow() {
        assert_eq!(
            parse_favorite_id("tray-fav:command:abc-123"),
            Some((LaunchKind::Command, "abc-123".to_string()))
        );
        assert_eq!(
            parse_favorite_id("tray-fav:workflow:wf-9"),
            Some((LaunchKind::Workflow, "wf-9".to_string()))
        );
    }

    #[test]
    fn parse_favorite_id_keeps_colons_in_the_entity_id() {
        // `split_once(':')` splits on the FIRST colon only, so an id that
        // itself contains colons is preserved intact.
        assert_eq!(
            parse_favorite_id("tray-fav:command:a:b:c"),
            Some((LaunchKind::Command, "a:b:c".to_string()))
        );
    }

    #[test]
    fn parse_favorite_id_rejects_non_favorite_and_malformed_ids() {
        // Other menu ids.
        assert_eq!(parse_favorite_id("tray-show"), None);
        assert_eq!(parse_favorite_id("tray-fav-more"), None);
        assert_eq!(parse_favorite_id("tray-fav-empty"), None);
        // Missing id segment.
        assert_eq!(parse_favorite_id("tray-fav:command"), None);
        // Empty id.
        assert_eq!(parse_favorite_id("tray-fav:command:"), None);
        // Unknown kind.
        assert_eq!(parse_favorite_id("tray-fav:schedule:x"), None);
    }
}
