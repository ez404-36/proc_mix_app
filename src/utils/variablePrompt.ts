// Imperative singleton for the runtime variable-collection modal.
//
// `triggerCommandRun` and the executor wrapper live outside the React
// tree, so the modal is opened via a handler the `<VariablePrompt />`
// component registers at mount. The pattern mirrors
// `adminPasswordPrompt.ts` exactly — see the failures.md entry about
// keeping `handlers.add` and the returned unsub in the same
// synchronous tick.

import type { VariableSpec } from "../types";

/**
 * Result of a successful prompt: a map of `name -> value` covering
 * EVERY spec the modal asked about. Values from `preset` are passed
 * through; the modal's job is to fill in the rest.
 *
 * A `null` from {@link promptForVariables} signals the user cancelled
 * the modal — callers must abort the run entirely (not fall back to
 * defaults), to match the cancellation semantics of the admin-password
 * prompt.
 */
export type VariablePromptHandler = (
  specs: VariableSpec[],
  preset: Record<string, string>,
) => Promise<Record<string, string> | null>;

let registeredHandler: VariablePromptHandler | null = null;

/**
 * Register the modal's open-and-await function. Called once by the
 * `<VariablePrompt>` component on mount, and again with `null` on
 * unmount. The component must keep the handler alive for the entire
 * lifetime of the app — there's only one prompt instance.
 */
export function registerVariablePromptHandler(
  handler: VariablePromptHandler | null,
): void {
  registeredHandler = handler;
}

/**
 * Open the variable-prompt modal for the given specs. Resolves to:
 *   - a `Record<string, string>` mapping every prompted spec's name to
 *     its user-supplied value, OR
 *   - `null` when the user cancels.
 *
 * Short-circuit: when `specs` is empty, returns `{}` synchronously
 * without invoking the handler. This keeps the call-site terse — the
 * common "no variables" path doesn't pay the modal-mount cost.
 *
 * Fallback: when no handler is registered (e.g. tests that didn't
 * bother to mount `<VariablePrompt>`), we resolve to `null` — treating
 * it as "cancelled" matches the contract used by adminPasswordPrompt
 * and prevents the run from proceeding with unsubstituted templates.
 *
 * `preset` carries any values the caller already collected (e.g. from
 * the spec defaults or programmatic input). The component is
 * responsible for not asking the user to re-type these — they round-
 * trip through the resolution result unchanged.
 */
export async function promptForVariables(
  specs: VariableSpec[],
  preset: Record<string, string> = {},
): Promise<Record<string, string> | null> {
  if (specs.length === 0) {
    return {};
  }
  if (!registeredHandler) {
    return null;
  }
  return registeredHandler(specs, preset);
}

// ------------------------------------------------------------------
// Test-only helpers. Tests need to reset the registry between cases
// because the module is loaded once per worker.
// ------------------------------------------------------------------

/** @internal */
export function _resetVariablePromptHandler(): void {
  registeredHandler = null;
}
