// Imperative singleton for the one-shot SSH-password modal.
//
// Mirrors remoteHostPrompt.ts / workingDirPrompt.ts: `triggerCommandRun` lives
// outside the React tree, so the App's `<SshPasswordPrompt>` component
// registers an open-and-await handler here at mount, and the runtime helper
// `promptForSshPassword` awaits it.
//
// Unlike the admin-password prompt there is NO "remember" option — the SSH
// password is strictly one-shot (entered per run, never persisted). The
// resolved string is handed to the executor for a single run and forgotten;
// the backend parks it in a throwaway keychain entry that is cleared after the
// run. See `docs/plans/ssh-remote-password-transient-keychain.md`.

/**
 * Function shape the modal registers: show the password input, wait for submit
 * or cancel, and resolve with the entered password, or `null` on cancel.
 *
 * `alias` is the host the password is for, so the modal can name it.
 */
export type SshPasswordPromptHandler = (
  alias: string,
) => Promise<string | null>;

let registeredHandler: SshPasswordPromptHandler | null = null;

/**
 * Register the modal's open-and-await function. Called once by the
 * `<SshPasswordPrompt>` component on mount, and again with `null` on unmount.
 */
export function registerSshPasswordPromptHandler(
  handler: SshPasswordPromptHandler | null,
): void {
  registeredHandler = handler;
}

/**
 * Open the SSH-password prompt for `alias`. Resolves to:
 *   - the entered password string, OR
 *   - `null` when the user cancels (abort the run), OR when no handler is
 *     registered (tests / early boot) — treated as cancel.
 */
export async function promptForSshPassword(
  alias: string,
): Promise<string | null> {
  if (!registeredHandler) {
    return null;
  }
  return registeredHandler(alias);
}

/** @internal */
export function _resetSshPasswordPromptHandler(): void {
  registeredHandler = null;
}
