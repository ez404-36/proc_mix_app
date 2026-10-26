import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AssistantObjectContext,
  AssistantRunSnapshot,
} from "../../types/assistant";
import { ASSISTANT_PATCH_RETRY_MARKER } from "../../utils/assistantPatchFeedback";
import { ContextMenuProvider } from "../ContextMenu";
import { AssistantPanel } from "./AssistantPanel";
import { useAssistantStore } from "../../stores/assistantStore";

vi.mock("../../services/assistantService", () => ({
  generateAssistantResponse: vi.fn(async () => ({
    messageId: "assistant-1",
    text: "A response",
    warnings: [],
  })),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

const context: AssistantObjectContext<unknown> = {
  target: "command",
  schemaVersion: 1,
  draftVersion: 1,
  draft: { target: "command", name: "Test" },
};

const generateAssistantResponse = vi.mocked(
  (await import("../../services/assistantService")).generateAssistantResponse,
);

let writeTextMock: ReturnType<typeof vi.fn>;

describe("AssistantPanel", () => {
  beforeEach(() => {
    window.getSelection()?.removeAllRanges();
    writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: writeTextMock },
    });
    useAssistantStore.setState({ session: null, archivedMessages: {} });
  });

  it("starts an object-scoped session and sends a user message", async () => {
    render(
      <ContextMenuProvider>
        <AssistantPanel
        target="command"
        objectId="command-1"
        draftVersion={1}
        context={context}
        title="Command Assistant"
          defaultExpanded
        onClose={() => {}}
        />
      </ContextMenuProvider>,
    );

    expect(
      screen.getByRole("region", { name: "Command Assistant" }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("assistant.composerLabel"), {
      target: { value: "Add status" },
    });
    fireEvent.click(screen.getByRole("button", { name: "assistant.send" }));

    expect(await screen.findByText("A response")).toBeTruthy();
    expect(useAssistantStore.getState().session?.target).toBe("command");
    expect(useAssistantStore.getState().session?.objectId).toBe("command-1");
  });

  it("restores an object chat until it is explicitly cleared", async () => {
    const first = render(
      <ContextMenuProvider>
        <AssistantPanel
          target="command"
          objectId="restore-1"
          draftVersion={1}
          context={context}
          title="Restore Assistant"
          sessionKey="test:restore-1"
          defaultExpanded
        />
      </ContextMenuProvider>,
    );

    fireEvent.change(screen.getByLabelText("assistant.composerLabel"), {
      target: { value: "Remember this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "assistant.send" }));
    expect(await screen.findByText("A response")).toBeTruthy();
    first.unmount();

    render(
      <ContextMenuProvider>
        <AssistantPanel
          target="command"
          objectId="restore-1"
          draftVersion={2}
          context={context}
          title="Restore Assistant"
          sessionKey="test:restore-1"
          defaultExpanded
        />
      </ContextMenuProvider>,
    );

    expect(screen.getByText("Remember this")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "assistant.clearChat" }),
    );
    fireEvent.click(
      document.querySelector(
        ".command-form__actions .btn--danger",
      ) as HTMLButtonElement,
    );

    await waitFor(() => {
      expect(screen.queryByText("Remember this")).toBeNull();
    });
    expect(screen.queryByText("A response")).toBeNull();
  });

  it("retries the last failed prompt from the error row", async () => {
    generateAssistantResponse.mockResolvedValueOnce({
      messageId: "assistant-1",
      text: "Recovered",
      warnings: [],
    });
    useAssistantStore.setState({
      session: {
        sessionKey: "command:command-1",
        target: "command",
        objectId: "command-1",
        draftVersion: 1,
        isGenerating: false,
        streamingText: null,
        error: "timeout",
        runSnapshot: null,
        attachedRunSnapshotId: undefined,
        messages: [
          {
            id: "user-1",
            role: "user",
            text: "Add status",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    });

    render(
      <ContextMenuProvider>
        <AssistantPanel
          target="command"
          objectId="command-1"
          draftVersion={1}
          context={context}
          title="Command Assistant"
          defaultExpanded
          onClose={() => {}}
        />
      </ContextMenuProvider>,
    );

    generateAssistantResponse.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));

    expect(await screen.findByText("Recovered")).toBeTruthy();
    expect(generateAssistantResponse).toHaveBeenCalledTimes(1);
    expect(useAssistantStore.getState().session?.messages).toHaveLength(2);
    expect(useAssistantStore.getState().session?.error).toBeNull();
  });

  it("starts collapsed, expands on click, and collapses on close", () => {
    render(
      <ContextMenuProvider>
        <AssistantPanel
          target="command"
          objectId="command-1"
          draftVersion={1}
          context={context}
          title="Command Assistant"
          sessionKey="test:collapsed"
        />
      </ContextMenuProvider>,
    );

    expect(screen.getByText("AI")).toBeTruthy();
    expect(
      document.querySelector(".assistant-panel__toggle-icon"),
    ).toBeTruthy();
    expect(screen.queryByLabelText("assistant.composerLabel")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "nav.expand" }));
    expect(screen.getByLabelText("assistant.composerLabel")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "nav.collapse" }));
    expect(screen.getByText("AI")).toBeTruthy();
  });

  it("copies selected and full chat text from the context menu", () => {
    useAssistantStore.setState({
      session: {
        sessionKey: "command:command-1",
        target: "command",
        objectId: "command-1",
        draftVersion: 1,
        isGenerating: false,
        streamingText: null,
        error: null,
        runSnapshot: null,
        attachedRunSnapshotId: undefined,
        messages: [
          {
            id: "user-1",
            role: "user",
            text: "First question",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "assistant-1",
            role: "assistant",
            text: "First answer",
            createdAt: "2026-01-01T00:00:01.000Z",
          },
        ],
      },
    });

    render(
      <ContextMenuProvider>
        <AssistantPanel
          target="command"
          objectId="command-1"
          draftVersion={1}
          context={context}
          title="Command Assistant"
          defaultExpanded
          onClose={() => {}}
        />
      </ContextMenuProvider>,
    );

    const messages = document.querySelector(".assistant-panel__messages");
    if (!(messages instanceof HTMLElement)) {
      throw new Error("messages container is missing");
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(messages);
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.contextMenu(messages);
    fireEvent.click(screen.getByRole("menuitem", { name: "contextMenu.copy" }));
    expect(writeTextMock).toHaveBeenLastCalledWith(
      expect.stringContaining("First question"),
    );

    fireEvent.contextMenu(messages);
    fireEvent.click(
      screen.getByRole("menuitem", { name: "assistant.copyAll" }),
    );
    expect(writeTextMock).toHaveBeenLastCalledWith(
      "First question\n\nFirst answer",
    );
  });

  it("renders patch paths without applying anything", async () => {
    useAssistantStore.setState({
      session: {
        sessionKey: "command:command-1",
        target: "command",
        objectId: "command-1",
        draftVersion: 1,
        isGenerating: false,
        streamingText: null,
        error: null,
        runSnapshot: null,
        attachedRunSnapshotId: undefined,
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            text: "Proposed",
            createdAt: "2026-01-01T00:00:00.000Z",
            action: {
              kind: "proposePatch",
              patch: {
                summary: "Change script",
                operations: [{ op: "replace", path: "script", value: "echo" }],
              },
            },
          },
        ],
      },
    });

    render(
      <ContextMenuProvider>
        <AssistantPanel
        target="command"
        objectId="command-1"
        draftVersion={1}
        context={context}
        title="Command Assistant"
          defaultExpanded
        onClose={() => {}}
        />
      </ContextMenuProvider>,
    );

    expect(screen.getByText("script")).toBeTruthy();
    const applyButton = screen.getByRole("button", { name: "assistant.apply" });
    expect(applyButton).toHaveProperty("disabled", true);
  });

  it("collapses patch retry messages behind a chevroned error row", () => {
    useAssistantStore.setState({
      session: {
        sessionKey: "command:command-1",
        target: "command",
        objectId: "command-1",
        draftVersion: 1,
        isGenerating: false,
        streamingText: null,
        error: null,
        runSnapshot: null,
        attachedRunSnapshotId: undefined,
        messages: [
          {
            id: "retry-1",
            role: "user",
            text: `${ASSISTANT_PATCH_RETRY_MARKER}\nAPPLY_ERROR: unsupportedPath\nFAILED_PATCH_JSON: {}`,
            createdAt: "2026-01-01T00:00:00.000Z",
            kind: "patchRetry",
          },
        ],
      },
    });

    render(
      <ContextMenuProvider>
        <AssistantPanel
          target="command"
          objectId="command-1"
          draftVersion={1}
          context={context}
          title="Command Assistant"
          defaultExpanded
        />
      </ContextMenuProvider>,
    );

    const toggle = document.querySelector(
      ".assistant-panel__retry-toggle",
    );
    if (!(toggle instanceof HTMLButtonElement)) {
      throw new Error("retry toggle is missing");
    }
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/APPLY_ERROR/)).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/APPLY_ERROR/)).toBeTruthy();

    fireEvent.click(toggle);
    expect(screen.queryByText(/APPLY_ERROR/)).toBeNull();
  });

  it("carries the specific apply error into the retry request", async () => {
    useAssistantStore.setState({
      session: {
        sessionKey: "command:command-1",
        target: "command",
        objectId: "command-1",
        draftVersion: 1,
        isGenerating: false,
        streamingText: null,
        error: null,
        runSnapshot: null,
        attachedRunSnapshotId: undefined,
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            text: "Proposed",
            createdAt: "2026-01-01T00:00:00.000Z",
            action: {
              kind: "proposePatch",
              patch: {
                summary: "Patch args",
                operations: [{ op: "replace", path: "args", value: ["${port}"] }],
              },
            },
          },
        ],
      },
    });

    render(
      <ContextMenuProvider>
        <AssistantPanel
          target="command"
          objectId="command-1"
          draftVersion={1}
          context={context}
          title="Command Assistant"
          defaultExpanded
          onApplyPatch={() => ({ ok: false, error: "unsupportedPath" })}
        />
      </ContextMenuProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "assistant.apply" }));

    await waitFor(() => {
      expect(useAssistantStore.getState().session?.messages).toHaveLength(3);
    });
    const messages = useAssistantStore.getState().session?.messages ?? [];
    expect(messages[1]).toMatchObject({
      role: "user",
      kind: "patchRetry",
    });
    expect(messages[1]?.text).toContain("APPLY_ERROR: unsupportedPath");
    expect(messages[1]?.text).toContain("no separate `args` field");
  });

  it("sends apply failures back to the assistant for a corrected patch", async () => {
    generateAssistantResponse.mockResolvedValueOnce({
      messageId: "assistant-2",
      text: "Corrected",
      warnings: [],
    });
    useAssistantStore.setState({
      session: {
        sessionKey: "command:command-1",
        target: "command",
        objectId: "command-1",
        draftVersion: 1,
        isGenerating: false,
        streamingText: null,
        error: null,
        runSnapshot: null,
        attachedRunSnapshotId: undefined,
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            text: "Proposed",
            createdAt: "2026-01-01T00:00:00.000Z",
            action: {
              kind: "proposePatch",
              patch: {
                summary: "Change schema",
                operations: [
                  { op: "replace", path: "outputSchema.pipeline", value: [] },
                ],
              },
            },
          },
        ],
      },
    });
    const onApplyPatch = vi.fn(() => ({
      ok: false,
      error: "unsupportedPath" as const,
    }));

    render(
      <ContextMenuProvider>
        <AssistantPanel
        target="command"
        objectId="command-1"
        draftVersion={1}
        context={context}
        title="Command Assistant"
        onApplyPatch={onApplyPatch}
          defaultExpanded
        onClose={() => {}}
        />
      </ContextMenuProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "assistant.apply" }));

    expect(onApplyPatch).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Corrected")).toBeTruthy();
    const retryCall =
      generateAssistantResponse.mock.calls[
        generateAssistantResponse.mock.calls.length - 1
      ];
    const [request, retryContext] = retryCall;
    expect(request?.userMessage).toContain("APPLY_ERROR: unsupportedPath");
    expect(request?.userMessage).toContain("outputSchema.pipeline");
    expect(retryContext).toBe(context);
  });

  it("sends a prepared run prompt and attaches its snapshot immediately", async () => {
    const runSnapshot: AssistantRunSnapshot = {
      id: "run-1",
      target: "command",
      draftVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      exitCode: 0,
      timedOut: false,
      stdoutTail: "ready",
      stderrTail: "",
    };
    useAssistantStore.setState({
      session: {
        sessionKey: "command:command-1",
        target: "command",
        objectId: "command-1",
        draftVersion: 1,
        messages: [],
        runSnapshot,
        attachedRunSnapshotId: undefined,
        isGenerating: false,
        streamingText: null,
        error: null,
      },
    });

    render(
      <ContextMenuProvider>
        <AssistantPanel
          target="command"
          objectId="command-1"
          draftVersion={1}
          context={context}
          title="Command Assistant"
          runSnapshot={runSnapshot}
          defaultExpanded
        />
      </ContextMenuProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "assistant.run.send" }));

    expect(await screen.findByText("A response")).toBeTruthy();
    const runCall =
      generateAssistantResponse.mock.calls[
        generateAssistantResponse.mock.calls.length - 1
      ];
    const [request, , sentSnapshot] = runCall;
    expect(request?.attachedRunSnapshotId).toBe("run-1");
    expect(request?.userMessage).toContain("assistant.run.prompt");
    expect(request?.userMessage).toContain("ready");
    expect(sentSnapshot).toBe(runSnapshot);
    expect(useAssistantStore.getState().session?.messages[0]).toMatchObject({
      role: "user",
    });
    expect(useAssistantStore.getState().session?.messages[0]?.text).toContain(
      "ready",
    );
  });
});
