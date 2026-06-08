import { invoke } from "@tauri-apps/api/core";
import type { PlatformOrUnknown } from "../types/platform";
import { isPlatform } from "../types/platform";

/**
 * Cached host-OS identifier returned by the Rust `get_platform` IPC command.
 * `null` while the first request is in-flight or has not been made yet. Once
 * resolved, every subsequent call short-circuits to this value because the
 * host OS cannot change during a session.
 */
let cachedPlatform: PlatformOrUnknown | null = null;

/**
 * Fetch the host OS identifier from the Rust side. Resolves to one of
 * `linux | macos | windows | unknown`. If the IPC call throws (e.g. the
 * frontend is being tested outside a Tauri shell), this falls back to
 * `linux` so callers always get a usable platform.
 */
export async function getPlatform(): Promise<PlatformOrUnknown> {
  if (cachedPlatform !== null) return cachedPlatform;
  try {
    const raw = await invoke<string>("get_platform");
    cachedPlatform = isPlatform(raw) ? raw : "unknown";
  } catch (e) {
    console.warn(
      "Failed to fetch platform from Rust; defaulting to linux",
      e,
    );
    cachedPlatform = "linux";
  }
  return cachedPlatform;
}

/**
 * Synchronous accessor for the cached platform. Returns `null` until the
 * first `getPlatform()` call resolves. Intended for places that already
 * know the bootstrap has completed (post-mount).
 */
export function getCachedPlatform(): PlatformOrUnknown | null {
  return cachedPlatform;
}

/**
 * Test-only helper to clear the platform cache between cases. Not exported
 * from a barrel; callers must import explicitly.
 */
export function __resetPlatformCacheForTests(): void {
  cachedPlatform = null;
}
