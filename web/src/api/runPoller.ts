// Run poller (F6) — drives `GET /api/run/{executionId}` until terminal.
//
// When a run is fired, the UI knows only its executionId; the actual status +
// captured output live server-side. This module polls the run-status endpoint
// on a fixed interval and pushes each snapshot into the run store, so the
// console / run cards update in (near) real time. Per decision O2 (option B):
// a running poll reports `status: "running"` (output filled on terminal); the
// loop stops once the run reaches a terminal state.
//
// Polling state (the active timers) is kept module-local — NOT in the store —
// so it survives view switches and never triggers React re-renders. The store
// holds only the observable run snapshots.
//
// Three guardrails bound the loop so it never polls forever or wastes work:
//   1. Max-poll deadline — a run still `running` after MAX_POLL_DURATION_MS is
//      marked `stale` and the poll stops (the run may continue server-side;
//      History is the source of truth).
//   2. Visibility pause — while the tab is hidden, polls are suspended (the
//      timer keeps ticking but skips the fetch) and resume on refocus, so a
//      backgrounded tab doesn't hammer the API.
//   3. pagehide cleanup — every poll is cancelled when the page is being torn
//      down / bfcache-frozen, so no in-flight fetch fires during teardown.

import { ApiError, getRunStatus } from "../api/client";
import { useRunStore } from "../stores/runStore";
import type { RunStatus } from "../api/types";

/** Poll cadence — ~1s, matching the desktop console's perceived liveness. */
const POLL_INTERVAL_MS = 1000;

/**
 * How long to keep retrying a 404 before giving up. A just-fired run may not
 * have its history row yet (the backend records it as the run starts), so a
 * brief 404 window is expected; a persistent 404 means the run is gone.
 */
const NOT_FOUND_GRACE_MS = 10_000;

/**
 * Upper bound on how long a single run is actively polled. A run still
 * `running` past this is marked `stale` and the poll stops — the run may still
 * be going server-side, so the user is pointed at History for the outcome. Set
 * generously so a legitimately long run isn't abandoned prematurely.
 */
const MAX_POLL_DURATION_MS = 10 * 60_000; // 10 minutes

interface PollHandle {
  timer: ReturnType<typeof setTimeout>;
  /** Monotonic start time, used to enforce the max-poll deadline. */
  startedAt: number;
  /** First time we saw a 404 for this run, to enforce the grace window. */
  firstNotFoundAt?: number;
  cancelled: boolean;
}

const active = new Map<string, PollHandle>();

/**
 * Whether polling is currently suspended because the tab is hidden. When true,
 * a scheduled `tick` reschedules itself WITHOUT issuing a request; a
 * `visibilitychange` back to visible fires the pending ticks immediately.
 */
let paused = false;

/** Register the visibility + pagehide listeners exactly once (browser only). */
let lifecycleHooked = false;
function ensureLifecycleHooks(): void {
  if (lifecycleHooked) return;
  if (typeof document === "undefined" || typeof window === "undefined") return;
  lifecycleHooked = true;

  document.addEventListener("visibilitychange", () => {
    const nowHidden = document.visibilityState === "hidden";
    const wasPaused = paused;
    paused = nowHidden;
    // On resume, kick every active run so it polls immediately rather than
    // waiting out the remainder of its (paused) interval.
    if (wasPaused && !nowHidden) {
      for (const [id, handle] of active) {
        if (handle.cancelled) continue;
        clearTimeout(handle.timer);
        handle.timer = setTimeout(() => void tick(id), 0);
      }
    }
  });

  // `pagehide` covers both real unload and bfcache freeze; cancel all polls so
  // no timer/fetch lingers during teardown.
  window.addEventListener("pagehide", () => {
    stopAllPolling();
  });
}

function isTerminal(status: RunStatus | "pending"): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/**
 * Begin polling a run until it terminates. Idempotent: a second call for the
 * same executionId is a no-op while a poll is already active. Synthetic ids
 * (failed-to-start runs) are never polled.
 */
export function startPolling(executionId: string): void {
  if (executionId.startsWith("failed-")) return;
  if (active.has(executionId)) return;

  ensureLifecycleHooks();

  const handle: PollHandle = {
    timer: setTimeout(() => void tick(executionId), 0),
    startedAt: Date.now(),
    cancelled: false,
  };
  active.set(executionId, handle);
}

/** Stop polling a run (e.g. when the user clears it). Safe if not active. */
export function stopPolling(executionId: string): void {
  const handle = active.get(executionId);
  if (!handle) return;
  handle.cancelled = true;
  clearTimeout(handle.timer);
  active.delete(executionId);
}

/** Stop every active poll (e.g. on logout). */
export function stopAllPolling(): void {
  for (const [id, handle] of active) {
    handle.cancelled = true;
    clearTimeout(handle.timer);
    active.delete(id);
  }
}

function scheduleNext(executionId: string, delayMs: number): void {
  const handle = active.get(executionId);
  if (handle && !handle.cancelled) {
    handle.timer = setTimeout(() => void tick(executionId), delayMs);
  }
}

async function tick(executionId: string): Promise<void> {
  const handle = active.get(executionId);
  if (!handle || handle.cancelled) return;

  // Guardrail 2 — while the tab is hidden, don't fetch; just keep the timer
  // alive so the loop resumes (immediately) when the tab becomes visible.
  if (paused) {
    scheduleNext(executionId, POLL_INTERVAL_MS);
    return;
  }

  // Guardrail 1 — give up actively watching a run that has exceeded the max
  // poll duration. Mark it `stale` (not `failed`): it may still be running
  // server-side, and History holds the authoritative outcome.
  if (Date.now() - handle.startedAt > MAX_POLL_DURATION_MS) {
    const current = useRunStore
      .getState()
      .runs.find((r) => r.executionId === executionId);
    // Only mark stale if it never reached a terminal state.
    if (current && (current.status === "running" || current.status === "pending")) {
      useRunStore.getState().updateRun(executionId, { status: "stale" });
    }
    active.delete(executionId);
    return;
  }

  try {
    const run = await getRunStatus(executionId);
    if (handle.cancelled) return;

    // Only overwrite output/exitCode when the snapshot actually carries them
    // (terminal runs do; a running poll may omit output under O2 option B), so
    // a later empty poll can't wipe output we already showed.
    useRunStore.getState().updateRun(executionId, {
      status: run.status,
      ...(run.output !== undefined ? { output: run.output } : {}),
      ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
    });

    if (isTerminal(run.status)) {
      active.delete(executionId);
      return;
    }
    // Reset the 404 grace window once a real response arrives.
    handle.firstNotFoundAt = undefined;
  } catch (err) {
    if (handle.cancelled) return;

    if (err instanceof ApiError && err.code === "notFound") {
      // Tolerate a brief 404 window while the run's history row is created.
      const now = Date.now();
      handle.firstNotFoundAt ??= now;
      if (now - handle.firstNotFoundAt > NOT_FOUND_GRACE_MS) {
        // Give up: the run never materialised (or was removed).
        useRunStore.getState().updateRun(executionId, {
          status: "failed",
          error: "notFound",
        });
        active.delete(executionId);
        return;
      }
    } else {
      // Network / auth / unknown error — mark failed and stop. (A 401 also
      // clears the session via the client, sending the user to login.)
      useRunStore.getState().updateRun(executionId, {
        status: "failed",
        error: err instanceof ApiError ? err.code : "unknown",
      });
      active.delete(executionId);
      return;
    }
  }

  // Schedule the next poll if still active and not cancelled.
  scheduleNext(executionId, POLL_INTERVAL_MS);
}
