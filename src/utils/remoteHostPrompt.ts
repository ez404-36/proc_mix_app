// Imperative singleton for the "choose remote host at run time" picker.
//
// Mirrors workingDirPrompt.ts / variablePrompt.ts exactly — `triggerCommandRun`
// lives outside the React tree, so the picker is opened via a handler the
// `<RemoteHostPrompt>` component registers at mount. The component reads the
// host inventory from the shared `useSshHostStore` (the same source as the
// Environment → Connections tab), so the offered list always matches.
//
// Thin specialization of the shared `createPromptRegistry` factory.

import { createPromptRegistry } from "./createPromptRegistry";

export type RemoteHostPromptHandler = () => Promise<string | null>;

const registry = createPromptRegistry<[], string>();

/**
 * Register the picker's open-and-await function. Called once by the
 * `<RemoteHostPrompt>` component on mount, and again with `null` on unmount.
 */
export function registerRemoteHostPromptHandler(
  handler: RemoteHostPromptHandler | null,
): void {
  registry.register(handler);
}

/**
 * Open the remote-host picker. Resolves to:
 *   - the SSH alias string the user selected, OR
 *   - `null` when the user cancels (abort the run).
 *
 * Fallback: when no handler is registered (e.g. tests, or before the picker
 * component mounts), resolves to `null` — treating it as cancelled, matching
 * the working-dir / variable prompt contracts.
 */
export async function promptForRemoteHost(): Promise<string | null> {
  return registry.prompt();
}

/** @internal */
export function _resetRemoteHostPromptHandler(): void {
  registry._reset();
}
