// Types for the file-manager shell integration (v0.12.0).
//
// Mirrors the Rust DTO crossing the IPC boundary (camelCase):
//   - `ShellIntegrationStatus` ↔ `platform::shell_integration::ShellIntegrationStatus`
//
// `enabled` is read live from the OS registration (Windows `HKCU\Software\Classes`
// keys / Linux `.desktop` file) — the source of truth — not from SQLite, mirroring
// the autostart model. `supported` is false on platforms without a backend
// (macOS / other) so the Settings UI can hide the toggle.

/** Live shell-integration status returned by `shellIntegrationStatus`. */
export interface ShellIntegrationStatus {
  /**
   * Whether this platform has a shell-integration backend at all. `false` on
   * macOS and other unsupported targets — the Settings toggle is hidden then.
   */
  supported: boolean;
  /** Whether the OS context-menu registration currently exists. */
  enabled: boolean;
}
