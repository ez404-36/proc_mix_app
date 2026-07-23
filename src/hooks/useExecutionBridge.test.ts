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

function mountBridge(): { handler: Handler } {
  const captured: { handler: Handler | null } = { handler: null };
  subscribeMock.mockImplementation((h: Handler) => {
    captured.handler = h;
    return () => {};
  });
  renderHook(() => useExecutionBridge());
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
});
