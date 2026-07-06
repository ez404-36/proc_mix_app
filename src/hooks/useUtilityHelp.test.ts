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
  useUtilitiesHelp,
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

describe("useUtilitiesHelp", () => {
  it("returns an empty map and issues no IPC for an empty name list", () => {
    const { result } = renderHook(() => useUtilitiesHelp([]));

    expect(result.current.size).toBe(0);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("resolves each de-duplicated name after the debounce window", async () => {
    invokeMock.mockImplementation((_cmd: string, args: { utility: string }) =>
      Promise.resolve(found(args.utility)),
    );

    const { result } = renderHook(() =>
      useUtilitiesHelp(["ls", "grep", "ls"]),
    );

    // Nothing resolved before the debounce, but nothing fetched either.
    expect(result.current.size).toBe(0);

    await flushDebounce();

    expect(result.current.get("ls")).toEqual(found("ls"));
    expect(result.current.get("grep")).toEqual(found("grep"));
    // `ls | ls` de-duplicates to a single lookup.
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("seeds already-cached names synchronously and only fetches the missing", async () => {
    invokeMock.mockImplementation((_cmd: string, args: { utility: string }) =>
      Promise.resolve(found(args.utility)),
    );

    // Prime the cache with `ls` via the single-name hook.
    const primed = renderHook(() => useUtilityHelp("ls"));
    await flushDebounce();
    expect(primed.result.current.state).toEqual(found("ls"));
    invokeMock.mockClear();

    // `ls` is served from the cache on the first render; only `grep` fetches.
    const { result } = renderHook(() => useUtilitiesHelp(["ls", "grep"]));
    expect(result.current.get("ls")).toEqual(found("ls"));

    await flushDebounce();

    expect(result.current.get("grep")).toEqual(found("grep"));
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("fetch_utility_help", {
      utility: "grep",
    });
  });

  it("does not fetch again when every name is already cached", async () => {
    invokeMock.mockImplementation((_cmd: string, args: { utility: string }) =>
      Promise.resolve(found(args.utility)),
    );

    const first = renderHook(() => useUtilitiesHelp(["ls", "grep"]));
    await flushDebounce();
    expect(first.result.current.size).toBe(2);
    invokeMock.mockClear();

    const second = renderHook(() => useUtilitiesHelp(["ls", "grep"]));
    // Fully cache-served on the first render, no debounce fetch scheduled.
    expect(second.result.current.size).toBe(2);
    await flushDebounce();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("degrades a rejected fetch to a not-found result in the map", async () => {
    invokeMock.mockRejectedValue("internal backend error");

    const { result } = renderHook(() => useUtilitiesHelp(["boom"]));

    await flushDebounce();

    expect(result.current.get("boom")).toEqual({
      utility: "boom",
      status: "not-found",
      source: null,
      text: null,
      truncated: false,
    });
  });

  it("resets to an empty map when the name list becomes empty", async () => {
    invokeMock.mockImplementation((_cmd: string, args: { utility: string }) =>
      Promise.resolve(found(args.utility)),
    );

    const { result, rerender } = renderHook(
      ({ names }: { names: string[] }) => useUtilitiesHelp(names),
      { initialProps: { names: ["ls"] } },
    );
    await flushDebounce();
    expect(result.current.size).toBe(1);

    rerender({ names: [] });

    expect(result.current.size).toBe(0);
  });

  it("ignores a stale batch resolution after the name set changed", async () => {
    let resolveSlow: (v: UtilityHelp) => void = () => {};
    invokeMock.mockImplementation((_cmd: string, args: { utility: string }) => {
      if (args.utility === "slow") {
        return new Promise<UtilityHelp>((res) => {
          resolveSlow = res;
        });
      }
      return Promise.resolve(found(args.utility));
    });

    const { result, rerender } = renderHook(
      ({ names }: { names: string[] }) => useUtilitiesHelp(names),
      { initialProps: { names: ["slow"] } },
    );
    await flushDebounce();
    expect(result.current.has("slow")).toBe(false);

    // Switch the batch before the slow lookup resolves.
    rerender({ names: ["fast"] });
    await flushDebounce();
    expect(result.current.get("fast")).toEqual(found("fast"));

    // The stale "slow" resolution must not land in the current map.
    await act(async () => {
      resolveSlow(found("slow"));
      await Promise.resolve();
    });
    expect(result.current.has("slow")).toBe(false);
  });
});
