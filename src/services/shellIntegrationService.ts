// Typed wrappers around the shell-integration Tauri commands.
//
// `invoke` is confined to this service layer (project convention): components
// and stores call these functions, never `invoke` directly. The OS registration
// is the source of truth for whether the integration is enabled —
// `getShellIntegrationStatus` reads it live via the backend. See
// `commands::shell_integration` and the Settings → System section.

import { invoke } from "@tauri-apps/api/core";
import type { ShellIntegrationStatus } from "../types/shellIntegration";

/** Live shell-integration status: `supported` (build) + `enabled` (OS registration). */
export async function getShellIntegrationStatus(): Promise<ShellIntegrationStatus> {
  return invoke<ShellIntegrationStatus>("shell_integration_status");
}

/**
 * Enable or disable the file-manager context-menu integration. Enabling writes
 * the OS registration with the current favorites; disabling removes it. Rejects
 * with an error whose message starts with `SHELL_INTEGRATION_UNSUPPORTED:` on a
 * platform without a backend (macOS / other).
 */
export async function setShellIntegration(enabled: boolean): Promise<void> {
  await invoke("set_shell_integration", { enabled });
}
