import { invoke } from '@tauri-apps/api/core';
import type { RawEnvFileSummary } from '../types/envManager';

/** Return the list of registered .env file paths from the config. */
export async function listEnvFiles(): Promise<string[]> {
  return invoke<string[]>('list_env_files');
}

/**
 * Add a .env file path to the config list.
 * Returns the updated list.
 */
export async function addEnvFile(path: string): Promise<string[]> {
  return invoke<string[]>('add_env_file', { path });
}

/**
 * Remove a .env file path from the config list.
 * Returns the updated list.
 */
export async function removeEnvFile(path: string): Promise<string[]> {
  return invoke<string[]>('remove_env_file', { path });
}

/**
 * Parse a .env file and return its entries.
 *
 * Always resolves (never rejects). Parse errors are reported inside
 * `RawEnvFileSummary.error`.
 */
export async function readEnvFile(path: string): Promise<RawEnvFileSummary> {
  return invoke<RawEnvFileSummary>('read_env_file', { path });
}

/** Update or append a KEY=VALUE line in a .env file. */
export async function writeEnvFileEntry(
  path: string,
  key: string,
  value: string,
): Promise<void> {
  return invoke<void>('write_env_file_entry', { path, key, value });
}

/** Remove the line for KEY from a .env file. */
export async function deleteEnvFileEntry(
  path: string,
  key: string,
): Promise<void> {
  return invoke<void>('delete_env_file_entry', { path, key });
}

/**
 * Open the native file picker filtered to .env files.
 * Returns the chosen path, or `null` when the user cancels.
 */
export async function pickEnvFile(): Promise<string | null> {
  return invoke<string | null>('pick_env_file');
}
