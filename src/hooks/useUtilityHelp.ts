import { useEffect, useState } from "react";

import { fetchUtilityHelp } from "../services/utilityHelp";
import type { UtilityHelp } from "../types";

/**
 * Debounce window (ms) before a utility name change triggers an IPC
 * fetch. Typing `docker` letter-by-letter should coalesce into a single
 * lookup rather than firing one per keystroke.
 */
const DEBOUNCE_MS = 300;

/**
 * Module-level cache keyed by utility name. A name we have already
 * resolved (found OR not-found) returns synchronously on the next mount
 * / name change with no further IPC — the idea's "cache by utility
 * name" requirement. Both outcomes are cached because an absent utility
 * is just as stable as a present one within a session.
 *
 * Lives at module scope (not in the hook) so it is shared across every
 * CommandForm instance and survives unmount/remount of the form.
 */
const cache = new Map<string, UtilityHelp>();

/** Resolved state of a utility-help lookup. */
export type UtilityHelpState = "idle" | "loading" | UtilityHelp;

export interface UseUtilityHelpResult {
  /**
   * - `"idle"`    — no name to look up (`null` input).
   * - `"loading"` — a fetch is in flight (debounce elapsed, no cache hit).
   * - `UtilityHelp` — the resolved result (`status` found / not-found).
   */
  state: UtilityHelpState;
}

/**
 * Resolve CLI help for the given utility name, debounced and cached.
 *
 * Pass `null` when the script has no recognisable leading utility (the
 * caller derives the name via `parseUtilityName`); the hook then stays
 * `idle` and issues no IPC.
 *
 * Behaviour:
 *   - Cache hit → returns the cached result immediately, no IPC, no
 *     debounce.
 *   - Cache miss → `loading` after the debounce window, then the fetched
 *     result (also written to the cache).
 *   - A name change mid-flight discards the older request's result (a
 *     stale resolution can never overwrite the current name's state).
 *   - A rejected fetch (genuine backend error) is caught at this
 *     boundary and surfaced as a synthetic `not-found` result, so the UI
 *     degrades to "no hint" rather than throwing. It is NOT cached, so a
 *     transient failure can be retried by re-entering the name.
 */
export function useUtilityHelp(
  utilityName: string | null,
): UseUtilityHelpResult {
  const [state, setState] = useState<UtilityHelpState>(() =>
    initialStateFor(utilityName),
  );

  useEffect(() => {
    if (utilityName === null) {
      setState("idle");
      return;
    }

    const cached = cache.get(utilityName);
    if (cached !== undefined) {
      setState(cached);
      return;
    }

    setState("loading");

    // `stale` flips in cleanup (name change / unmount); the resolver
    // captures it via closure and refuses to apply a superseded result.
    let stale = false;
    const timer = window.setTimeout(() => {
      void resolve(utilityName, () => stale, setState);
    }, DEBOUNCE_MS);

    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [utilityName]);

  return { state };
}

/**
 * Synchronous initial state so the very first render already reflects a
 * cache hit (avoids a `loading` flash when re-opening a form for a
 * utility seen earlier this session).
 */
function initialStateFor(utilityName: string | null): UtilityHelpState {
  if (utilityName === null) return "idle";
  return cache.get(utilityName) ?? "loading";
}

/**
 * Perform the fetch and apply the result unless it has gone stale. Kept
 * out of the effect body so the stale check reads cleanly.
 */
async function resolve(
  utilityName: string,
  isStale: () => boolean,
  setState: (next: UtilityHelpState) => void,
): Promise<void> {
  let result: UtilityHelp;
  try {
    result = await fetchUtilityHelp(utilityName);
    // Cache only genuine results — not the synthetic error fallback —
    // so a transient backend failure can be retried.
    cache.set(utilityName, result);
  } catch {
    // A rejected promise means an internal backend error (absent /
    // unsafe utilities resolve to a not-found result, not a rejection).
    // Degrade to "no hint" rather than letting the error escape the
    // boundary.
    result = {
      utility: utilityName,
      status: "not-found",
      source: null,
      text: null,
      truncated: false,
    };
  }

  // Stale guard: a newer request (name change / unmount) supersedes us.
  if (isStale()) return;
  setState(result);
}

/**
 * Test-only: clear the module-level cache so cases don't leak across
 * each other. Not part of the production API surface.
 */
export function __clearUtilityHelpCacheForTests(): void {
  cache.clear();
}
