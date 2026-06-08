import { invoke } from "@tauri-apps/api/core";
import type { Shell } from "../types";

/**
 * Logical shell identifiers the form is willing to surface. Mirrors the
 * `Shell` union character-for-character; values returned by Rust that
 * don't appear here are dropped (with a console warning) rather than
 * blindly trusted.
 */
const KNOWN_SHELLS: ReadonlyArray<Shell> = [
  "bash",
  "zsh",
  "sh",
  "fish",
  "pwsh",
  "powershell",
  "cmd",
];

function isKnownShell(value: string): value is Shell {
  return (KNOWN_SHELLS as readonly string[]).includes(value);
}

/**
 * Cached subset of shells detected on the host system. `null` until the
 * first `loadAvailableShells()` call resolves. The host cannot grow new
 * shells during a session in any way that matters to us, so this is
 * fetched exactly once and held until process exit.
 */
let cachedShells: ReadonlyArray<Shell> | null = null;
let pendingLoad: Promise<ReadonlyArray<Shell>> | null = null;

/**
 * Fetch the list of shells available on the host. Resolves with an
 * array drawn from the `Shell` union, in detection order. Subsequent
 * calls reuse the cached result (and the in-flight promise if called
 * concurrently — important for React 19 StrictMode double-mount).
 *
 * On IPC failure (e.g. running in a Vitest/jsdom environment without
 * Tauri), the function logs a warning and resolves with an empty list.
 * Callers should treat the empty case as "detection failed" and fall
 * back to a platform default rather than refusing to render the form.
 */
export async function loadAvailableShells(): Promise<ReadonlyArray<Shell>> {
  if (cachedShells !== null) return cachedShells;
  if (pendingLoad !== null) return pendingLoad;

  pendingLoad = (async () => {
    try {
      const raw = await invoke<string[]>("get_available_shells");
      const filtered: Shell[] = [];
      for (const entry of raw) {
        if (isKnownShell(entry)) {
          filtered.push(entry);
        } else {
          console.warn(
            `get_available_shells returned unknown shell identifier ${JSON.stringify(entry)}; ignoring`,
          );
        }
      }
      cachedShells = filtered;
      return cachedShells;
    } catch (e) {
      console.warn(
        "Failed to load available shells from Rust; assuming none detected",
        e,
      );
      cachedShells = [];
      return cachedShells;
    } finally {
      pendingLoad = null;
    }
  })();

  return pendingLoad;
}

/**
 * Synchronous accessor for the cached shell list. Returns `null` while
 * the first `loadAvailableShells()` call is still in flight. Intended
 * for places that already know the bootstrap has completed (post-mount,
 * inside event handlers, etc.).
 */
export function getCachedAvailableShells(): ReadonlyArray<Shell> | null {
  return cachedShells;
}

/**
 * Test-only helper to clear the cache between cases. Not exported from
 * a barrel; tests must import explicitly.
 */
export function __resetAvailableShellsCacheForTests(): void {
  cachedShells = null;
  pendingLoad = null;
}
