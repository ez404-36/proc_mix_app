// Types for the standalone quick-launch prompt dialog window (v0.12.0).
//
// Mirrors the Rust `core::launch::QuickPromptRequest` DTO (camelCase). The
// backend bundles everything the window needs so it performs NO extra fetch:
// the command's variable specs, the admin flag, and the shell launch context.

import type { VariableSpec } from "./command";

/**
 * The pending quick-launch the prompt window must collect input for. Returned
 * by the `get_quick_prompt_request` command; `null` when nothing is pending.
 */
export interface QuickPromptRequest {
  /** Logical id of the command to run (echoed back on submit, server-side). */
  commandId: string;
  /** Display name, for the dialog heading. */
  commandName: string;
  /** The command's variable specs — the window asks exactly what a run would. */
  variables: VariableSpec[];
  /** Whether a one-shot admin password must also be collected (Unix elevation). */
  needsAdmin: boolean;
  /**
   * The shell-selected path, injected as `PROCMIX_SELECTED_PATH`. Pre-fills /
   * satisfies that variable; absent for a tray launch.
   */
  selectedPath?: string;
  /** Working-directory override (selected folder); absent unless a directory. */
  workingDirOverride?: string;
}
