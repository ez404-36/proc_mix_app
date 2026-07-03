import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  getQuickPromptRequest,
  submitQuickPrompt,
  cancelQuickPrompt,
} from "./quickPromptService";
import type { QuickPromptRequest } from "../types/quickPrompt";

beforeEach(() => invokeMock.mockReset());

describe("quickPromptService", () => {
  it("getQuickPromptRequest invokes get_quick_prompt_request", async () => {
    const req: QuickPromptRequest = {
      commandId: "c1",
      commandName: "Build",
      variables: [],
      needsAdmin: false,
    };
    invokeMock.mockResolvedValue(req);
    expect(await getQuickPromptRequest()).toEqual(req);
    expect(invokeMock).toHaveBeenCalledWith("get_quick_prompt_request");
  });

  it("getQuickPromptRequest passes through null", async () => {
    invokeMock.mockResolvedValue(null);
    expect(await getQuickPromptRequest()).toBeNull();
  });

  it("submitQuickPrompt forwards values and a one-shot admin password", async () => {
    invokeMock.mockResolvedValue(undefined);
    await submitQuickPrompt({ target: "/x" }, "hunter2");
    expect(invokeMock).toHaveBeenCalledWith("submit_quick_prompt", {
      values: { target: "/x" },
      adminPassword: "hunter2",
    });
  });

  it("submitQuickPrompt sends null when no admin password", async () => {
    invokeMock.mockResolvedValue(undefined);
    await submitQuickPrompt({ target: "/x" });
    expect(invokeMock).toHaveBeenCalledWith("submit_quick_prompt", {
      values: { target: "/x" },
      adminPassword: null,
    });
  });

  it("cancelQuickPrompt invokes cancel_quick_prompt", async () => {
    invokeMock.mockResolvedValue(undefined);
    await cancelQuickPrompt();
    expect(invokeMock).toHaveBeenCalledWith("cancel_quick_prompt");
  });
});
