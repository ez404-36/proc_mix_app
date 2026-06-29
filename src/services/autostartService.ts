// Typed wrappers around the autostart Tauri commands.
//
// `invoke` is confined to this service layer (project convention): components
// and stores call these functions, never `invoke` directly. The OS registration
// is the source of truth for whether autostart is enabled — `getAutostartStatus`
// reads it live via the backend. See `commands::autostart` and the
// Settings → Autostart section.

import { invoke } from "@tauri-apps/api/core";
import type { AutostartStatus } from "../types/autostart";

/** Live autostart status: OS-registration `enabled` flag + persisted `startMinimized`. */
export async function getAutostartStatus(): Promise<AutostartStatus> {
  return invoke<AutostartStatus>("autostart_status");
}

/**
 * Enable/disable the OS autostart registration and persist the `startMinimized`
 * behaviour flag. Rejects with an error whose message starts with
 * `AUTOSTART_ERROR:` when the OS registration fails (e.g. keychain/registry
 * access denied), or `AUTOSTART_UNSUPPORTED:` on a non-desktop target.
 */
export async function setAutostart(
  enabled: boolean,
  startMinimized: boolean,
): Promise<void> {
  await invoke("set_autostart", { enabled, startMinimized });
}
