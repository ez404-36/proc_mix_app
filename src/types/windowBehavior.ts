// Types for the window-behaviour feature (what closing the main window does).
//
// Mirrors the Rust DTO crossing the IPC boundary (camelCase):
//   - `WindowBehaviorConfig` ↔ `storage::window_behavior::WindowBehaviorConfig`
//
// `closeToTray` is persisted in SQLite and read at launch into a synchronous
// runtime cache the backend's CloseRequested handler consumes. See
// `commands::window_behavior` and the Settings → Tray section.

/** Persisted window-behaviour config. */
export interface WindowBehaviorConfig {
  /**
   * `true` (default) → closing the main window hides it to the system tray;
   * `false` → closing the window quits ProcMix.
   */
  closeToTray: boolean;
}
