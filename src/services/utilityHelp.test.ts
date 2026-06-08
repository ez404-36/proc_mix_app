import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri IPC before importing the module under test so its
// import-time `invoke` binding sees the mock. The invoke call shape is
// the boundary we verify here; the actual Rust handler behaviour is
// covered by Rust tests in `core::utility_help`.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import type { UtilityHelp } from "../types";
import { fetchUtilityHelp } from "./utilityHelp";

beforeEach(() => {
  invokeMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const FOUND: UtilityHelp = {
  utility: "df",
  status: "found",
  source: "help",
  text: "Usage: df [OPTION]...",
  truncated: false,
};

const NOT_FOUND: UtilityHelp = {
  utility: "nope",
  status: "not-found",
  source: null,
  text: null,
  truncated: false,
};

describe("fetchUtilityHelp", () => {
  it("invokes fetch_utility_help with the utility under the `utility` key", async () => {
    invokeMock.mockResolvedValueOnce(FOUND);
    await fetchUtilityHelp("df");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("fetch_utility_help", {
      utility: "df",
    });
  });

  it("returns the found result unchanged", async () => {
    invokeMock.mockResolvedValueOnce(FOUND);
    const result = await fetchUtilityHelp("df");
    expect(result).toEqual(FOUND);
  });

  it("passes through a not-found result (null source/text)", async () => {
    invokeMock.mockResolvedValueOnce(NOT_FOUND);
    const result = await fetchUtilityHelp("nope");
    expect(result.status).toBe("not-found");
    expect(result.source).toBeNull();
    expect(result.text).toBeNull();
  });

  it("propagates a rejection from invoke (internal backend error)", async () => {
    invokeMock.mockRejectedValueOnce("internal failure");
    await expect(fetchUtilityHelp("df")).rejects.toBe("internal failure");
  });
});
