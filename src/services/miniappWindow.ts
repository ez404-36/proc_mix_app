// IPC wrappers for the standalone Mini-App runner window (`miniapp-<id>`).
//
// A mini-app now runs in its OWN OS window rather than as an in-app view —
// see `platform::miniapp_window` on the Rust side. This module owns the
// lifecycle surface JS needs:
//
//   - `openMiniAppWindow`: called by the Library's "Run" action to open (or
//     focus) the window for a given mini-app id. The tray's "Mini-Apps"
//     submenu reaches the SAME Rust `open()` function directly — this is
//     only the JS-side entry point used by in-app UI.
//   - `getMiniAppWindowId`: called once by the new window on mount to learn
//     which mini-app it should render (the id is recovered server-side from
//     the window's own label, not passed via a URL query param — see the
//     Rust module docs for why).
//   - `subscribeMiniAppWindowEvents`: the `miniapp-window-event` fan-out the
//     main window's Library tile listens on to know which mini-apps
//     currently have an open window, so it can show a "running" state
//     instead of the normal Run button (and so double-launching the SAME
//     mini-app from the Library never fires a second `open_miniapp_window`
//     call to begin with).
//   - `listOpenMiniAppWindows`: reads the LIVE window registry (not the
//     event stream) — used to reconcile `miniappWindowStore` whenever the
//     Mini-Apps tab mounts, in case the event-driven state drifted. This is
//     the mitigation for the one gap the event stream cannot close: a
//     webview whose renderer process crashes while the native OS window
//     survives (WebView2 on Windows / WebKitGTK on Linux) never fires
//     `WindowEvent::Destroyed`, so no `Closed` event is ever emitted — see
//     the Rust module's doc comment on `open_miniapp_ids`. Reconciling on
//     mount does NOT detect that specific case (the window still exists,
//     just with a dead renderer) — it only re-syncs the store when it drifts
//     from the live registry for any OTHER reason (a missed event, a race on
//     the main window's own startup, etc).

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { MiniAppWindowEvent } from "../types";

/** Open (or focus) the standalone runner window for mini-app `id`. */
export async function openMiniAppWindow(id: string): Promise<void> {
  await invoke("open_miniapp_window", { id });
}

/**
 * Resolve the mini-app id THIS window is showing, from its own Tauri window
 * label. Called exactly once, on mount, by `MiniAppWindowApp`.
 */
export async function getMiniAppWindowId(): Promise<string> {
  return invoke<string>("get_miniapp_window_id");
}

/**
 * Ids of every mini-app that currently has an open standalone window,
 * read straight from the Rust-side live window registry. See the module
 * doc above for what this reconciliation does and does not fix.
 */
export async function listOpenMiniAppWindows(): Promise<string[]> {
  return invoke<string[]>("list_open_miniapp_windows");
}

/**
 * Module-level subscription state for the `miniapp-window-event` channel.
 * One global `listen()` Promise is started the first time anyone imports
 * this module; all consumers register handlers into a shared Set, so the
 * Tauri-side listener is created exactly once. Mirrors
 * `subscribeExecutionEvents` in `utils/executor.ts` — see that file for the
 * full StrictMode-race rationale this pattern is copied from.
 */
let unlistenPromise: Promise<UnlistenFn> | null = null;
const handlers = new Set<(e: MiniAppWindowEvent) => void>();

function ensureSubscribed(): Promise<UnlistenFn> {
  if (unlistenPromise) {
    return unlistenPromise;
  }
  unlistenPromise = listen<MiniAppWindowEvent>(
    "miniapp-window-event",
    (event) => {
      for (const h of handlers) h(event.payload);
    },
  );
  unlistenPromise.catch((err) => {
    console.error("miniapp-window-event listener failed to attach:", err);
  });
  return unlistenPromise;
}

// Start subscribing immediately when this module loads, mirroring the
// execution/workflow event bridges — a mini-app opened via the tray before
// the Library tab was ever visited must still be reflected once it mounts.
void ensureSubscribed();

/**
 * Register a handler for mini-app window lifecycle events. Returns the
 * unsubscribe function synchronously (see `subscribeExecutionEvents` for why
 * this matters under React StrictMode's double-effect).
 */
export function subscribeMiniAppWindowEvents(
  handler: (e: MiniAppWindowEvent) => void,
): () => void {
  handlers.add(handler);
  void ensureSubscribed();
  return () => {
    handlers.delete(handler);
  };
}
