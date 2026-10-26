import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getAssistantSettings,
  listAssistantProviderPresets,
  listAssistantProviders,
  setAssistantSettings,
} from "../../services/assistantService";
import type { AssistantSettings } from "../../types/assistant";
import "../../i18n";
import { AssistantSection } from "./AssistantSection";

// Arco's Message uses ReactDOM.render, which is unavailable in React 19 jsdom.
vi.mock("@arco-design/web-react", () => ({
  Message: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const getAssistantSettingsMock = vi.mocked(getAssistantSettings);
const listAssistantProvidersMock = vi.mocked(listAssistantProviders);
const listAssistantProviderPresetsMock = vi.mocked(
  listAssistantProviderPresets,
);
const setAssistantSettingsMock = vi.mocked(setAssistantSettings);

vi.mock("../../services/assistantService", () => ({
  deleteAssistantProvider: vi.fn(),
  getAssistantSettings: vi.fn(),
  listAssistantProviderModels: vi.fn(),
  listAssistantProviderPresets: vi.fn(),
  listAssistantProviders: vi.fn(),
  saveAssistantProvider: vi.fn(),
  setAssistantActiveModel: vi.fn(),
  setAssistantActiveProvider: vi.fn(),
  setAssistantProviderApiKey: vi.fn(),
  setAssistantProviderEnabled: vi.fn(),
  setAssistantProviderModelHidden: vi.fn(),
  setAssistantSettings: vi.fn(),
  testAssistantProvider: vi.fn(),
}));

const settings: AssistantSettings = {
  enabled: true,
  timeoutMs: 60_000,
  activeProviderId: null,
  activeModelId: null,
  allowRunSnapshots: false,
  allowRemoteEndpoints: false,
};

describe("AssistantSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAssistantSettingsMock.mockResolvedValue(settings);
    listAssistantProvidersMock.mockResolvedValue([]);
    listAssistantProviderPresetsMock.mockResolvedValue([]);
    setAssistantSettingsMock.mockResolvedValue(undefined);
  });

  it("saves the global run-snapshot permission", async () => {
    render(<AssistantSection />);

    fireEvent.click(
      await screen.findByRole("switch", { name: "Allow run snapshots" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(setAssistantSettingsMock).toHaveBeenCalledWith({
        ...settings,
        allowRunSnapshots: true,
      });
    });
  });
});
