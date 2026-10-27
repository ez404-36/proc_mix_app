import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  generateAssistantResponse,
  getAssistantSettings,
  listAssistantProviderModels,
  saveAssistantProvider,
} from "./assistantService";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

describe("assistantService", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("validates settings at the IPC boundary", async () => {
    const settings = {
      enabled: true,
      timeoutMs: 60_000,
      activeProviderId: "provider-1",
      activeModelId: "model-1",
      allowRunSnapshots: false,
      allowRemoteEndpoints: false,
    };
    invokeMock.mockResolvedValueOnce(settings);
    await expect(getAssistantSettings()).resolves.toEqual(settings);

    invokeMock.mockResolvedValueOnce({ ...settings, enabled: "yes" });
    await expect(getAssistantSettings()).rejects.toThrow(
      "Invalid assistant settings returned by backend",
    );
  });

  it("uses snake_case command names and validates providers/models", async () => {
    const provider = {
      id: "provider-1",
      name: "OpenRouter",
      kind: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      enabled: true,
      hasApiKey: true,
      createdAt: "",
      updatedAt: "",
    };
    invokeMock.mockResolvedValueOnce(provider);
    await expect(
      saveAssistantProvider(
        { name: provider.name, kind: "openrouter", baseUrl: provider.baseUrl, enabled: true },
        provider.id,
      ),
    ).resolves.toEqual(provider);
    expect(invokeMock).toHaveBeenLastCalledWith("save_assistant_provider", {
      provider: expect.any(Object),
      providerId: provider.id,
    });

    const model = {
      providerId: provider.id,
      modelId: "model-1",
      name: "Model 1",
      verified: true,
      hidden: false,
      updatedAt: "",
    };
    invokeMock.mockResolvedValueOnce([model]);
    await expect(listAssistantProviderModels(provider.id)).resolves.toEqual([model]);

    invokeMock.mockResolvedValueOnce([{ ...model, verified: "yes" }]);
    await expect(listAssistantProviderModels(provider.id)).rejects.toThrow(
      "Invalid assistant model returned by backend",
    );
  });

  it("validates generation responses at the IPC boundary", async () => {
    const context = {
      target: "command",
      schemaVersion: 1,
      draftVersion: 1,
      draft: { target: "command", name: "Test" },
    } as const;
    const response = { messageId: "message-1", text: "ok", warnings: [] };
    invokeMock.mockResolvedValueOnce(response);
    await expect(
      generateAssistantResponse(
        {
          target: "command",
          objectId: "command-1",
          draftVersion: 1,
          userMessage: "Explain this command.",
        },
        context,
      ),
    ).resolves.toEqual(response);

    invokeMock.mockResolvedValueOnce({ messageId: "", text: "ok", warnings: [] });
    await expect(
      generateAssistantResponse(
        {
          target: "command",
          objectId: null,
          draftVersion: 1,
          userMessage: "Explain this command.",
        },
        context,
      ),
    ).rejects.toThrow("Invalid assistant response returned by backend");
  });
});
