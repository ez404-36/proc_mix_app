import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ExecutionEvent } from "../types";

// Capture the handler passed to subscribeExecutionEvents so we can fire
// events synchronously from tests.
const subscribeMock = vi.fn();
vi.mock("../utils/executor", () => ({
  subscribeExecutionEvents: (...args: unknown[]) => subscribeMock(...args),
}));

const updateRunMock = vi.fn();
vi.mock("../utils/historyRepository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/historyRepository")>();
  return {
    executionLogToHistoryOutput: actual.executionLogToHistoryOutput,
    updateRunHistoryEventInDb: (...args: unknown[]) => updateRunMock(...args),
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { useExecutionBridge } from "./useExecutionBridge";
import { useCommandStore } from "../stores/commandStore";
import { useExecutionStore } from "../stores/executionStore";
import { useTerminalStore } from "../stores/terminalStore";
import { makeMiniAppExecutionId } from "../utils/miniappExecutionId";

type Handler = (e: ExecutionEvent) => void;

beforeEach(() => {
  subscribeMock.mockReset();
  updateRunMock.mockReset();
  updateRunMock.mockResolvedValue(undefined);
  useExecutionStore.setState({
    executions: {},
    recentIds: [],
    activeExecutionId: null,
    panelOpen: false,
  });
  useCommandStore.setState({ commands: [] });
  useTerminalStore.setState({ panelMode: "terminal" });
});

function mountBridge(currentWindowMiniAppId?: string | null): {
  handler: Handler;
} {
  const captured: { handler: Handler | null } = { handler: null };
  subscribeMock.mockImplementation((h: Handler) => {
    captured.handler = h;
    return () => {};
  });
  renderHook(() => useExecutionBridge(currentWindowMiniAppId));
  if (!captured.handler) throw new Error("handler not captured");
  return { handler: captured.handler };
}

describe("useExecutionBridge - backend-initiated run console tab", () => {
  it("switches the console back to the Runs tab on a `started` event, even if Terminal was active", () => {
    const { handler } = mountBridge();
    expect(useTerminalStore.getState().panelMode).toBe("terminal");

    // Mimics a run fired outside the frontend (scheduler, HTTP API): the
    // execution was never pre-registered by `triggerCommandRun` first.
    handler({
      kind: "started",
      executionId: "exec-sched-1",
      commandId: "cmd-1",
    });

    expect(useExecutionStore.getState().executions["exec-sched-1"]).toBeDefined();
    expect(useExecutionStore.getState().panelOpen).toBe(true);
    expect(useTerminalStore.getState().panelMode).toBe("runs");
  });

  it("forwards the started event's pid into the execution store", () => {
    const { handler } = mountBridge();

    handler({
      kind: "started",
      executionId: "exec-pid-1",
      commandId: "cmd-1",
      pid: 4242,
    });

    expect(useExecutionStore.getState().executions["exec-pid-1"].pid).toBe(
      4242,
    );
  });

  it("leaves pid undefined when the started event carries none", () => {
    const { handler } = mountBridge();

    handler({
      kind: "started",
      executionId: "exec-no-pid",
      commandId: "cmd-1",
    });

    expect(
      useExecutionStore.getState().executions["exec-no-pid"].pid,
    ).toBeUndefined();
  });
});

describe("useExecutionBridge - mini-app window isolation", () => {
  it("drops a mini-app-tagged event when this window shows a DIFFERENT mini-app", () => {
    const { handler } = mountBridge("ma-1");
    const taggedId = makeMiniAppExecutionId("ma-2");

    handler({ kind: "started", executionId: taggedId, commandId: "cmd-1" });

    expect(useExecutionStore.getState().executions[taggedId]).toBeUndefined();
  });

  it("accepts a mini-app-tagged event when this window shows the SAME mini-app", () => {
    const { handler } = mountBridge("ma-1");
    const taggedId = makeMiniAppExecutionId("ma-1");

    handler({ kind: "started", executionId: taggedId, commandId: "cmd-1" });

    expect(useExecutionStore.getState().executions[taggedId]).toBeDefined();
  });

  it("the main window (no id) drops EVERY mini-app-tagged event", () => {
    const { handler } = mountBridge();
    const taggedId = makeMiniAppExecutionId("ma-1");

    handler({ kind: "started", executionId: taggedId, commandId: "cmd-1" });

    expect(useExecutionStore.getState().executions[taggedId]).toBeUndefined();
  });

  it("an UNTAGGED event still reaches every window regardless of currentWindowMiniAppId", () => {
    const { handler } = mountBridge("ma-1");

    handler({
      kind: "started",
      executionId: "plain-exec-1",
      commandId: "cmd-1",
    });

    expect(
      useExecutionStore.getState().executions["plain-exec-1"],
    ).toBeDefined();
  });
});
