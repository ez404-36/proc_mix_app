// Orchestration for the quick-launch prompt window: decide which variable
// specs to ask, drive the variable + admin-password modals, and submit (or
// cancel) the run. Kept separate from the React component so the flow is unit
// testable without rendering.

import type { VariableSpec } from "../../types/command";
import type { QuickPromptRequest } from "../../types/quickPrompt";
import { promptForVariables } from "../../utils/variablePrompt";
import { promptForAdminPassword } from "../../utils/adminPasswordPrompt";
import { setAdminPassword } from "../../utils/adminPassword";
import {
  submitQuickPrompt,
  cancelQuickPrompt,
} from "../../services/quickPromptService";

/** The reserved variable holding the shell-selected path. */
const SELECTED_PATH_VAR = "PROCMIX_SELECTED_PATH";

/**
 * Resolve the variable values for a quick-launch, asking the user only for the
 * specs that need it. Mirrors `commandRunner.resolveVariableValues`:
 *   - every spec with a `defaultValue` contributes it to the merged map;
 *   - a spec is PROMPTED when it has no caller-supplied value AND
 *     (`defaultValue === undefined` OR `promptAtRuntime === true`);
 *   - prompt results win over defaults.
 *
 * `provided` is the caller-supplied map (here: `PROCMIX_SELECTED_PATH` when the
 * shell passed a path). A spec whose value is provided is never re-asked.
 *
 * Returns the merged value map, or `null` if the user cancelled the prompt.
 */
export async function resolveQuickPromptVariables(
  specs: ReadonlyArray<VariableSpec>,
  provided: Record<string, string>,
): Promise<Record<string, string> | null> {
  const merged: Record<string, string> = {};
  const specsNeedingPrompt: VariableSpec[] = [];
  const promptPreset: Record<string, string> = {};

  for (const spec of specs) {
    if (spec.defaultValue !== undefined) {
      merged[spec.name] = spec.defaultValue;
    }
    if (provided[spec.name] !== undefined) {
      // A provided value (e.g. the selected path) short-circuits prompting.
      continue;
    }
    const mustPrompt =
      spec.defaultValue === undefined || spec.promptAtRuntime === true;
    if (mustPrompt) {
      specsNeedingPrompt.push(spec);
      if (spec.defaultValue !== undefined) {
        promptPreset[spec.name] = spec.defaultValue;
      }
    }
  }

  // Layer provided values over defaults.
  for (const key of Object.keys(provided)) {
    merged[key] = provided[key] as string;
  }

  if (specsNeedingPrompt.length === 0) {
    return merged;
  }

  const promptResult = await promptForVariables(specsNeedingPrompt, promptPreset);
  if (promptResult === null) {
    return null;
  }
  for (const key of Object.keys(promptResult)) {
    merged[key] = promptResult[key] as string;
  }
  return merged;
}

/** Terminal state of the quick-prompt flow, for the window to react to. */
export type QuickPromptFlowResult = "submitted" | "cancelled";

/**
 * Run the full quick-prompt flow for a request: collect variables, then (when
 * `needsAdmin`) the admin password — persisting it to the keychain on "Save &
 * continue" or forwarding it one-shot on "Continue" — then submit. Cancelling
 * EITHER prompt aborts the whole run (calls `cancelQuickPrompt`). Returns which
 * terminal path was taken so the caller can close the window.
 */
export async function runQuickPromptFlow(
  request: QuickPromptRequest,
): Promise<QuickPromptFlowResult> {
  // The shell-selected path is a provided value for the reserved variable, so a
  // command referencing it is satisfied without asking.
  const provided: Record<string, string> = {};
  if (request.selectedPath !== undefined) {
    provided[SELECTED_PATH_VAR] = request.selectedPath;
  }

  const values = await resolveQuickPromptVariables(request.variables, provided);
  if (values === null) {
    await cancelQuickPrompt();
    return "cancelled";
  }

  let adminPassword: string | undefined;
  if (request.needsAdmin) {
    const result = await promptForAdminPassword();
    if (result === null) {
      // User cancelled the admin prompt — abort the whole run.
      await cancelQuickPrompt();
      return "cancelled";
    }
    // Honour the modal's two choices, mirroring `commandRunner`:
    //   - "Save & continue" (remember=true)  → persist to the OS keychain and
    //     do NOT forward one-shot; the executor reads it from the keychain.
    //   - "Continue"        (remember=false) → forward one-shot via the run
    //     payload; never persisted.
    if (result.remember) {
      try {
        await setAdminPassword(result.password);
      } catch {
        // Saving failed (keychain unavailable) — fall back to a one-shot run so
        // the launch still proceeds rather than being lost.
        adminPassword = result.password;
      }
    } else {
      adminPassword = result.password;
    }
  }

  await submitQuickPrompt(values, adminPassword);
  return "submitted";
}
