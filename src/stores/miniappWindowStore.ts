import { create } from "zustand";

// Tracks which mini-apps currently have an OPEN standalone runner window
// (`platform::miniapp_window`), fed by `useMiniAppWindowBridge` subscribing
// to the `miniapp-window-event` Tauri channel (see
// `services/miniappWindow.ts`). Purely a UI-layer mirror of state the Rust
// side already owns authoritatively (at most one window per mini-app id,
// enforced by `miniapp_window::open`'s `get_webview_window` check) — this
// store exists so the Library tile can render a "running" state instead of
// its normal Run button, and so a second click on an already-running
// mini-app's tile is a no-op at the UI layer too (belt-and-braces on top of
// the backend guarantee).
//
// Ephemeral and NOT persisted: every mini-app window closes when the app
// exits, so there is nothing to restore across a restart — starting empty
// on every launch is correct by construction.
interface MiniAppWindowState {
  /** Ids of mini-apps with a currently-open standalone window. */
  runningIds: Set<string>;
  markOpened: (id: string) => void;
  markClosed: (id: string) => void;
  /**
   * Replace `runningIds` wholesale with a fresh snapshot from the Rust-side
   * live window registry (`listOpenMiniAppWindows`). Called on every
   * Mini-Apps tab mount to correct any drift the `Opened`/`Closed` event
   * stream missed — see `services/miniappWindow.ts`'s module doc for the one
   * failure mode this does NOT fix (a crashed-but-undestroyed renderer).
   * A no-op (same Set reference kept) when the snapshot already matches, so
   * this never triggers a spurious re-render on the common "nothing
   * changed" path.
   */
  reconcile: (liveIds: readonly string[]) => void;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

export const useMiniAppWindowStore = create<MiniAppWindowState>()((set) => ({
  runningIds: new Set<string>(),
  markOpened: (id) =>
    set((state) => {
      if (state.runningIds.has(id)) return state;
      const next = new Set(state.runningIds);
      next.add(id);
      return { runningIds: next };
    }),
  markClosed: (id) =>
    set((state) => {
      if (!state.runningIds.has(id)) return state;
      const next = new Set(state.runningIds);
      next.delete(id);
      return { runningIds: next };
    }),
  reconcile: (liveIds) =>
    set((state) => {
      const next = new Set(liveIds);
      if (setsEqual(state.runningIds, next)) return state;
      return { runningIds: next };
    }),
}));
