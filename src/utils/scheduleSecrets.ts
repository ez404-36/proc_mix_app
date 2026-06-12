// Sentinel handling for sensitive schedule variable values (security fix H-1).
//
// Scheduled commands store SENSITIVE variable values in the OS keychain rather
// than as plaintext in SQLite. In the persisted `schedule.variableValues` JSON,
// the secret is replaced by a fixed sentinel string. The frontend must never
// render this sentinel to the user, and must round-trip it untouched when the
// user leaves a sensitive field blank (so the backend keeps the existing
// keychain secret instead of clobbering it).
//
// The exact sentinel is a leading U+0001, the marker text, and a trailing
// U+0001 — kept byte-for-byte in sync with the Rust backend
// (`src-tauri/src/security/schedule_secrets.rs`).

/** Placeholder stored in `variableValues` in place of a keychain-held secret. */
export const SCHEDULE_SECRET_REF = "\u0001procmix:keychain-secret\u0001";

/** Whether `v` is the keychain-secret sentinel (an existing stored secret). */
export function isScheduleSecretRef(v: string): boolean {
  return v === SCHEDULE_SECRET_REF;
}
