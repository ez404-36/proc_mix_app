import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AssistantObjectContext } from "../types/assistant";
import { ASSISTANT_PATCH_RETRY_MARKER } from "../utils/assistantPatchFeedback";
import { useAssistantStore } from "./assistantStore";

vi.mock("../services/assistantService", () => ({
  generateAssistantResponse: vi.fn(),
  cancelAssistantGeneration: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

const generateAssistantResponse = vi.mocked(
  (await import("../services/assistantService")).generateAssistantResponse,
);
const cancelAssistantGeneration = vi.mocked(
  (await import("../services/assistantService")).cancelAssistantGeneration,
);

const context: AssistantObjectContext<unknown> = {
  target: "command",
  schemaVersion: 1,
  draftVersion: 1,
  draft: { target: "command", name: "Test" },
};

describe("assistantStore", () => {
  beforeEach(() => {
    generateAssistantResponse.mockReset();
    cancelAssistantGeneration.mockReset();
    useAssistantStore.setState({ session: null });
  });

  it("keeps messages when only the draft version changes", () => {
    const store = useAssistantStore.getState();
    store.startSession("command", "command-1", 1);
    useAssistantStore.setState((state) => ({
      session: state.session
        ? {
            ...state.session,
            messages: [
              {
                id: "message-1",
                role: "user",
                text: "Hello",
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          }
        : null,
    }));

    useAssistantStore.getState().startSession("command", "command-1", 2);
    expect(useAssistantStore.getState().session?.messages).toHaveLength(1);
    expect(useAssistantStore.getState().session?.draftVersion).toBe(2);
  });

  it("resets the session when the object changes", () => {
    useAssistantStore.getState().startSession("command", "command-1", 1);
    useAssistantStore.getState().startSession("workflow", "workflow-1", 1);
    expect(useAssistantStore.getState().session?.messages).toEqual([]);
  });

  it("adds user and assistant messages and records backend errors", async () => {
    useAssistantStore.getState().startSession("command", "command-1", 1);
    generateAssistantResponse.mockRejectedValueOnce("ASSISTANT_DISABLED");
    await useAssistantStore.getState().sendMessage(context, "Help");

    const session = useAssistantStore.getState().session;
    expect(session?.messages.map((message) => message.role)).toEqual(["user"]);
    expect(session?.error).toBe("disabled");
  });

  it("preserves provider HTTP status for user-facing errors", async () => {
    useAssistantStore.getState().startSession("command", "command-1", 1);
    generateAssistantResponse.mockRejectedValueOnce("ASSISTANT_PROVIDER_HTTP_400");
    await useAssistantStore.getState().sendMessage(context, "Help");

    expect(useAssistantStore.getState().session?.error).toEqual({
      kind: "providerHttp",
      status: 400,
    });
  });

  it("preserves the contract issue for a structurally valid but invalid response", async () => {
    useAssistantStore.getState().startSession("command", "command-1", 1);
    generateAssistantResponse.mockResolvedValueOnce({
      messageId: "assistant-1",
      text: "Attempted an unsupported change",
      action: {
        kind: "proposePatch",
        patch: {
          summary: "Change identity",
          operations: [{ op: "replace", path: "id", value: "new-id" }],
        },
      },
      warnings: [],
    });
    await useAssistantStore.getState().sendMessage(context, "Help");

    expect(useAssistantStore.getState().session?.error).toEqual({
      kind: "contract",
      issue: "path",
    });
  });

  it("maps the service boundary guard to the invalid response error", async () => {
    useAssistantStore.getState().startSession("command", "command-1", 1);
    generateAssistantResponse.mockRejectedValueOnce(
      new Error("Invalid assistant response returned by backend"),
    );
    await useAssistantStore.getState().sendMessage(context, "Help");

    expect(useAssistantStore.getState().session?.error).toBe(
      "invalidAssistantResponse",
    );
  });

  it("maps backend contract failures to the specific contract issue", async () => {
    useAssistantStore.getState().startSession("command", "command-1", 1);
    generateAssistantResponse.mockRejectedValueOnce(
      "ASSISTANT_INVALID_RESPONSE: Path",
    );
    await useAssistantStore.getState().sendMessage(context, "Help");

    expect(useAssistantStore.getState().session?.error).toEqual({
      kind: "contract",
      issue: "path",
    });
  });

  it("marks auto-generated retry requests for collapsed rendering", async () => {
    useAssistantStore.getState().startSession("command", "command-1", 1);
    generateAssistantResponse.mockResolvedValueOnce({
      messageId: "assistant-1",
      text: "ok",
      warnings: [],
    });
    await useAssistantStore
      .getState()
      .sendMessage(context, `${ASSISTANT_PATCH_RETRY_MARKER}\nAPPLY_ERROR: path`);

    const messages = useAssistantStore.getState().session?.messages ?? [];
    expect(messages[0]).toMatchObject({ role: "user", kind: "patchRetry" });
  });

  it("cancels the active backend request and clears generating state", async () => {
    useAssistantStore.setState({
      session: {
        target: "command",
        objectId: "command-1",
        draftVersion: 1,
        messages: [],
        runSnapshot: null,
        attachedRunSnapshotId: undefined,
        isGenerating: true,
        streamingText: null,
        error: null,
      },
    });

    await useAssistantStore.getState().cancelSession();

    expect(cancelAssistantGeneration).toHaveBeenCalledTimes(1);
    expect(useAssistantStore.getState().session?.isGenerating).toBe(false);
    expect(useAssistantStore.getState().session?.error).toBeNull();
  });
});
