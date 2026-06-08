import { invoke } from '@tauri-apps/api/core';

/**
 * Fetch a snapshot of the current process's environment variables.
 *
 * The result is memoised: environment variables do not change at runtime
 * for a GUI app, so multiple calls return the same object without an
 * additional IPC round-trip. The cache is intentionally never invalidated.
 */
let cached: Record<string, string> | null = null;

export async function getProcessEnv(): Promise<Record<string, string>> {
  if (cached !== null) return cached;
  const result = await invoke<Record<string, string>>('get_process_env');
  cached = result;
  return result;
}

/**
 * Return the cached snapshot synchronously, or `null` if `getProcessEnv`
 * has not been called yet.
 */
export function getCachedProcessEnv(): Record<string, string> | null {
  return cached;
}
