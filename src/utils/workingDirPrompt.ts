// Imperative singleton for the working-directory prompt modal.
//
// Mirrors variablePrompt.ts exactly — `triggerCommandRun` lives outside
// the React tree, so the modal is opened via a handler the
// `<WorkingDirPrompt>` component registers at mount.

export type WorkingDirPromptHandler = (
  defaultValue: string,
) => Promise<string | null>;

let registeredHandler: WorkingDirPromptHandler | null = null;

/**
 * Register the modal's open-and-await function. Called once by the
 * `<WorkingDirPrompt>` component on mount, and again with `null` on
 * unmount.
 */
export function registerWorkingDirPromptHandler(
  handler: WorkingDirPromptHandler | null,
): void {
  registeredHandler = handler;
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
  if (!registeredHandler) {
    return null;
  }
  return registeredHandler(defaultValue);
}

/** @internal */
export function _resetWorkingDirPromptHandler(): void {
  registeredHandler = null;
}
