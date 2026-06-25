// Imperative singleton for the working-directory prompt modal.
//
// Mirrors variablePrompt.ts exactly — `triggerCommandRun` lives outside
// the React tree, so the modal is opened via a handler the
// `<WorkingDirPrompt>` component registers at mount.
//
// Thin specialization of the shared `createPromptRegistry` factory.

import { createPromptRegistry } from "./createPromptRegistry";

export type WorkingDirPromptHandler = (
  defaultValue: string,
) => Promise<string | null>;

const registry = createPromptRegistry<[defaultValue: string], string>();

/**
 * Register the modal's open-and-await function. Called once by the
 * `<WorkingDirPrompt>` component on mount, and again with `null` on
 * unmount.
 */
export function registerWorkingDirPromptHandler(
  handler: WorkingDirPromptHandler | null,
): void {
  registry.register(handler);
}

/**
 * Open the working-directory prompt modal. Resolves to:
 *   - the directory string the user confirmed (may be empty — meaning
 *     "use the default"), OR
 *   - `null` when the user cancels (abort the run).
 *
 * Fallback: when no handler is registered (e.g. tests), resolves to
 * `null` — treating it as cancelled matches the variable-prompt contract.
 */
export async function promptForWorkingDir(
  defaultValue: string,
): Promise<string | null> {
  return registry.prompt(defaultValue);
}

/** @internal */
export function _resetWorkingDirPromptHandler(): void {
  registry._reset();
}
