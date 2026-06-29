// Types for the autostart feature (launch ProcMix at system login).
//
// Mirrors the Rust DTO crossing the IPC boundary (camelCase):
//   - `AutostartStatus` ↔ `commands::autostart::AutostartStatus`
//
// `enabled` is read live from the OS registration (Windows Run key / macOS
// LaunchAgent / Linux .desktop) — the source of truth — not from SQLite, so it
// stays correct even if the user toggled autostart through the OS.
// `startMinimized` is the app-side behaviour flag persisted by ProcMix.

/** Live autostart status returned by `autostartStatus`. */
export interface AutostartStatus {
  /** Whether ProcMix is registered to launch at system login. */
  enabled: boolean;
  /**
   * When a system-launched ProcMix should start hidden in the tray (no visible
   * window). Only applies to a launch triggered by the OS; a manual launch
   * always shows the window.
   */
  startMinimized: boolean;
}
