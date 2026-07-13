import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowEvent } from "../types";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

const eventState = vi.hoisted(() => {
  const listeners: Array<(event: { payload: unknown }) => void> = [];
  const unlistenFn = () => {};
  const control = { failNext: false, lastError: null as unknown };
  const listen = (
    _channel: string,
    cb: (event: { payload: unknown }) => void,
  ): Promise<() => void> => {
    if (control.failNext) {
      return Promise.reject(control.lastError);
    }
    listeners.push(cb);
    return Promise.resolve(unlistenFn);
  };
  return { listeners, listen, control };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: eventState.listen }));

function emit(payload: WorkflowEvent): void {
  for (const cb of eventState.listeners) cb({ payload });
}

import type { Workflow } from "../types";
import {
  awaitWorkflowBridgeReady,
  cancelWorkflow,
  executeWorkflow,
  executeWorkflowFromNode,
  subscribeWorkflowEvents,
} from "./workflowRunner";

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "w1",
    name: "Deploy",
    nodes: [],
    edges: [],
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("executeWorkflow", () => {
  it("invokes execute_workflow with the wire record and returns the run id", async () => {
    invokeMock.mockResolvedValue("run-1");
    const runId = await executeWorkflow(
      workflow(),
      { "node-a": { x: "1" } },
      { "node-b": "/tmp" },
    );
    expect(runId).toBe("run-1");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = invokeMock.mock.calls[0] as [
      string,
      {
        workflow: { id: string };
        nodeVariableValues: unknown;
        nodeWorkingDirValues: unknown;
      },
    ];
    expect(cmd).toBe("execute_workflow");
    expect(args.workflow.id).toBe("w1");
    expect(args.nodeVariableValues).toEqual({ "node-a": { x: "1" } });
    expect(args.nodeWorkingDirValues).toEqual({ "node-b": "/tmp" });
  });
});

describe("executeWorkflowFromNode", () => {
  it("invokes run_workflow_from_node with start node and seed input", async () => {
    invokeMock.mockResolvedValue("run-2");
    const runId = await executeWorkflowFromNode(
      workflow(),
      {},
      {},
      "node-start",
      "seed",
    );
    expect(runId).toBe("run-2");
    const [cmd, args] = invokeMock.mock.calls[0] as [
      string,
      { startNodeId: string; seedInput: string | null },
    ];
    expect(cmd).toBe("run_workflow_from_node");
    expect(args.startNodeId).toBe("node-start");
    expect(args.seedInput).toBe("seed");
  });

  it("passes a null seed input through", async () => {
    invokeMock.mockResolvedValue("run-3");
    await executeWorkflowFromNode(workflow(), {}, {}, "node-start", null);
    const [, args] = invokeMock.mock.calls[0] as [
      string,
      { seedInput: string | null },
    ];
    expect(args.seedInput).toBeNull();
  });
});

describe("cancelWorkflow", () => {
  it("invokes cancel_workflow with the run id", async () => {
    invokeMock.mockResolvedValue(undefined);
    await cancelWorkflow("run-9");
    expect(invokeMock).toHaveBeenCalledWith("cancel_workflow", {
      runId: "run-9",
    });
  });
});

describe("subscribeWorkflowEvents", () => {
  it("registers a handler that receives dispatched event payloads", () => {
    const received: WorkflowEvent[] = [];
    const unsub = subscribeWorkflowEvents((e) => received.push(e));

    const payload = { type: "runStarted", runId: "r1" } as unknown as
      WorkflowEvent;
    emit(payload);
    expect(received).toEqual([payload]);

    unsub();
    emit(payload);
    expect(received).toHaveLength(1);
  });
});

describe("awaitWorkflowBridgeReady", () => {
  it("resolves once the listener is attached", async () => {
    await expect(awaitWorkflowBridgeReady()).resolves.toBeUndefined();
  });
});

describe("listener attach failure", () => {
  it("logs an error when the initial listen() rejects at module load", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const failure = new Error("attach failed");
    eventState.control.failNext = true;
    eventState.control.lastError = failure;

    vi.resetModules();
    await import("./workflowRunner");
    // The module-load `void ensureSubscribed()` starts a rejected promise
    // whose `.catch` logs; let its microtask settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(errorSpy).toHaveBeenCalledWith(
      "workflow-event listener failed to attach:",
      failure,
    );

    eventState.control.failNext = false;
    errorSpy.mockRestore();
  });
});
