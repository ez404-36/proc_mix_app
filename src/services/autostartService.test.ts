import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { getAutostartStatus, setAutostart } from "./autostartService";
import type { AutostartStatus } from "../types/autostart";

beforeEach(() => {
  invokeMock.mockReset();
});

describe("autostartService command wrappers", () => {
  it("getAutostartStatus invokes autostart_status", async () => {
    const status: AutostartStatus = { enabled: true, startMinimized: false };
    invokeMock.mockResolvedValue(status);
    expect(await getAutostartStatus()).toEqual(status);
    expect(invokeMock).toHaveBeenCalledWith("autostart_status");
  });

  it("setAutostart passes enabled and startMinimized", async () => {
    invokeMock.mockResolvedValue(undefined);
    await setAutostart(true, true);
    expect(invokeMock).toHaveBeenCalledWith("set_autostart", {
      enabled: true,
      startMinimized: true,
    });
  });

  it("setAutostart propagates a backend error", async () => {
    invokeMock.mockRejectedValue(new Error("AUTOSTART_ERROR: denied"));
    await expect(setAutostart(true, false)).rejects.toThrow(
      "AUTOSTART_ERROR: denied",
    );
  });
});
