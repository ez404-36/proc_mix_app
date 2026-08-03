//! Standalone Mini-App runner windows.
//!
//! Each running mini-app opens in its OWN OS window, independent of the main
//! ProcMix window — labelled `miniapp-<id>` and loading `miniapp-runner.html`
//! (a separate Vite entry, mirroring the `quick-prompt` window's
//! `prompt.html`). Unlike the quick-prompt window (a single fixed label, at
//! most one instance), any number of mini-app windows can be open at once —
//! one per mini-app id, each independently mounted/closed.
//!
//! ## Window label ↔ mini-app id
//!
//! The mini-app id (a `crypto.randomUUID()` string — see
//! `stores/miniappStore.ts`) is embedded directly in the window label as
//! `miniapp-<id>`. This is safe because a UUID's charset (`[0-9a-f-]`) is a
//! strict subset of Tauri's window-label charset, and — critically — because
//! [`miniapp_id_from_label`] only ever STRIPS the fixed prefix rather than
//! re-parsing/splitting the remainder, so a hyphen inside the id can never be
//! mistaken for a separator. No separate id↔label lookup table is needed: a
//! mini-app window can recover its own id by reading `WebviewWindow::label()`
//! and stripping the prefix (see [`get_miniapp_window_id`], the command the
//! new window calls on mount) — unlike the quick-prompt dialog, which passes
//! its one-shot payload through `Mutex<Option<T>>` managed state because it
//! carries data beyond a bare id.
//!
//! ## Lifecycle
//!
//! 1. `open(app, id)` — if a window for this id is already open, focus it;
//!    otherwise build a new one.
//! 2. The window mounts, calls `get_miniapp_window_id` to learn which
//!    mini-app to render, then hydrates its own (window-local) stores and
//!    subscribes to the broadcast `execution-event`/`workflow-event` streams
//!    exactly like the main window does — Tauri events reach every open
//!    webview by default; only the JS-side Zustand state is per-window.
//! 3. Closing is user-controlled (native minimize/close chrome, enabled by
//!    default — no `decorations: false` override). The frontend's
//!    `onCloseRequested` handler decides whether to confirm (active child
//!    processes) before letting the close proceed; see
//!    `docs/miniapp-windows.md`.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// Label prefix every mini-app window carries. The suffix is the mini-app's
/// id verbatim (see module docs for why this is safe to do without a lookup
/// table).
const MINIAPP_LABEL_PREFIX: &str = "miniapp-";

/// Tauri event channel the main window listens on to know which mini-apps
/// currently have an open standalone runner window, so the Library tile can
/// show a "running" state instead of its normal Run button (and so double-
/// launching the SAME mini-app is a no-op at the UI layer too — the Rust
/// side already guarantees at most one window per id via [`open`], this is
/// purely a UX signal). Reaches every open webview by default (see the
/// module doc's note on `execution-event`/`workflow-event`), so the main
/// window's listener needs no extra capability beyond `core:default`.
pub const MINIAPP_WINDOW_EVENT: &str = "miniapp-window-event";

/// Lifecycle event for a mini-app's standalone runner window. `Opened` fires
/// once, right after a NEW window is actually built (never on a focus-only
/// `open()` call for an already-open id); `Closed` fires once the window is
/// destroyed, however that happened (native × / minimize-then-close guard /
/// programmatic close), so the main window's tracked set can never leak a
/// stale "running" id if the close-confirmation flow or a crash skips the
/// happy path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all_fields = "camelCase", tag = "kind")]
pub enum MiniAppWindowEvent {
    #[serde(rename = "opened")]
    Opened { id: String },
    #[serde(rename = "closed")]
    Closed { id: String },
}

fn emit_window_event<R: Runtime>(app: &AppHandle<R>, event: &MiniAppWindowEvent) {
    if let Err(err) = app.emit(MINIAPP_WINDOW_EVENT, event) {
        tracing::error!("failed to emit mini-app window event: {err}");
    }
}

/// Default window size for a newly-opened mini-app runner. Deliberately
/// smaller than the main window's 1200×800 default — most mini-app panels
/// are compact control surfaces (see `DEFAULT_PANEL_SIZE` in
/// `miniappStore.ts`, 400×320) — but resizable, unlike the fixed-size
/// quick-prompt dialog.
const DEFAULT_WIDTH: f64 = 480.0;
const DEFAULT_HEIGHT: f64 = 640.0;
const MIN_WIDTH: f64 = 320.0;
const MIN_HEIGHT: f64 = 240.0;

/// Build the window label for a mini-app id.
pub fn miniapp_window_label(id: &str) -> String {
    format!("{MINIAPP_LABEL_PREFIX}{id}")
}

/// Recover the mini-app id from one of this module's window labels. Returns
/// `None` for a label that doesn't carry the prefix (i.e. any window that
/// isn't a mini-app runner — defensive, should never happen for a command
/// registered under the `miniapp-*` capability).
pub fn miniapp_id_from_label(label: &str) -> Option<&str> {
    label.strip_prefix(MINIAPP_LABEL_PREFIX)
}

/// Open (or focus) the standalone runner window for mini-app `id`. A second
/// call for the SAME id focuses the existing window rather than stacking a
/// duplicate — mirrors `quick_prompt::open`'s single-instance-per-key
/// behaviour, keyed here by mini-app id instead of a single fixed label.
/// `get_webview_window` + this being the single call site that ever builds a
/// `miniapp-<id>` window together guarantee at most one OS window per mini-app
/// id: a focus-only call for an already-open id emits NO event (the window
/// was already counted as running), and the Tauri runtime itself would refuse
/// a duplicate label (`Error::WebviewLabelAlreadyExists`) even if this check
/// were ever bypassed.
pub fn open<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<(), String> {
    let label = miniapp_window_label(id);

    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_focus();
        return Ok(());
    }

    let window =
        WebviewWindowBuilder::new(app, &label, WebviewUrl::App("miniapp-runner.html".into()))
            .title("ProcMix")
            .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
            .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
            .resizable(true)
            .minimizable(true)
            .closable(true)
            .build()
            .map_err(|e| format!("failed to open mini-app window: {e}"))?;

    // Tell the main window this mini-app is now running (Library tile
    // "running" state / tray). `Destroyed` fires unconditionally on every
    // close path (native ×, the JS close-confirmation flow's eventual
    // `close()`, or a crash) so the counterpart `Closed` event can never be
    // skipped — unlike hooking only the JS `onCloseRequested` handler, which
    // a forced/crashed close would bypass.
    emit_window_event(app, &MiniAppWindowEvent::Opened { id: id.to_string() });
    let app_for_close = app.clone();
    let id_for_close = id.to_string();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            emit_window_event(
                &app_for_close,
                &MiniAppWindowEvent::Closed {
                    id: id_for_close.clone(),
                },
            );
        }
    });

    Ok(())
}

/// Read the mini-app id this window is showing, from the window's OWN label.
/// Called by the new window once on mount (mirrors `get_quick_prompt_request`,
/// but recovers the id from the label instead of a managed-state payload,
/// since a bare id needs no additional server-held context). Returns an
/// error for a window whose label doesn't match `miniapp-*` — defensive, this
/// command is only ever invoked from a `miniapp-*`-capability window.
#[tauri::command]
pub fn get_miniapp_window_id(window: tauri::Window) -> Result<String, String> {
    miniapp_id_from_label(window.label())
        .map(str::to_string)
        .ok_or_else(|| format!("not a mini-app window: {}", window.label()))
}

/// Ids of every mini-app that currently has an OPEN standalone runner
/// window, read directly from the live window registry (`webview_windows()`)
/// rather than from the `Opened`/`Closed` event stream the main window
/// mirrors into `miniappWindowStore`.
///
/// This is the source of truth the Library's Mini-Apps tab reconciles
/// against on mount (`list_open_miniapp_windows` command below): the event
/// stream is normally sufficient (`Destroyed` fires on every close path —
/// native ×, the close-confirmation flow, a forced/crashed close that still
/// tears the window down), but it does NOT fire if a webview's renderer
/// process dies while the native OS window survives (a real gap: WebView2 on
/// Windows and WebKitGTK on Linux both have this failure mode natively, and
/// neither is wired up by Tauri/wry to emit anything Tauri-level as of
/// tauri-runtime 2.11 / wry 0.55 — confirmed by inspecting their source;
/// only macOS/iOS get an equivalent hook, `App::on_web_content_process_terminate`,
/// which this module does not currently use). A window in that state is still enumerated
/// here (its label still exists), so this reconciliation does NOT fix a
/// blank/frozen window — it only guards against `runningIds` drifting from
/// reality for any OTHER reason (a missed event, a listener race on the main
/// window's own startup, etc).
fn open_miniapp_ids<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    app.webview_windows()
        .keys()
        .filter_map(|label| miniapp_id_from_label(label).map(str::to_string))
        .collect()
}

/// Tauri command wrapping [`open_miniapp_ids`]. Called by the main window's
/// Mini-Apps tab each time it mounts.
#[tauri::command]
pub fn list_open_miniapp_windows(app: AppHandle) -> Vec<String> {
    open_miniapp_ids(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn miniapp_window_label_prefixes_the_id() {
        assert_eq!(
            miniapp_window_label("3fa85f64-5717-4562-b3fc-2c963f66afa6"),
            "miniapp-3fa85f64-5717-4562-b3fc-2c963f66afa6"
        );
    }

    #[test]
    fn miniapp_id_from_label_strips_prefix_only_never_splits() {
        // A UUID's own hyphens must survive intact — this is exactly why
        // `strip_prefix` (not `split_once('-')`) is used.
        assert_eq!(
            miniapp_id_from_label("miniapp-3fa85f64-5717-4562-b3fc-2c963f66afa6"),
            Some("3fa85f64-5717-4562-b3fc-2c963f66afa6")
        );
    }

    #[test]
    fn miniapp_id_from_label_rejects_non_miniapp_labels() {
        assert_eq!(miniapp_id_from_label("main"), None);
        assert_eq!(miniapp_id_from_label("quick-prompt"), None);
    }

    #[test]
    fn miniapp_window_label_and_id_from_label_round_trip() {
        let ids = [
            "3fa85f64-5717-4562-b3fc-2c963f66afa6",
            "ma-abc123-1700000000000",
        ];
        for id in ids {
            let label = miniapp_window_label(id);
            assert_eq!(miniapp_id_from_label(&label), Some(id));
        }
    }

    /// `MiniAppWindowEvent` serialises with `tag = "kind"` and camelCase
    /// field names, matching the TS `MiniAppWindowEvent` union.
    #[test]
    fn window_event_wire_format_is_camelcase() {
        let opened = MiniAppWindowEvent::Opened {
            id: "ma-1".to_string(),
        };
        let json = serde_json::to_value(&opened).unwrap();
        assert_eq!(json["kind"], "opened");
        assert_eq!(json["id"], "ma-1");

        let closed = MiniAppWindowEvent::Closed {
            id: "ma-1".to_string(),
        };
        let json = serde_json::to_value(&closed).unwrap();
        assert_eq!(json["kind"], "closed");
        assert_eq!(json["id"], "ma-1");
    }

    /// Calling `open()` twice for the SAME mini-app id must never result in
    /// two OS windows: the second call is a focus-only no-op on the existing
    /// window. This is the backend half of "you cannot run the same mini-app
    /// twice" — the frontend additionally hides/disables the Run button for
    /// an already-running mini-app, but this invariant holds even if that UI
    /// guard were somehow bypassed (e.g. two rapid tray clicks).
    #[test]
    fn open_twice_for_the_same_id_does_not_duplicate_the_window() {
        let app = tauri::test::mock_app();
        let handle = app.handle();

        open(handle, "ma-dup").expect("first open creates the window");
        assert!(
            handle
                .get_webview_window(&miniapp_window_label("ma-dup"))
                .is_some(),
            "window must exist after the first open"
        );

        // A second call for the same id must succeed (focus-only) and must
        // NOT error with a duplicate-label failure, proving `open()` never
        // reaches the `WebviewWindowBuilder::build()` call a second time.
        open(handle, "ma-dup").expect("second open focuses, not duplicates");

        // Exactly one window carries this mini-app's label.
        let matching = handle
            .webview_windows()
            .into_iter()
            .filter(|(label, _)| label == &miniapp_window_label("ma-dup"))
            .count();
        assert_eq!(matching, 1, "at most one window per mini-app id");
    }

    /// Opening two DIFFERENT mini-app ids is unaffected by the same-id guard
    /// above — each gets its own window.
    #[test]
    fn open_for_different_ids_creates_separate_windows() {
        let app = tauri::test::mock_app();
        let handle = app.handle();

        open(handle, "ma-a").expect("open ma-a");
        open(handle, "ma-b").expect("open ma-b");

        assert!(handle
            .get_webview_window(&miniapp_window_label("ma-a"))
            .is_some());
        assert!(handle
            .get_webview_window(&miniapp_window_label("ma-b"))
            .is_some());
    }

    /// `open_miniapp_ids` reflects the LIVE window registry, not the
    /// `Opened`/`Closed` event stream — this is the reconciliation source of
    /// truth `list_open_miniapp_windows` exposes to the frontend.
    #[test]
    fn open_miniapp_ids_reflects_live_windows_only() {
        let app = tauri::test::mock_app();
        let handle = app.handle();

        assert_eq!(open_miniapp_ids(handle), Vec::<String>::new());

        open(handle, "ma-a").expect("open ma-a");
        open(handle, "ma-b").expect("open ma-b");

        let mut ids = open_miniapp_ids(handle);
        ids.sort();
        assert_eq!(ids, vec!["ma-a".to_string(), "ma-b".to_string()]);
    }

    /// A non-mini-app window (e.g. `main`) must never leak into the id list —
    /// only labels carrying the `miniapp-` prefix are ever mapped back to an
    /// id (mirrors `miniapp_id_from_label`'s own contract).
    #[test]
    fn open_miniapp_ids_ignores_non_miniapp_windows() {
        let app = tauri::test::mock_app();
        let handle = app.handle();

        tauri::WebviewWindowBuilder::new(handle, "main", Default::default())
            .build()
            .expect("build main window");
        open(handle, "ma-a").expect("open ma-a");

        assert_eq!(open_miniapp_ids(handle), vec!["ma-a".to_string()]);
    }
}
