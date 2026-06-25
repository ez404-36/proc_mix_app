import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the IPC before importing the hook (which imports the service that
// binds `invoke` at module load).
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import type { UtilityHelp } from "../types";
import {
  __clearUtilityHelpCacheForTests,
  useUtilityHelp,
} from "./useUtilityHelp";

function found(utility: string): UtilityHelp {
  return {
    utility,
    status: "found",
    source: "help",
    text: `Usage: ${utility} ...`,
    truncated: false,
  };
}

/**
 * Advance past the debounce window and flush the pending microtasks so
 * the fetch promise settles and the resolver's setState runs. We use
 * fake timers for the debounce, so `waitFor` (which polls on real
 * timers) would deadlock — instead we explicitly tick + drain.
 */
async function flushDebounce(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(300);
    // Let the awaited fetch promise (and the setState after it) resolve.
    await vi.runAllTimersAsync();
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  __clearUtilityHelpCacheForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  // Drop any timers still queued by the debounce/fetch so switching back to
  // real timers cannot stall: under parallel load a leftover pending timer
  // made `vi.useRealTimers()` hang and trip the 30s hook timeout.
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useUtilityHelp", () => {
  it("stays idle and issues no IPC for a null name", () => {
    const { result } = renderHook(() => useUtilityHelp(null));
    expect(result.current.state).toBe("idle");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("goes loading then resolves after the debounce window", async () => {
    invokeMock.mockResolvedValue(found("df"));
    const { result } = renderHook(() => useUtilityHelp("df"));

    // Before the debounce elapses we are loading and nothing was sent.
    expect(result.current.state).toBe("loading");
    expect(invokeMock).not.toHaveBeenCalled();

    await flushDebounce();

    expect(result.current.state).toEqual(found("df"));
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("fetch_utility_help", {
      utility: "df",
    });
  });

  it("coalesces rapid name changes into a single fetch for the final name", async () => {
    invokeMock.mockImplementation((_cmd: string, args: { utility: string }) =>
      Promise.resolve(found(args.utility)),
    );

    const { result, rerender } = renderHook(
      ({ name }: { name: string }) => useUtilityHelp(name),
      { initialProps: { name: "d" } },
    );

    // Type d -> do -> docker before the debounce fires.
    rerender({ name: "do" });
    rerender({ name: "docker" });

    await flushDebounce();

    expect(result.current.state).toEqual(found("docker"));
    // Only the final name was ever fetched.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("fetch_utility_help", {
      utility: "docker",
    });
  });

  it("serves a cached result synchronously without a second IPC", async () => {
    invokeMock.mockResolvedValue(found("git"));

    // First mount resolves and populates the cache.
    const first = renderHook(() => useUtilityHelp("git"));
    await flushDebounce();
    expect(first.result.current.state).toEqual(found("git"));
    expect(invokeMock).toHaveBeenCalledTimes(1);

    // Second mount for the same name hits the cache on the first render —
    // no loading flash, no extra invoke.
    const second = renderHook(() => useUtilityHelp("git"));
    expect(second.result.current.state).toEqual(found("git"));
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale resolution when the name changed mid-flight", async () => {
    // The "slow" lookup is left pending; "fast" resolves immediately.
    let resolveSlow: (v: UtilityHelp) => void = () => {};
    invokeMock.mockImplementation((_cmd: string, args: { utility: string }) => {
      if (args.utility === "slow") {
        return new Promise<UtilityHelp>((res) => {
          resolveSlow = res;
        });
      }
      return Promise.resolve(found("fast"));
    });

    const { result, rerender } = renderHook(
      ({ name }: { name: string }) => useUtilityHelp(name),
      { initialProps: { name: "slow" } },
    );

    // Fire the debounce for "slow" (its promise stays pending).
    await flushDebounce();
    expect(result.current.state).toBe("loading");

    // Switch to "fast" and let it resolve.
    rerender({ name: "fast" });
    await flushDebounce();
    expect(result.current.state).toEqual(found("fast"));

    // Now the stale "slow" promise resolves — it must NOT overwrite state.
    await act(async () => {
      resolveSlow(found("slow"));
      await Promise.resolve();
    });
    expect(result.current.state).toEqual(found("fast"));
  });

  it("degrades a rejected fetch to a not-found result", async () => {
    invokeMock.mockRejectedValue("internal backend error");
    const { result } = renderHook(() => useUtilityHelp("boom"));

    await flushDebounce();

    expect(result.current.state).toEqual({
      utility: "boom",
      status: "not-found",
      source: null,
      text: null,
      truncated: false,
    });
  });
});
