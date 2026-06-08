// Typed wrappers around the env-snapshot Tauri commands.
//
// User snapshot: current process env + best-effort source detection
// from known shell-startup files. Cheap and always available.
//
// Root snapshot: `sudo env` output + root file source detection.
// Rejects with the ADMIN_PASSWORD_REQUIRED sentinel when no password
// is stored in the OS keychain. The store catches this sentinel and
// transitions to `no_password` state so the UI can show a prompt
// button without a generic error toast.

import { invoke } from '@tauri-apps/api/core';
import type { EnvSnapshot } from '../types/envSnapshot';

/** Build the user-scope env snapshot (no sudo required). */
export async function getUserEnvWithSources(): Promise<EnvSnapshot> {
  return invoke<EnvSnapshot>('get_user_env_with_sources');
}

/**
 * Build the root-scope env snapshot via `sudo env`.
 *
 * Rejects when no admin password is stored in the OS keychain — the
 * rejection value is the `ADMIN_PASSWORD_REQUIRED` sentinel string.
 * All other rejections are genuine errors (wrong password, sudo
 * timeout, etc.).
 */
export async function getRootEnvWithSources(): Promise<EnvSnapshot> {
  return invoke<EnvSnapshot>('get_root_env_with_sources');
}

/**
 * Open the Windows "System Properties → Environment Variables" dialog.
 * Returns `true` when the dialog was launched, `false` on non-Windows
 * platforms (the UI hides the button in that case).
 */
export async function openWindowsEnvDialog(): Promise<boolean> {
  return invoke<boolean>('open_windows_env_dialog');
}
