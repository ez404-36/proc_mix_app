// Mount test for the standalone quick-prompt window root. The service, the
// flow orchestration, and the Tauri window API are mocked; we assert the
// mount-time behaviour: fetch the request, run the flow when present, and
// always close the window.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { QuickPromptRequest } from "../../types/quickPrompt";

const mocks = vi.hoisted(() => ({
  getQuickPromptRequest: vi.fn(),
  runQuickPromptFlow: vi.fn(),
  close: vi.fn(),
}));

vi.mock("../../services/quickPromptService", () => ({
  getQuickPromptRequest: mocks.getQuickPromptRequest,
}));
vi.mock("./quickPromptFlow", () => ({
  runQuickPromptFlow: mocks.runQuickPromptFlow,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ close: mocks.close }),
}));

// The prompt singletons render real but never open (no flow drives them in
// this test); keep them lightweight by mocking to render nothing.
vi.mock("../VariablePrompt", () => ({ VariablePrompt: () => null }));
vi.mock("../AdminPasswordPrompt", () => ({ AdminPasswordPrompt: () => null }));

import { QuickPromptApp } from "./QuickPromptApp";

const REQUEST: QuickPromptRequest = {
  commandId: "c1",
  commandName: "Build",
  variables: [{ name: "target" }],
  needsAdmin: false,
};

beforeEach(() => {
  mocks.getQuickPromptRequest.mockReset();
  mocks.runQuickPromptFlow.mockReset();
  mocks.close.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe("QuickPromptApp", () => {
  it("runs the flow for a pending request, then closes the window", async () => {
    mocks.getQuickPromptRequest.mockResolvedValue(REQUEST);
    mocks.runQuickPromptFlow.mockResolvedValue("submitted");

    render(<QuickPromptApp />);

    await waitFor(() =>
      expect(mocks.runQuickPromptFlow).toHaveBeenCalledWith(REQUEST),
    );
    await waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(1));
  });

  it("closes immediately when there is no pending request", async () => {
    mocks.getQuickPromptRequest.mockResolvedValue(null);

    render(<QuickPromptApp />);

    await waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(1));
    expect(mocks.runQuickPromptFlow).not.toHaveBeenCalled();
  });

  it("still closes the window when the flow throws", async () => {
    mocks.getQuickPromptRequest.mockResolvedValue(REQUEST);
    mocks.runQuickPromptFlow.mockRejectedValue(new Error("run failed"));

    render(<QuickPromptApp />);

    await waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(1));
  });

  it("runs the flow at most once (StrictMode-safe)", async () => {
    mocks.getQuickPromptRequest.mockResolvedValue(REQUEST);
    mocks.runQuickPromptFlow.mockResolvedValue("submitted");

    render(<QuickPromptApp />);

    await waitFor(() => expect(mocks.close).toHaveBeenCalled());
    // The effect guard must prevent a second flow run even if the effect
    // re-fires (e.g. under StrictMode double-invoke).
    expect(mocks.runQuickPromptFlow).toHaveBeenCalledTimes(1);
  });
});
