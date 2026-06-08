use std::sync::{Mutex, OnceLock};

use tauri::{
    menu::{Menu, MenuEvent, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow,
};

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_ID: &str = "main-tray";

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
}

pub fn default_labels() -> TrayLabels {
    TrayLabels {
        show: "Show ProcMix".into(),
        hide: "Hide to Tray".into(),
        quit: "Quit ProcMix".into(),
        tooltip: "ProcMix".into(),
    }
}

pub fn build_menu<R: Runtime>(app: &AppHandle<R>, labels: &TrayLabels) -> tauri::Result<Menu<R>> {
    let show = MenuItem::with_id(app, "tray-show", &labels.show, true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "tray-hide", &labels.hide, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", &labels.quit, true, None::<&str>)?;
    Menu::with_items(app, &[&show, &hide, &quit])
}

pub fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let labels = default_labels();
    let menu = build_menu(app, &labels)?;

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

pub fn apply_labels<R: Runtime>(app: &AppHandle<R>, labels: &TrayLabels) -> tauri::Result<()> {
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or_else(|| tauri::Error::AssetNotFound(format!("tray icon '{}' not found", TRAY_ID)))?;
    let menu = build_menu(app, labels)?;
    tray.set_menu(Some(menu))?;
    tray.set_tooltip(Some(&labels.tooltip))?;
    Ok(())
}

fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
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
        _ => {}
    }
}

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
            api.prevent_close();
            capture_geometry(&window_clone);
            let _ = window_clone.hide();
        }
    });
}
