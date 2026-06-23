// Detection helpers for the SSH remote-execution error sentinels the Rust
// executor returns from `execute_command`. Centralises the comparisons so
// `triggerCommandRun` doesn't reach into `err.message` itself, and so a future
// move to a typed AppError variant only touches this one spot.
//
// Each sentinel is mirrored on the Rust side (`core::executor::types`) and
// pinned by a unit test there, so a rename on one side breaks the other side's
// tests rather than failing silently in production.

/**
 * Prefix the executor returns when a remote run's SSH alias fails the
 * allow-list check (`core::ssh::is_safe_alias`). The offending alias follows
 * the colon. Matched by prefix because the alias is appended.
 *
 * Mirrors `ERR_INVALID_REMOTE_TARGET` in Rust.
 */
export const INVALID_REMOTE_TARGET_PREFIX = "INVALID_REMOTE_TARGET:";

/**
 * Sentinel the executor returns when an elevated run is requested against a
 * remote target. Remote elevation is unsupported in this version (local
 * sudo/UAC does not map onto a remote host).
 *
 * Mirrors `ERR_REMOTE_ELEVATION_UNSUPPORTED` in Rust. The normal run path
 * never sends an elevated remote request (`executor.ts` drops elevation for
 * remote targets and the form disables the toggle); this is defence in depth.
 */
export const REMOTE_ELEVATION_UNSUPPORTED = "REMOTE_ELEVATION_UNSUPPORTED";

/**
 * Sentinel the executor returns when a `remotePrompt` target reaches the spawn
 * path unresolved. The frontend is responsible for resolving it to a concrete
 * remote target (a host picker) before invoking, so this is a guard against
 * that contract being violated.
 *
 * Mirrors `ERR_REMOTE_TARGET_UNRESOLVED` in Rust.
 */
export const REMOTE_TARGET_UNRESOLVED = "REMOTE_TARGET_UNRESOLVED";

/**
 * Prefix the executor returns when parking the one-shot SSH password in the
 * keychain fails before `ssh` is spawned (no Secret Service on a headless
 * Linux box, permission denied, …). The backend error message follows the
 * colon; it never contains the password.
 *
 * Mirrors `ERR_SSH_PASSWORD_BACKEND_PREFIX` in Rust.
 */
export const SSH_PASSWORD_BACKEND_PREFIX = "SSH_PASSWORD_BACKEND:";

/** Coerce any thrown value into the string the Rust handler rejected with. */
function errorMessage(err: unknown): string {
  return err instanceof Error
    ? err.message
    : typeof err === "string"
      ? err
      : String(err);
}

/**
 * True when `err` is the invalid-remote-alias sentinel. Returns the offending
 * alias when present so the caller can include it in the toast; an empty
 * string when the alias portion is absent.
 */
export function parseInvalidRemoteTargetError(err: unknown): string | null {
  const msg = errorMessage(err);
  if (!msg.startsWith(INVALID_REMOTE_TARGET_PREFIX)) {
    return null;
  }
  return msg.slice(INVALID_REMOTE_TARGET_PREFIX.length);
}

/** True when `err` is the remote-elevation-unsupported sentinel. */
export function isRemoteElevationUnsupportedError(err: unknown): boolean {
  return errorMessage(err) === REMOTE_ELEVATION_UNSUPPORTED;
}

/** True when `err` is the unresolved-remote-prompt sentinel. */
export function isRemoteTargetUnresolvedError(err: unknown): boolean {
  return errorMessage(err) === REMOTE_TARGET_UNRESOLVED;
}

/**
 * True when `err` is the SSH-password keychain-backend sentinel. Returns the
 * backend message after the prefix so the caller can include it in the toast;
 * an empty string when the suffix is absent.
 */
export function parseSshPasswordBackendError(err: unknown): string | null {
  const msg = errorMessage(err);
  if (!msg.startsWith(SSH_PASSWORD_BACKEND_PREFIX)) {
    return null;
  }
  return msg.slice(SSH_PASSWORD_BACKEND_PREFIX.length);
}
