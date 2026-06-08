// Typed wrappers around the Rust-side admin-password IPC commands.
//
// The actual secret lives in the OS keychain (Secret Service / macOS
// Keychain / Windows Credential Manager) via the `keyring` crate on the
// Rust side. The JS layer only ever sees:
//
//   - a boolean status ("is something stored?")  via admin_password_status
//   - a setter that takes the password and returns nothing
//   - an idempotent clear
//
// The password value never crosses the IPC boundary from Rust back to
// JS. The Tauri commands are wired in src-tauri/src/commands/mod.rs and
// registered in lib.rs.

import { invoke } from "@tauri-apps/api/core";

/**
 * Sentinel string the Rust executor returns from `execute_command` when
 * the user requested an elevated run on Unix but no password is stored
 * in the keychain yet. The JS bridge compares with `===` (strict
 * equality) — any wrapping like `new Error(ADMIN_PASSWORD_REQUIRED)`
 * would still expose `.message` matching this exact value.
 *
 * Mirrored as `ERR_ADMIN_PASSWORD_REQUIRED` in Rust; both sides have a
 * unit test pinning the literal so a rename on one side breaks the
 * other side's tests, not production silently.
 */
export const ADMIN_PASSWORD_REQUIRED = "ADMIN_PASSWORD_REQUIRED";

/**
 * Prefix the Rust executor returns when reading the keychain failed
 * (Linux without D-Bus, macOS denied access, etc.). The remainder of
 * the message is suitable for surfacing to the user as context — the
 * keychain library does NOT include the password value in error
 * variants.
 */
export const ADMIN_PASSWORD_BACKEND_PREFIX = "ADMIN_PASSWORD_BACKEND:";

/**
 * @returns true iff a sudo password is currently stored in the OS
 *   keychain for this app. Used by the Settings UI to swap the
 *   "Set password" / "Clear saved password" buttons, and by the
 *   CommandForm to decide whether to show a hint about the first
 *   elevated run.
 */
export async function hasAdminPassword(): Promise<boolean> {
  return invoke<boolean>("admin_password_status");
}

/**
 * Persist the given password to the OS keychain. Whitespace is trimmed
 * Rust-side; empty strings are rejected with a typed error. The Promise
 * resolves to `void` — there is no read-back of the stored value.
 *
 * Throws a string error from the Rust handler on failure (keychain
 * unavailable, OS denied, etc.).
 */
export async function setAdminPassword(password: string): Promise<void> {
  await invoke("set_admin_password", { password });
}

/**
 * Remove the stored password. Idempotent — calling it when nothing is
 * stored is not an error, so the UI can call it unconditionally.
 */
export async function clearAdminPassword(): Promise<void> {
  await invoke("clear_admin_password");
}

/**
 * True when the given error matches the `ADMIN_PASSWORD_REQUIRED`
 * sentinel from Rust. Centralises the comparison so callers don't
 * have to reach into `err.message` themselves and so a future move to
 * a typed AppError variant only touches this one spot.
 */
export function isAdminPasswordRequiredError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : String(err);
  return msg === ADMIN_PASSWORD_REQUIRED;
}
