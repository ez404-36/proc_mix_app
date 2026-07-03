import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  getShellIntegrationStatus,
  setShellIntegration,
} from "./shellIntegrationService";
import type { ShellIntegrationStatus } from "../types/shellIntegration";

beforeEach(() => {
  invokeMock.mockReset();
});

describe("shellIntegrationService command wrappers", () => {
  it("getShellIntegrationStatus invokes shell_integration_status", async () => {
    const status: ShellIntegrationStatus = { supported: true, enabled: false };
    invokeMock.mockResolvedValue(status);
    expect(await getShellIntegrationStatus()).toEqual(status);
    expect(invokeMock).toHaveBeenCalledWith("shell_integration_status");
  });

  it("setShellIntegration passes the enabled flag", async () => {
    invokeMock.mockResolvedValue(undefined);
    await setShellIntegration(true);
    expect(invokeMock).toHaveBeenCalledWith("set_shell_integration", {
      enabled: true,
    });
  });

  it("setShellIntegration propagates an unsupported-platform error", async () => {
    invokeMock.mockRejectedValue(
      new Error("SHELL_INTEGRATION_UNSUPPORTED: macOS"),
    );
    await expect(setShellIntegration(true)).rejects.toThrow(
      "SHELL_INTEGRATION_UNSUPPORTED",
    );
  });
});
