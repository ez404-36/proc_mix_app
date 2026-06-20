import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ExecutionEvent } from "../types";
import {
  __resetTransientRegistryForTests,
  markTransient,
} from "../utils/transientExecutions";

// Capture the handler passed to subscribeExecutionEvents so we can fire
// events synchronously from tests.
const subscribeMock = vi.fn();
vi.mock("../utils/executor", () => ({
  subscribeExecutionEvents: (...args: unknown[]) => subscribeMock(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { useExecutionBridge } from "./useExecutionBridge";
import { useExecutionStore } from "../stores/executionStore";
import { useCommandStore } from "../stores/commandStore";
import { useWorkflowRunStore } from "../stores/workflowRunStore";

type Handler = (e: ExecutionEvent) => void;

function resetExec() {
  useExecutionStore.setState({
    executions: {},
    recentIds: [],
    activeExecutionId: null,
    panelOpen: false,
  });
}

beforeEach(() => {
  subscribeMock.mockReset();
  resetExec();
  __resetTransientRegistryForTests();
});

/**
 * Mount the hook and return the handler that was registered as well as the
 * unmount helper.
 *
 * `subscribeExecutionEvents` is now synchronous — it adds the handler to a
 * shared Set immediately and returns the unsubscribe function. We mirror that
 * shape in the mock so the hook sees a real sync unsub.
 */
function mountBridge(): { handler: Handler; unlisten: () => void } {
  const captured: { handler: Handler | null } = { handler: null };
  subscribeMock.mockImplementation((h: Handler) => {
    captured.handler = h;
    return () => {};
  });

  const { unmount } = renderHook(() => useExecutionBridge());

  if (!captured.handler) throw new Error("handler not captured");
  return {
    handler: captured.handler,
    unlisten: () => {
      unmount();
    },
  };
}

describe("useExecutionBridge - subscription lifecycle", () => {
  it("should call subscribeExecutionEvents exactly once on mount", () => {
    subscribeMock.mockReturnValue(() => {});
    renderHook(() => useExecutionBridge());
    expect(subscribeMock).toHaveBeenCalledTimes(1);
  });

  it("should invoke the unsubscribe function on unmount", () => {
    const unsub = vi.fn();
    subscribeMock.mockReturnValue(unsub);
    const { unmount } = renderHook(() => useExecutionBridge());
    unmount();
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});

describe("useExecutionBridge - 'started' event", () => {
  it("should start a new execution and resolve commandName from the command store", async () => {
    // Seed a command so lookupCommandName finds a real name.
    useCommandStore.setState((s) => ({
      commands: [
        ...s.commands,
        {
          id: "cmd-bridge",
          name: "Bridge Cmd",
          script: "true",
          tags: [],
          favorite: false,
          createdAt: "",
          updatedAt: "",
          runCount: 0,
          runAsAdmin: false,
        },
      ],
    }));
    const { handler } = mountBridge();
    handler({
      kind: "started",
      executionId: "x1",
      commandId: "cmd-bridge",
    });
    const exec = useExecutionStore.getState().executions["x1"];
    expect(exec).toBeDefined();
    expect(exec.commandId).toBe("cmd-bridge");
    expect(exec.commandName).toBe("Bridge Cmd");
  });

  it("should use 'Untitled command' name when commandId is missing", async () => {
    const { handler } = mountBridge();
    handler({ kind: "started", executionId: "x2" });
    expect(useExecutionStore.getState().executions["x2"].commandName).toBe(
      "Untitled command",
    );
  });

  it("should use 'Untitled command' name when commandId does not match any command", async () => {
    const { handler } = mountBridge();
    handler({ kind: "started", executionId: "x3", commandId: "missing" });
    expect(useExecutionStore.getState().executions["x3"].commandName).toBe(
      "Untitled command",
    );
  });

  it("should attach variables from the started event (backend-initiated run, e.g. scheduler/workflow)", () => {
    const { handler } = mountBridge();
    // A scheduled/workflow run is NOT pre-registered by the frontend, so the
    // only place its variable values can come from is the started event.
    handler({
      kind: "started",
      executionId: "sched-1",
      commandId: "cmd-x",
      variables: [
        { name: "host", value: "example.com", sensitive: false },
        { name: "token", value: "***", sensitive: true },
      ],
    });
    const exec = useExecutionStore.getState().executions["sched-1"];
    expect(exec.variables).toEqual([
      { name: "host", value: "example.com", sensitive: false },
      { name: "token", value: "***", sensitive: true },
    ]);
  });
});

describe("useExecutionBridge - log events", () => {
  it("should append stdout lines to the execution log with stream='stdout'", async () => {
    const { handler } = mountBridge();
    handler({ kind: "started", executionId: "x" });
    handler({ kind: "stdout", executionId: "x", line: "hello" });
    const log = useExecutionStore.getState().executions["x"].log;
    expect(log).toHaveLength(1);
    expect(log[0].stream).toBe("stdout");
    expect(log[0].line).toBe("hello");
    expect(typeof log[0].ts).toBe("number");
  });

  it("should append stderr lines with stream='stderr'", async () => {
    const { handler } = mountBridge();
    handler({ kind: "started", executionId: "x" });
    handler({ kind: "stderr", executionId: "x", line: "ouch" });
    const log = useExecutionStore.getState().executions["x"].log;
    expect(log[0].stream).toBe("stderr");
    expect(log[0].line).toBe("ouch");
  });
});

describe("useExecutionBridge - 'finished' event", () => {
  it("should set status='success' when exitCode is 0", async () => {
    const { handler } = mountBridge();
    handler({ kind: "started", executionId: "x" });
    handler({
      kind: "finished",
      executionId: "x",
      exitCode: 0,
      durationMs: 11,
    });
    const exec = useExecutionStore.getState().executions["x"];
    expect(exec.status).toBe("success");
    expect(exec.exitCode).toBe(0);
    expect(exec.durationMs).toBe(11);
    expect(typeof exec.finishedAt).toBe("number");
  });

  it("should set status='error' when exitCode is non-zero", async () => {
    const { handler } = mountBridge();
    handler({ kind: "started", executionId: "x" });
    handler({
      kind: "finished",
      executionId: "x",
      exitCode: 2,
      durationMs: 5,
    });
    expect(useExecutionStore.getState().executions["x"].status).toBe("error");
  });
});

describe("useExecutionBridge - 'error' event", () => {
  it("should mark the execution as error with the error message attached", async () => {
    const { handler } = mountBridge();
    handler({ kind: "started", executionId: "x" });
    handler({ kind: "error", executionId: "x", message: "boom" });
    const exec = useExecutionStore.getState().executions["x"];
    expect(exec.status).toBe("error");
    expect(exec.error).toBe("boom");
  });
});

describe("useExecutionBridge - 'cancelled' event", () => {
  it("should mark the execution as cancelled without an error message", async () => {
    const { handler } = mountBridge();
    handler({ kind: "started", executionId: "x" });
    handler({ kind: "cancelled", executionId: "x" });
    const exec = useExecutionStore.getState().executions["x"];
    expect(exec.status).toBe("cancelled");
    expect(exec.error).toBeUndefined();
  });
});

describe("useExecutionBridge - transient executions", () => {
  it("should not write any events for an executionId marked transient", () => {
    markTransient("t1");
    const { handler } = mountBridge();
    handler({ kind: "started", executionId: "t1" });
    handler({ kind: "stdout", executionId: "t1", line: "hello" });
    handler({
      kind: "finished",
      executionId: "t1",
      exitCode: 0,
      durationMs: 5,
    });
    const state = useExecutionStore.getState();
    expect(state.executions["t1"]).toBeUndefined();
    expect(state.recentIds).not.toContain("t1");
    expect(state.activeExecutionId).toBeNull();
    expect(state.panelOpen).toBe(false);
  });

  it("should still route events for non-transient ids when other ids are transient", () => {
    markTransient("t1");
    const { handler } = mountBridge();
    handler({ kind: "started", executionId: "t1" });
    handler({ kind: "started", executionId: "normal" });
    handler({ kind: "stdout", executionId: "normal", line: "line" });
    const state = useExecutionStore.getState();
    expect(state.executions["t1"]).toBeUndefined();
    expect(state.executions["normal"]).toBeDefined();
    expect(state.executions["normal"].log).toHaveLength(1);
  });
});

describe("useExecutionBridge - 'result' event", () => {
  it("should attach the extracted result to the execution", () => {
    const { handler } = mountBridge();
    handler({ kind: "started", executionId: "x" });
    handler({
      kind: "result",
      executionId: "x",
      fields: { count: 3 },
      returnValue: 3,
    });
    const exec = useExecutionStore.getState().executions["x"];
    expect(exec.result).toEqual({ fields: { count: 3 }, returnValue: 3 });
  });

  it("should attach the extraction error when present", () => {
    const { handler } = mountBridge();
    handler({ kind: "started", executionId: "x" });
    handler({
      kind: "result",
      executionId: "x",
      fields: {},
      returnValue: null,
      error: "invalid JSON output: x",
    });
    const exec = useExecutionStore.getState().executions["x"];
    expect(exec.result?.error).toBe("invalid JSON output: x");
  });

  it("should NOT attach a result to a workflow aggregate for a node's result event", () => {
    const { handler } = mountBridge();
    useExecutionStore.getState().startWorkflowExecution("run-1", "WF");
    handler({
      kind: "result",
      executionId: "node-1",
      fields: { a: 1 },
      returnValue: 1,
      workflowRunId: "run-1",
    });
    // The aggregated run must not gain a result from a node event, and no
    // standalone execution should be created for the node id.
    const state = useExecutionStore.getState();
    expect(state.executions["run-1"]?.result).toBeUndefined();
    expect(state.executions["node-1"]).toBeUndefined();
  });
});

describe("useExecutionBridge - workflow node routing", () => {
  /** Set up the workflow run + a single node→execution mapping the buffering
   *  path resolves against (mirrors what `nodeStarted` does in production). */
  function setupRunWithNode(
    runId: string,
    nodeId: string,
    executionId: string,
  ): void {
    const runStore = useWorkflowRunStore.getState();
    runStore.clearAll();
    runStore.startRun(runId, "wf-1");
    runStore.markNodeStarted(runId, nodeId, executionId);
  }

  it("should BUFFER a node's stdout against its node (grouped flush), not append to the aggregate immediately", () => {
    const { handler } = mountBridge();
    // The aggregated process pre-exists (triggerWorkflowRun starts it).
    useExecutionStore.getState().startWorkflowExecution("run-1", "Flow");
    setupRunWithNode("run-1", "node-A", "node-exec-1");
    handler({
      kind: "stdout",
      executionId: "node-exec-1",
      line: "from node",
      workflowRunId: "run-1",
    });
    const state = useExecutionStore.getState();
    // No standalone node execution created.
    expect(state.executions["node-exec-1"]).toBeUndefined();
    // The line is BUFFERED (awaiting flush under the node's header at finish),
    // so the aggregate log is still empty — the workflow bridge owns the flush.
    expect(state.executions["run-1"].log).toEqual([]);
    // The node id never entered recents.
    expect(state.recentIds).toEqual(["run-1"]);
    // The line is buffered against the node for grouped flush.
    expect(
      useWorkflowRunStore.getState().runs["run-1"].lineBuffers["node-A"],
    ).toEqual([{ stream: "stdout", line: "from node", ts: expect.any(Number) }]);
  });

  it("should buffer stderr from a workflow node as stderr", () => {
    const { handler } = mountBridge();
    useExecutionStore.getState().startWorkflowExecution("run-1", "Flow");
    setupRunWithNode("run-1", "node-A", "node-exec-1");
    handler({
      kind: "stderr",
      executionId: "node-exec-1",
      line: "warn",
      workflowRunId: "run-1",
    });
    expect(
      useWorkflowRunStore.getState().runs["run-1"].lineBuffers["node-A"],
    ).toEqual([{ stream: "stderr", line: "warn", ts: expect.any(Number) }]);
    // Still nothing on the aggregate until the node finishes.
    expect(useExecutionStore.getState().executions["run-1"].log).toEqual([]);
  });

  it("should NOT create a standalone execution for a workflow node's started/finished events", () => {
    const { handler } = mountBridge();
    useExecutionStore.getState().startWorkflowExecution("run-1", "Flow");
    handler({
      kind: "started",
      executionId: "node-exec-1",
      commandId: "c1",
      workflowRunId: "run-1",
    });
    handler({
      kind: "finished",
      executionId: "node-exec-1",
      exitCode: 0,
      durationMs: 5,
      workflowRunId: "run-1",
    });
    const state = useExecutionStore.getState();
    expect(state.executions["node-exec-1"]).toBeUndefined();
    // The aggregate's terminal status is owned by the workflow bridge, so
    // the node's finished event must NOT flip it.
    expect(state.executions["run-1"].status).toBe("running");
  });

  it("captures a workflow node's stdout + result into per-node nodeOutputs", () => {
    const { handler } = mountBridge();
    useExecutionStore.getState().startWorkflowExecution("run-1", "Flow");
    // Set up the run + the node→execution mapping the capture resolves against.
    const runStore = useWorkflowRunStore.getState();
    runStore.clearAll();
    runStore.startRun("run-1", "wf-1");
    runStore.markNodeStarted("run-1", "node-A", "node-exec-1");

    handler({
      kind: "stdout",
      executionId: "node-exec-1",
      line: "line one",
      workflowRunId: "run-1",
    });
    handler({
      kind: "stdout",
      executionId: "node-exec-1",
      line: "line two",
      workflowRunId: "run-1",
    });
    handler({
      kind: "result",
      executionId: "node-exec-1",
      fields: { count: 2 },
      returnValue: 2,
      workflowRunId: "run-1",
    });

    const out = useWorkflowRunStore.getState().runs["run-1"].nodeOutputs[
      "node-A"
    ];
    expect(out.stdout).toBe("line one\nline two");
    expect(out.result).toEqual({ fields: { count: 2 }, returnValue: 2 });
  });

  it("should leave direct (non-workflow) runs on the unchanged standalone path", () => {
    const { handler } = mountBridge();
    handler({ kind: "started", executionId: "direct-1", commandId: "c1" });
    handler({ kind: "stdout", executionId: "direct-1", line: "hi" });
    const state = useExecutionStore.getState();
    // A real standalone execution exists exactly as before this feature.
    expect(state.executions["direct-1"]).toBeDefined();
    expect(state.executions["direct-1"].log).toHaveLength(1);
    expect(state.recentIds).toContain("direct-1");
    expect(state.activeExecutionId).toBe("direct-1");
  });
});
