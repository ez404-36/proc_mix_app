// Imperative singleton for the admin-password modal.
//
// `triggerCommandRun` lives outside the React tree, so it can't pull a
// modal into existence via state. Instead, the App's `<AdminPasswordPrompt>`
// component registers a handler here at mount time, and the runtime
// helper `promptForAdminPassword` awaits it.
//
// Thin specialization of the shared `createPromptRegistry` factory — see
// `createPromptRegistry.ts` for the singleton/registration contract. Only
// one prompt can be active at a time.

import { createPromptRegistry } from "./createPromptRegistry";

/**
 * Result of a successful prompt. The modal exposes two confirm buttons:
 *
 *   - "Save & continue"  → resolve `{ password, remember: true }`. The
 *     caller persists the value via `setAdminPassword` and reuses it
 *     for future elevated runs.
 *   - "Continue"         → resolve `{ password, remember: false }`. The
 *     caller uses the value for THIS run only and never writes it to
 *     the OS keychain. Subsequent elevated runs will prompt again.
 *
 * Cancellation is signalled by resolving the outer Promise with `null`
 * (see {@link AdminPasswordPromptHandler}).
 */
export interface AdminPasswordPromptResult {
  password: string;
  remember: boolean;
}

/**
 * Function shape the modal component registers. It must show its UI,
 * wait for the user to submit or cancel, and resolve with either an
 * {@link AdminPasswordPromptResult} or `null` if the user cancelled.
 */
export type AdminPasswordPromptHandler = () => Promise<AdminPasswordPromptResult | null>;

const registry = createPromptRegistry<[], AdminPasswordPromptResult>();

/**
 * Register the modal's open-and-await function. Called once by the
 * `<AdminPasswordPrompt>` component on mount, and again with `null`
 * on unmount. The component must keep the handler alive for the
 * entire lifetime of the app — there's only one prompt instance.
 */
export function registerAdminPasswordPromptHandler(
  handler: AdminPasswordPromptHandler | null,
): void {
  registry.register(handler);
}

/**
 * Request the modal to open. Resolves to:
 *
 *   - an {@link AdminPasswordPromptResult} when the user submits, OR
 *   - `null` when the user cancels OR when no handler is registered
 *     (which should never happen in production but is the safe fallback
 *     for tests / SSR / early boot).
 *
 * The caller decides whether to persist the password based on
 * `result.remember`. When `remember` is true the caller is responsible
 * for calling `setAdminPassword(result.password)` before retrying; when
 * false the password must be passed one-shot to the executor and never
 * written to the keychain.
 */
export async function promptForAdminPassword(): Promise<AdminPasswordPromptResult | null> {
  return registry.prompt();
}

/** @internal */
export function _resetAdminPasswordPromptHandler(): void {
  registry._reset();
}
