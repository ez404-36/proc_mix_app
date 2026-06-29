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
// A backend-initiated run (scheduler) inserts a `workflowRun(running)` row via
// the bridge's lazy bootstrap; capture that too so the IPC isn't hit for real.
const recordEventMock = vi.fn();
vi.mock("../utils/historyRepository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/historyRepository")>();
  return {
    // Keep the real `executionLogToHistoryOutput` (a pure mapper) so the bridge
    // can build the captured-output payload; only the IPC writers are stubbed.
    executionLogToHistoryOutput: actual.executionLogToHistoryOutput,
    updateRunHistoryEventInDb: (...args: unknown[]) => updateRunMock(...args),
    recordHistoryEventInDb: (...args: unknown[]) => recordEventMock(...args),
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import {
  __resetBranchSlotCacheForTests,
  useWorkflowBridge,
} from "./useWorkflowBridge";
import { useExecutionStore } from "../stores/executionStore";
import { useWorkflowRunStore } from "../stores/workflowRunStore";
import { useWorkflowStore } from "../stores/workflowStore";
import type { Workflow } from "../types";

type Handler = (e: WorkflowEvent) => void;

function resetRuns(): void {
  useWorkflowRunStore.setState({ runs: {}, recentRunIds: [] });
  // The bridge reads the aggregate workflow execution from the execution store
  // to capture output; reset it so each test starts with no captured output.
  useExecutionStore.setState({
    executions: {},
    recentIds: [],
    activeExecutionId: null,
    panelOpen: false,
  });
  // Branch-slot labelling reads the persisted graph from the workflow store.
  useWorkflowStore.setState({ workflows: [] });
  // The branch-slot map is memoised per run id at module scope; clear it so a
  // reused run id never carries a stale (empty) map between cases.
  __resetBranchSlotCacheForTests();
}

/** Only the log lines the bridge actually wrote to the aggregate, as
 *  `[stream, line]` pairs, so assertions ignore timestamps. */
function aggregateLog(runId: string): Array<[string, string]> {
  const exec = useExecutionStore.getState().executions[runId];
  return (exec?.log ?? []).map((l) => [l.stream, l.line]);
}

beforeEach(() => {
  subscribeMock.mockReset();
  updateRunMock.mockReset();
  updateRunMock.mockResolvedValue(undefined);
  recordEventMock.mockReset();
  recordEventMock.mockResolvedValue(undefined);
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
      // timedOut is always undefined for a workflow run; no aggregate output
      // was captured in this test (no execution started), so output is too.
      undefined,
      undefined,
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
      undefined,
      undefined,
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
      undefined,
      undefined,
    );
  });
});

describe("useWorkflowBridge - per-node grouped console output", () => {
  /** Drive the bridge through a node lifecycle: start (maps execId→node),
   *  buffer N stdout lines, then finish. Mirrors the real event order. */
  function runNode(
    handler: Handler,
    runId: string,
    workflowId: string,
    nodeId: string,
    executionId: string,
    lines: string[],
    exitCode: number | null = 0,
  ): void {
    handler({ kind: "nodeStarted", runId, workflowId, nodeId, executionId });
    for (const line of lines) {
      useWorkflowRunStore
        .getState()
        .bufferNodeLine(runId, executionId, {
          stream: "stdout",
          line,
          ts: Date.now(),
        });
    }
    handler({ kind: "nodeFinished", runId, workflowId, nodeId, exitCode });
  }

  it("groups two nodes' interleaved stdout contiguously per node on finish", () => {
    const { handler } = mountBridge();
    useExecutionStore.getState().startWorkflowExecution("run-1", "Flow");
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");

    // Both nodes start; their stdout arrives ALTERNATELY (interleaved).
    handler({
      kind: "nodeStarted",
      runId: "run-1",
      workflowId: "wf-1",
      nodeId: "A",
      executionId: "ea",
    });
    handler({
      kind: "nodeStarted",
      runId: "run-1",
      workflowId: "wf-1",
      nodeId: "B",
      executionId: "eb",
    });
    const buf = useWorkflowRunStore.getState();
    buf.bufferNodeLine("run-1", "ea", { stream: "stdout", line: "a1", ts: 1 });
    buf.bufferNodeLine("run-1", "eb", { stream: "stdout", line: "b1", ts: 2 });
    buf.bufferNodeLine("run-1", "ea", { stream: "stdout", line: "a2", ts: 3 });
    buf.bufferNodeLine("run-1", "eb", { stream: "stdout", line: "b2", ts: 4 });

    // No output is on the aggregate yet — it is buffered, not interleaved.
    expect(aggregateLog("run-1")).toEqual([]);

    // A finishes first: its header + both A lines + exit land contiguously.
    handler({
      kind: "nodeFinished",
      runId: "run-1",
      workflowId: "wf-1",
      nodeId: "A",
      exitCode: 0,
    });
    // Then B finishes.
    handler({
      kind: "nodeFinished",
      runId: "run-1",
      workflowId: "wf-1",
      nodeId: "B",
      exitCode: 0,
    });

    expect(aggregateLog("run-1")).toEqual([
      ["meta", "▸ A"],
      ["stdout", "a1"],
      ["stdout", "a2"],
      ["meta", "  exit 0"],
      ["meta", "▸ B"],
      ["stdout", "b1"],
      ["stdout", "b2"],
      ["meta", "  exit 0"],
    ]);
  });

  it("prefixes a parallel branch node's header with (branch N)", () => {
    const { handler } = mountBridge();
    // Persist a fork → two branch commands graph so branch slots resolve.
    const workflow: Workflow = {
      id: "wf-1",
      name: "Fork",
      tags: [],
      favorite: false,
      createdAt: "",
      updatedAt: "",
      runCount: 0,
      nodes: [
        { id: "fork", kind: "parallel", position: { x: 0, y: 0 } },
        { id: "A", kind: "command", position: { x: 1, y: 0 } },
        { id: "B", kind: "command", position: { x: 1, y: 1 } },
      ],
      edges: [
        { id: "e0", source: "fork", target: "A", branch: "branch:0" },
        { id: "e1", source: "fork", target: "B", branch: "branch:1" },
      ],
    };
    useWorkflowStore.setState({ workflows: [workflow] });
    useExecutionStore.getState().startWorkflowExecution("run-1", "Fork");
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");

    runNode(handler, "run-1", "wf-1", "A", "ea", ["a-out"]);
    runNode(handler, "run-1", "wf-1", "B", "eb", ["b-out"]);

    expect(aggregateLog("run-1")).toEqual([
      ["meta", "▸ (branch 1) A"],
      ["stdout", "a-out"],
      ["meta", "  exit 0"],
      ["meta", "▸ (branch 2) B"],
      ["stdout", "b-out"],
      ["meta", "  exit 0"],
    ]);
  });

  it("flushes buffered output of a node that never finished, at run end", () => {
    const { handler } = mountBridge();
    useExecutionStore.getState().startWorkflowExecution("run-1", "Flow");
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");

    // Node A starts and streams, but the run errors before A finishes.
    handler({
      kind: "nodeStarted",
      runId: "run-1",
      workflowId: "wf-1",
      nodeId: "A",
      executionId: "ea",
    });
    useWorkflowRunStore
      .getState()
      .bufferNodeLine("run-1", "ea", { stream: "stdout", line: "partial", ts: 1 });

    handler({
      kind: "workflowError",
      runId: "run-1",
      workflowId: "wf-1",
      message: "boom",
    });

    // A's partial output is flushed (header + line) rather than dropped; no
    // exit trailer since A never produced an exit code.
    expect(aggregateLog("run-1")).toEqual([
      ["meta", "▸ A"],
      ["stdout", "partial"],
    ]);
    // The buffer is cleared after the run-end sweep.
    expect(
      useWorkflowRunStore.getState().runs["run-1"].lineBuffers["A"],
    ).toBeUndefined();
  });

  it("a sequential single-node run still produces header → output → exit in order", () => {
    const { handler } = mountBridge();
    useExecutionStore.getState().startWorkflowExecution("run-1", "Flow");
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");

    runNode(handler, "run-1", "wf-1", "only", "e-only", ["hello", "world"]);

    expect(aggregateLog("run-1")).toEqual([
      ["meta", "▸ only"],
      ["stdout", "hello"],
      ["stdout", "world"],
      ["meta", "  exit 0"],
    ]);
  });

  it("emits a header even for a silent node (no output) so the step still appears", () => {
    const { handler } = mountBridge();
    useExecutionStore.getState().startWorkflowExecution("run-1", "Flow");
    useWorkflowRunStore.getState().startRun("run-1", "wf-1");

    handler({
      kind: "nodeStarted",
      runId: "run-1",
      workflowId: "wf-1",
      nodeId: "quiet",
      executionId: "eq",
    });
    handler({
      kind: "nodeFinished",
      runId: "run-1",
      workflowId: "wf-1",
      nodeId: "quiet",
      exitCode: 0,
    });

    expect(aggregateLog("run-1")).toEqual([
      ["meta", "▸ quiet"],
      ["meta", "  exit 0"],
    ]);
  });
});

describe("useWorkflowBridge - backend-initiated run (scheduler Run now)", () => {
  it("bootstraps the aggregate execution, opens the panel, and streams output for a run that was never pre-registered", () => {
    const { handler } = mountBridge();
    // The saved workflow exists in the store (a schedule can only target a
    // saved workflow), so the name + node→command map resolve.
    const wf = {
      id: "wf-9",
      name: "Nightly job",
      nodes: [],
      edges: [],
    } as unknown as Workflow;
    useWorkflowStore.setState({ workflows: [wf] });

    // NO startRun / startWorkflowExecution here — this mimics a run fired by the
    // Rust scheduler, where the frontend never pre-registered anything.
    handler({
      kind: "nodeStarted",
      runId: "run-sched",
      workflowId: "wf-9",
      nodeId: "n1",
      executionId: "exec-1",
    });

    // The aggregate execution now exists, the panel is open, and it is the
    // active marker carrying the workflow's name.
    const exec = useExecutionStore.getState();
    expect(exec.executions["run-sched"]).toBeDefined();
    expect(exec.executions["run-sched"]?.commandName).toBe("Nightly job");
    expect(exec.executions["run-sched"]?.isWorkflow).toBe(true);
    expect(exec.panelOpen).toBe(true);
    expect(exec.activeExecutionId).toBe("run-sched");
    // The run-store entry was created so node progress is recorded.
    expect(
      useWorkflowRunStore.getState().runs["run-sched"]?.nodes["n1"]?.status,
    ).toBe("running");
    // NO `workflowRun` history row is inserted — the Rust `scheduledRun` event
    // is the canonical record for a schedule fire; a frontend row here would
    // duplicate it.
    expect(recordEventMock).not.toHaveBeenCalled();

    // Subsequent output now lands on the real aggregate execution.
    handler({
      kind: "nodeFinished",
      runId: "run-sched",
      workflowId: "wf-9",
      nodeId: "n1",
      exitCode: 0,
    });
    expect(aggregateLog("run-sched")).toEqual([
      ["meta", "▸ n1"],
      ["meta", "  exit 0"],
    ]);
  });

  it("is idempotent: a pre-registered frontend run is not re-bootstrapped", () => {
    const { handler } = mountBridge();
    useExecutionStore
      .getState()
      .startWorkflowExecution("run-fe", "Original title", "wf-1");
    useWorkflowRunStore.getState().startRun("run-fe", "wf-1");

    handler({
      kind: "nodeStarted",
      runId: "run-fe",
      workflowId: "wf-1",
      nodeId: "n1",
      executionId: "exec-1",
    });

    // The pre-registered title is kept; no extra history row is inserted.
    expect(useExecutionStore.getState().executions["run-fe"]?.commandName).toBe(
      "Original title",
    );
    expect(recordEventMock).not.toHaveBeenCalled();
  });
});
