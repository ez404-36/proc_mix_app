// Typed wrappers around the window-behaviour Tauri commands.
//
// `invoke` is confined to this service layer (project convention): components
// call these functions, never `invoke` directly. See
// `commands::window_behavior` and the Settings → Tray section.

import { invoke } from "@tauri-apps/api/core";
import type { WindowBehaviorConfig } from "../types/windowBehavior";

/** Read the persisted window-behaviour config (the `closeToTray` flag). */
export async function getWindowBehavior(): Promise<WindowBehaviorConfig> {
  return invoke<WindowBehaviorConfig>("get_window_behavior");
}

/**
 * Persist whether closing the main window hides it to the tray (`true`,
 * default) or quits ProcMix (`false`). The backend also updates its runtime
 * cache so the change applies to the next window close without a restart.
 */
export async function setWindowBehavior(closeToTray: boolean): Promise<void> {
  await invoke("set_window_behavior", { closeToTray });
}
