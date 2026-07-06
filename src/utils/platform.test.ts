import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import type { PlatformOrUnknown } from "../types/platform";
import {
  __resetPlatformCacheForTests,
  getCachedPlatform,
  getPlatform,
} from "./platform";

beforeEach(() => {
  invokeMock.mockReset();
  __resetPlatformCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getPlatform", () => {
  it("caches a recognized platform returned by the IPC call", async () => {
    invokeMock.mockResolvedValue("macos");

    const result = await getPlatform();

    expect(invokeMock).toHaveBeenCalledWith("get_platform", undefined);
    expect(result).toBe<PlatformOrUnknown>("macos");
  });

  it('maps an unrecognized raw value to "unknown"', async () => {
    invokeMock.mockResolvedValue("solaris");

    const result = await getPlatform();

    expect(result).toBe<PlatformOrUnknown>("unknown");
  });

  it('falls back to "linux" and warns when the IPC call rejects', async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = new Error("no tauri");
    invokeMock.mockRejectedValue(error);

    const result = await getPlatform();

    expect(result).toBe<PlatformOrUnknown>("linux");
    expect(warn).toHaveBeenCalledWith(
      "Failed to fetch platform from Rust; defaulting to linux",
      error,
    );
  });

  it("reuses the cached value on a second call without re-invoking", async () => {
    invokeMock.mockResolvedValue("windows");

    const first = await getPlatform();
    const second = await getPlatform();

    expect(first).toBe("windows");
    expect(second).toBe("windows");
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

describe("getCachedPlatform", () => {
  it("returns null before the first resolve and the value after", async () => {
    invokeMock.mockResolvedValue("linux");

    expect(getCachedPlatform()).toBeNull();

    await getPlatform();

    expect(getCachedPlatform()).toBe<PlatformOrUnknown>("linux");
  });
});
