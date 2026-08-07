// Opt-in consent gate for Process Capture (the background "command
// recorder"). See `docs/process-capture.md` for the full contract.
//
// Process Capture is OFF by default; capture may only start after the user
// accepts a one-time consent dialog. The accepted state is persisted on
// `useUIStore.processCaptureEnabled`.
//
// This module owns the pure gate logic so it can be unit-tested without a
// React tree. Callers supply `requestConsent` to render the actual dialog.

/**
 * Outcome of resolving capture consent. `granted` is the single source of
 * truth a caller checks before invoking `startProcessCapture`.
 *
 * - `alreadyGranted`: consent was persisted from a previous session — no
 *   dialog was shown this time.
 * - `justGranted`: the user accepted the dialog during this call.
 * - When `granted` is `false` the user declined (or the dialog was
 *   dismissed); capture MUST NOT start.
 */
export interface ConsentResult {
  granted: boolean;
  alreadyGranted: boolean;
  justGranted: boolean;
}

/** Reads/writes the persisted consent flag — backed by `useUIStore`. */
export interface ConsentStore {
  /** Current persisted opt-in state. */
  isEnabled: () => boolean;
  /** Persist a new opt-in state. */
  setEnabled: (enabled: boolean) => void;
}

/**
 * Show the consent dialog and resolve to the user's decision. Supplied by
 * the Recorder UI. Resolves `true` when the user accepts, `false` when they
 * decline or dismiss. It MUST NOT itself mutate the store — persistence is
 * owned by {@link resolveCaptureConsent} so the gate stays the single
 * writer.
 */
export type RequestConsent = () => Promise<boolean>;

/**
 * Resolve whether Process Capture is allowed to start, prompting for
 * one-time consent if it has not been granted yet.
 *
 * Flow:
 *   1. If consent was already persisted, resolve immediately — no dialog.
 *   2. Otherwise show the dialog. On accept, persist the flag and grant.
 *      On decline/dismiss, leave the flag `false` and deny.
 *
 * The persisted flag is only ever flipped to `true` here, and only after an
 * explicit accept — there is no code path that enables capture silently.
 */
export async function resolveCaptureConsent(
  store: ConsentStore,
  requestConsent: RequestConsent,
): Promise<ConsentResult> {
  if (store.isEnabled()) {
    return { granted: true, alreadyGranted: true, justGranted: false };
  }

  const accepted = await requestConsent();
  if (!accepted) {
    return { granted: false, alreadyGranted: false, justGranted: false };
  }

  store.setEnabled(true);
  return { granted: true, alreadyGranted: false, justGranted: true };
}
