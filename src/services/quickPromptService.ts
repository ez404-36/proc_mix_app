// Typed wrappers around the quick-prompt Tauri commands (v0.12.0).
//
// Used only by the standalone prompt window (`QuickPromptApp`). `invoke` is
// confined to this service layer per project convention. See
// `platform::quick_prompt` for the backend.

import { invoke } from "@tauri-apps/api/core";
import type { QuickPromptRequest } from "../types/quickPrompt";

/** Read the pending quick-prompt request, or `null` when nothing is pending. */
export async function getQuickPromptRequest(): Promise<QuickPromptRequest | null> {
  return invoke<QuickPromptRequest | null>("get_quick_prompt_request");
}

/**
 * Submit the collected variable values and (optionally) a one-shot admin
 * password. The backend runs the command headlessly and records the result;
 * the window should close itself after this resolves.
 */
export async function submitQuickPrompt(
  values: Record<string, string>,
  adminPassword?: string,
): Promise<void> {
  await invoke("submit_quick_prompt", {
    values,
    adminPassword: adminPassword ?? null,
  });
}

/** Cancel the pending quick-prompt (user dismissed the dialog). */
export async function cancelQuickPrompt(): Promise<void> {
  await invoke("cancel_quick_prompt");
}
