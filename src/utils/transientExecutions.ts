/**
 * Registry of execution ids that should be considered "transient" — owned by
 * a transient consumer (e.g. the CommandForm live-run feature) rather than
 * by the global execution store / OutputPanel.
 *
 * The Rust executor has no concept of transient runs: every run goes through
 * the same `execute_command` IPC and emits the same event stream. We tag the
 * `executionId` on the JS side BEFORE invoking the IPC so the bridge
 * (`useExecutionBridge`) can skip writing those events into the global
 * store. The execution-event fan-out in `subscribeExecutionEvents` still
 * delivers every event to every subscriber, so the transient consumer can
 * register its own handler and read events directly.
 *
 * Lifecycle:
 *   1. Caller generates an id (e.g. `crypto.randomUUID()`).
 *   2. Caller `markTransient(id)` BEFORE calling the IPC.
 *   3. Caller subscribes to execution events and filters by id.
 *   4. On the terminal event (`finished`, `error`, `cancelled`) the caller
 *      `unmarkTransient(id)` — without this the Set grows unboundedly.
 *   5. On caller unmount/teardown, the caller MUST unmark too, in case the
 *      run was still in flight (defensive against orphan entries).
 *
 * StrictMode safety: the registry is plain module-level state with no
 * listeners or async bootstrapping; double-mount cannot corrupt it.
 */

const transientIds = new Set<string>();

/** Mark an execution id as transient. Idempotent on repeated calls. */
export function markTransient(id: string): void {
  transientIds.add(id);
}

/** Remove the transient mark. Idempotent on unknown ids. */
export function unmarkTransient(id: string): void {
  transientIds.delete(id);
}

/** Whether the given id is currently flagged transient. */
export function isTransient(id: string): boolean {
  return transientIds.has(id);
}

/**
 * Test-only helper to clear the registry between cases. Not exported from
 * a barrel; tests must import explicitly.
 */
export function __resetTransientRegistryForTests(): void {
  transientIds.clear();
}
