import { useEffect } from "react";
import { useCommandStore } from "../stores/commandStore";
import { useScheduleStore } from "../stores/scheduleStore";
import { useWorkflowStore } from "../stores/workflowStore";
import { getPlatform } from "../utils/platform";
import { loadAvailableShells } from "../utils/shells";
import type { Platform } from "../types/platform";

/**
 * One-shot effect that bootstraps the command library at app start:
 *
 *   1. Hydrate the Zustand store from the Rust-backed SQLite database.
 *      On first launch this returns an empty array; on subsequent
 *      launches it returns whatever the user has saved.
 *   2. If (and only if) the hydrated set is empty, resolve the host
 *      platform via the Rust `get_platform` IPC and write the demo
 *      seed entries into the store + database. Seeds are therefore
 *      created exactly once per machine — subsequent restarts skip
 *      this branch and just load the persisted rows.
 *
 * Safe to mount once at the App level. Both `hydrateFromDb` and
 * `initializeSeeds` are idempotent so a React Strict Mode double-
 * invocation is a no-op for the second pass.
 */
export function useSeedBootstrap(): void {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Kick off shell detection in parallel with DB hydration. Result
      // is cached inside `loadAvailableShells`; no await chain needed
      // here because the CommandForm reads the cache directly when it
      // opens. If detection is still in-flight by then, the form falls
      // back to a platform default — see `getCachedAvailableShells`.
      void loadAvailableShells();

      // Hydrate workflows in parallel with commands — the two stores are
      // independent and the workflow library has no seed step, so a
      // fire-and-forget hydrate is enough. Errors are swallowed inside
      // `hydrateFromDb` (it still flips `hydrated`), so no await chain is
      // needed here.
      void useWorkflowStore.getState().hydrateFromDb();

      // Hydrate schedules in parallel too — independent store, no seed step,
      // errors swallowed inside `hydrateFromDb`.
      void useScheduleStore.getState().hydrateFromDb();

      await useCommandStore.getState().hydrateFromDb();
      if (cancelled) return;

      if (useCommandStore.getState().commands.length > 0) return;

      const platform = await getPlatform();
      if (cancelled) return;
      const resolved: Platform = platform === "unknown" ? "linux" : platform;
      useCommandStore.getState().initializeSeeds(resolved);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}
