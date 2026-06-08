import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { WorkflowEvent } from "../types";

// Capture the handler passed to subscribeWorkflowEvents so we can fire
// events synchronously from tests.
const subscribeMock = vi.fn();
vi.mock("../utils/workflowRunner", () => ({
  subscribeWorkflowEvents: (...args: unknown[]) => subscribeMock(...args),
}));

// The bridge finalizes the history row on terminal events; capture the call.
const updateRunMock = vi.fn();
vi.mock("../utils/historyRepository", () => ({
  updateRunHistoryEventInDb: (...args: unknown[]) => updateRunMock(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { useWorkflowBridge } from "./useWorkflowBridge";
import { useWorkflowRunStore } from "../stores/workflowRunStore";

type Handler = (e: WorkflowEvent) => void;

function resetRuns(): void {
  useWorkflowRunStore.setState({ runs: {}, recentRunIds: [] });
}

beforeEach(() => {
  subscribeMock.mockReset();
  updateRunMock.mockReset();
  updateRunMock.mockResolvedValue(undefined);
  resetRuns();
});

function mountBridge(): { handler: Handler } {
  const captured: { handler: Handler | null } = { handler: null };
  subscribeMock.mockImplementation((h: Handler) => {
    captured.handler = h;
    return () => {};
  });
  renderHook(() => useWorkflowBridge());
  if (!captured.handler) throw new Error("handler not captured");
  return { handler: captured.handler };
}

describe("useWorkflowBridge - subscription lifecycle", () => {
  it("subscribes exactly once on mount", () => {
    subscribeMock.mockReturnValue(() => {});
    renderHook(() => useWorkflowBridge());
    expect(subscribeMock).toHaveBeenCalledTimes(1);
  });

  it("invokes the unsubscribe function on unmount", () => {
    const unsub = vi.fn();
    subscribeMock.mockReturnValue(unsub);
    const { unmount } = renderHook(() => useWorkflowBridge());
    unmount();
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});

describe("useWorkflowBridge - node progress", () => {
  it("marks a node running on nodeStarted with its executionId", () => {
    const { handler } = mountBridge();
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    handler({
      kind: "nodeStarted",
      runId: "run-1",
      workflowId: "wf-1",
      nodeId: "n1",
      executionId: "exec-1",
    });
    const node = useWorkflowRunStore.getState().runs["run-1"]?.nodes["n1"];
    expect(node?.status).toBe("running");
    expect(node?.executionId).toBe("exec-1");
  });

  it("captures exit code on nodeFinished", () => {
    const { handler } = mountBridge();
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    handler({
      kind: "nodeFinished",
      runId: "run-1",
      workflowId: "wf-1",
      nodeId: "n1",
      exitCode: 3,
    });
    const node = useWorkflowRunStore.getState().runs["run-1"]?.nodes["n1"];
    expect(node?.status).toBe("finished");
    expect(node?.exitCode).toBe(3);
  });

  it("records the branch and edge on branchTaken", () => {
    const { handler } = mountBridge();
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    handler({
      kind: "branchTaken",
      runId: "run-1",
      workflowId: "wf-1",
      nodeId: "cond",
      branch: "else",
      edgeId: "e9",
    });
    const run = useWorkflowRunStore.getState().runs["run-1"];
    expect(run?.branches["cond"]).toBe("else");
    expect(run?.takenEdgeIds).toContain("e9");
  });
});

describe("useWorkflowBridge - terminal events", () => {
  it("workflowFinished sets success and finalizes history as succeeded", () => {
    const { handler } = mountBridge();
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    handler({
      kind: "workflowFinished",
      runId: "run-1",
      workflowId: "wf-1",
      durationMs: 42,
    });
    const run = useWorkflowRunStore.getState().runs["run-1"];
    expect(run?.status).toBe("success");
    expect(run?.durationMs).toBe(42);
    expect(updateRunMock).toHaveBeenCalledWith(
      "run-1",
      undefined,
      42,
      "succeeded",
    );
  });

  it("workflowCancelled sets cancelled and finalizes history as cancelled", () => {
    const { handler } = mountBridge();
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    handler({ kind: "workflowCancelled", runId: "run-1", workflowId: "wf-1" });
    expect(useWorkflowRunStore.getState().runs["run-1"]?.status).toBe(
      "cancelled",
    );
    expect(updateRunMock).toHaveBeenCalledWith(
      "run-1",
      undefined,
      undefined,
      "cancelled",
    );
  });

  it("workflowError sets error with message and finalizes history as failed", () => {
    const { handler } = mountBridge();
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");
    handler({
      kind: "workflowError",
      runId: "run-1",
      workflowId: "wf-1",
      message: "boom",
    });
    const run = useWorkflowRunStore.getState().runs["run-1"];
    expect(run?.status).toBe("error");
    expect(run?.error).toBe("boom");
    expect(updateRunMock).toHaveBeenCalledWith(
      "run-1",
      undefined,
      undefined,
      "failed",
    );
  });
});
