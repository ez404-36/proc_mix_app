import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import type { Shell } from "../types";
import {
  __resetAvailableShellsCacheForTests,
  getCachedAvailableShells,
  loadAvailableShells,
} from "./shells";

beforeEach(() => {
  invokeMock.mockReset();
  __resetAvailableShellsCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadAvailableShells", () => {
  it("passes through known shells in detection order", async () => {
    const detected: string[] = ["zsh", "bash", "fish"];
    invokeMock.mockResolvedValue(detected);

    const result = await loadAvailableShells();

    expect(invokeMock).toHaveBeenCalledWith("get_available_shells", undefined);
    expect(result).toEqual<ReadonlyArray<Shell>>(["zsh", "bash", "fish"]);
  });

  it("drops unknown shell identifiers and logs a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    invokeMock.mockResolvedValue(["bash", "elvish", "pwsh"]);

    const result = await loadAvailableShells();

    expect(result).toEqual<ReadonlyArray<Shell>>(["bash", "pwsh"]);
    expect(warn).toHaveBeenCalledWith(
      'get_available_shells returned unknown shell identifier "elvish"; ignoring',
    );
  });

  it("returns an empty list and warns when the IPC call rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = new Error("no tauri");
    invokeMock.mockRejectedValue(error);

    const result = await loadAvailableShells();

    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "Failed to load available shells from Rust; assuming none detected",
      error,
    );
  });

  it("reuses the cached result on a second call without re-invoking", async () => {
    invokeMock.mockResolvedValue(["bash"]);

    const first = await loadAvailableShells();
    const second = await loadAvailableShells();

    expect(first).toBe(second);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("reuses the in-flight promise for concurrent callers", async () => {
    let resolveInvoke: (value: string[]) => void = () => undefined;
    invokeMock.mockReturnValue(
      new Promise<string[]>((resolve) => {
        resolveInvoke = resolve;
      }),
    );

    const p1 = loadAvailableShells();
    const p2 = loadAvailableShells();

    resolveInvoke(["zsh"]);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toEqual<ReadonlyArray<Shell>>(["zsh"]);
    expect(r2).toBe(r1);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

describe("getCachedAvailableShells", () => {
  it("returns null before the first load resolves and the value after", async () => {
    invokeMock.mockResolvedValue(["bash"]);

    expect(getCachedAvailableShells()).toBeNull();

    await loadAvailableShells();

    expect(getCachedAvailableShells()).toEqual<ReadonlyArray<Shell>>(["bash"]);
  });
});
