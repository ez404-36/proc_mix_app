import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AssistantObjectContext } from "../../types/assistant";
import {
  generateAssistantResponse,
} from "../../services/assistantService";
import type { ExecutionRunAssistant } from "../../utils/executionRunAssistant";
import "../../i18n";
import { RunAssistantPanel } from "./RunAssistantPanel";

const getAssistantSettings = vi.fn();
const setAssistantSettings = vi.fn();
const generateAssistantResponseMock = vi.mocked(generateAssistantResponse);

vi.mock("../../services/assistantService", () => ({
  getAssistantSettings: (...args: unknown[]) =>
    getAssistantSettings(...args),
  setAssistantSettings: (...args: unknown[]) =>
    setAssistantSettings(...args),
  cancelAssistantGeneration: vi.fn(async () => undefined),
  generateAssistantResponse: vi.fn(),
}));

const context: AssistantObjectContext<Record<string, unknown>> = {
  target: "command",
  schemaVersion: 1,
  draftVersion: 1,
  draft: { target: "command" },
};

const assistant: ExecutionRunAssistant = {
  runId: "run-1",
  subjectKey: "command:cmd-1",
  target: "command",
  objectId: "cmd-1",
  draftVersion: 1,
  context,
  snapshot: null,
};

describe("RunAssistantPanel consent", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("asks for access immediately after opening and can allow one subject", async () => {
    getAssistantSettings.mockResolvedValue({ allowRunSnapshots: false });
    render(<RunAssistantPanel assistant={assistant} title="Disk usage"
      sessionKey="test:assistant-2"
    />);

    fireEvent.click(
      screen.getByRole("button", { name: "Open run assistant" }),
    );
    expect(await screen.findByText("Allow reading this run?")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Allow this command" }),
    );

    await waitFor(() => {
      expect(
        screen.getByLabelText("Run assistant request"),
      ).toBeTruthy();
    });
    expect(screen.queryByText("Allow reading this run?")).toBeNull();
  });

  it("explains metadata-only access after denial", async () => {
    getAssistantSettings.mockResolvedValue({ allowRunSnapshots: false });
    render(<RunAssistantPanel assistant={assistant} title="Disk usage"
      sessionKey="test:assistant-3"
    />);

    fireEvent.click(
      screen.getByRole("button", { name: "Open run assistant" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));

    expect(
      await screen.findByText(
        "Without permission, the assistant can see only metadata for this run; its output and result are unavailable.",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText("Run assistant request")).toBeTruthy();
  });

  it("saves the global all-runs permission", async () => {
    getAssistantSettings
      .mockResolvedValueOnce({ allowRunSnapshots: false })
      .mockResolvedValueOnce({ allowRunSnapshots: false });
    setAssistantSettings.mockResolvedValue(undefined);
    render(<RunAssistantPanel assistant={assistant} title="Disk usage"
      sessionKey="test:assistant-1"
    />);

    fireEvent.click(
      screen.getByRole("button", { name: "Open run assistant" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Allow all runs" }),
    );

    await waitFor(() => {
      expect(setAssistantSettings).toHaveBeenCalledWith(
        expect.objectContaining({ allowRunSnapshots: true }),
      );
    });
  });

  it("restores a chat for the same run and clears it from the header", async () => {
    const sessionKey = "test:persistent-run";
    getAssistantSettings.mockResolvedValue({ allowRunSnapshots: true });
    generateAssistantResponseMock.mockResolvedValue({
      messageId: "assistant-1",
      text: "A response",
      warnings: [],
    });

    const first = render(
      <RunAssistantPanel
        assistant={assistant}
        title="Disk usage"
        sessionKey={sessionKey}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open run assistant" }),
    );
    fireEvent.change(await screen.findByLabelText("Run assistant request"), {
      target: { value: "Why did this fail?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("A response")).toBeTruthy();
    first.unmount();

    render(
      <RunAssistantPanel
        assistant={assistant}
        title="Disk usage"
        sessionKey={sessionKey}
      />,
    );
    expect(await screen.findByText("A response")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Clear chat history" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => {
      expect(screen.queryByText("A response")).toBeNull();
    });
    expect(
      (screen.getByLabelText("Run assistant request") as HTMLTextAreaElement)
        .value,
    ).toBe("");
  });
});
