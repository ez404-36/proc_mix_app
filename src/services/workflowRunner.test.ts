import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const upsertCommandMock = vi.fn();
vi.mock("../utils/commandRepository", () => ({
  upsertCommandInDb: (...args: unknown[]) => upsertCommandMock(...args),
}));

const executeWorkflowMock = vi.fn();
const bridgeReadyMock = vi.fn();
vi.mock("../utils/workflowRunner", () => ({
  executeWorkflow: (...args: unknown[]) => executeWorkflowMock(...args),
  awaitWorkflowBridgeReady: () => bridgeReadyMock(),
}));

// Reuse the real variable-resolution contract via a mock so the test stays
// isolated from the executor/prompt internals `runCommand` pulls in. The
// default resolves to `{}` (no variables); individual tests override it to
// exercise the supplied-value and cancel paths.
const resolveVariableValuesMock = vi.fn();
vi.mock("./commandRunner", () => ({
  resolveVariableValues: (...args: unknown[]) =>
    resolveVariableValuesMock(...args),
}));

const recordMock = vi.fn();
vi.mock("../utils/historyRepository", () => ({
  recordHistoryEventInDb: (...args: unknown[]) => recordMock(...args),
}));

const messageErrorMock = vi.fn();
vi.mock("@arco-design/web-react", () => ({
  Message: { error: (...args: unknown[]) => messageErrorMock(...args) },
}));

import type { Command, HistoryEvent, Workflow } from "../types";
import { useCommandStore } from "../stores/commandStore";
import { useWorkflowRunStore } from "../stores/workflowRunStore";
import { useWorkflowStore } from "../stores/workflowStore";
import { triggerWorkflowRun } from "./workflowRunner";

function makeCommand(id: string): Command {
  return {
    id,
    name: id,
    script: "true",
    tags: [],
    favorite: false,
    createdAt: "2026-05-28T00:00:00Z",
    updatedAt: "2026-05-28T00:00:00Z",
    runCount: 0,
    runAsAdmin: false,
  };
}

function makeWorkflow(commandIds: string[]): Workflow {
  return {
    id: "wf-1",
    name: "Deploy",
    nodes: commandIds.map((cid, i) => ({
      id: `n${i}`,
      kind: "command",
      commandId: cid,
      position: { x: i * 100, y: 0 },
    })),
    edges: [],
    tags: [],
    favorite: false,
    createdAt: "2026-05-28T00:00:00Z",
    updatedAt: "2026-05-28T00:00:00Z",
    runCount: 0,
  };
}

beforeEach(() => {
  upsertCommandMock.mockReset();
  upsertCommandMock.mockResolvedValue(undefined);
  executeWorkflowMock.mockReset();
  executeWorkflowMock.mockResolvedValue("run-123");
  bridgeReadyMock.mockReset();
  bridgeReadyMock.mockResolvedValue(undefined);
  recordMock.mockReset();
  recordMock.mockResolvedValue("logged-id");
  resolveVariableValuesMock.mockReset();
  // Default: commands declare no variables → empty resolved map, no prompt.
  resolveVariableValuesMock.mockResolvedValue({});
  messageErrorMock.mockReset();
  useCommandStore.setState({
    commands: [makeCommand("cmd-a"), makeCommand("cmd-b")],
    favorites: [],
    seedsInitialized: true,
    hydrated: true,
  });
  useWorkflowStore.setState({ workflows: [], hydrated: true });
  useWorkflowRunStore.setState({ runs: {}, recentRunIds: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("triggerWorkflowRun - happy path", () => {
  it("persists referenced commands, awaits the bridge, invokes execute, then records history", async () => {
    const wf = makeWorkflow(["cmd-a", "cmd-b"]);
    const runId = await triggerWorkflowRun(wf);

    expect(runId).toBe("run-123");
    // Both referenced commands re-persisted before the run.
    expect(upsertCommandMock).toHaveBeenCalledTimes(2);
    expect(bridgeReadyMock).toHaveBeenCalledTimes(1);
    // No-variable commands → empty per-node value map passed to the IPC.
    expect(executeWorkflowMock).toHaveBeenCalledWith(wf, {});

    // Run registered in the progress store.
    expect(useWorkflowRunStore.getState().runs["run-123"]).toBeDefined();

    // workflowRun(running) history row recorded.
    expect(recordMock).toHaveBeenCalledTimes(1);
    const evt = recordMock.mock.calls[0]?.[0] as HistoryEvent;
    if (evt.kind !== "workflowRun") throw new Error("kind narrowing");
    expect(evt.executionId).toBe("run-123");
    expect(evt.status).toBe("running");
  });

  it("dedupes a command referenced by multiple nodes", async () => {
    const wf = makeWorkflow(["cmd-a", "cmd-a"]);
    await triggerWorkflowRun(wf);
    expect(upsertCommandMock).toHaveBeenCalledTimes(1);
  });
});

describe("triggerWorkflowRun - missing command", () => {
  it("aborts with a toast and never invokes execute when a node references an unknown command", async () => {
    const wf = makeWorkflow(["cmd-a", "cmd-missing"]);
    const runId = await triggerWorkflowRun(wf);
    expect(runId).toBeNull();
    expect(executeWorkflowMock).not.toHaveBeenCalled();
    expect(messageErrorMock).toHaveBeenCalledTimes(1);
  });
});

describe("triggerWorkflowRun - execute failure", () => {
  it("returns null and surfaces a toast when execute_workflow throws", async () => {
    executeWorkflowMock.mockRejectedValueOnce(new Error("ipc-down"));
    const wf = makeWorkflow(["cmd-a"]);
    const runId = await triggerWorkflowRun(wf);
    expect(runId).toBeNull();
    expect(messageErrorMock).toHaveBeenCalledTimes(1);
  });
});

describe("triggerWorkflowRun - variable values", () => {
  it("resolves variables for each command node and forwards them keyed by node id", async () => {
    // cmd-a's variable resolves to a value (e.g. prompt answer); cmd-b has none.
    resolveVariableValuesMock.mockImplementation((cmd: Command) =>
      cmd.id === "cmd-a"
        ? Promise.resolve({ token: "secret" })
        : Promise.resolve({}),
    );
    const wf = makeWorkflow(["cmd-a", "cmd-b"]);
    const runId = await triggerWorkflowRun(wf);

    expect(runId).toBe("run-123");
    expect(resolveVariableValuesMock).toHaveBeenCalledTimes(2);
    // Only the node whose command resolved to a non-empty map is included;
    // the node ids come from makeWorkflow (`n0`, `n1`).
    expect(executeWorkflowMock).toHaveBeenCalledWith(wf, {
      n0: { token: "secret" },
    });
  });

  it("aborts quietly (no execute, no toast) when the user cancels a prompt", async () => {
    // A null result mirrors a cancelled variable prompt.
    resolveVariableValuesMock.mockResolvedValueOnce(null);
    const wf = makeWorkflow(["cmd-a", "cmd-b"]);
    const runId = await triggerWorkflowRun(wf);

    expect(runId).toBeNull();
    expect(executeWorkflowMock).not.toHaveBeenCalled();
    expect(messageErrorMock).not.toHaveBeenCalled();
  });

  it("prompts only once for a command referenced by multiple nodes", async () => {
    resolveVariableValuesMock.mockResolvedValue({ token: "v" });
    const wf = makeWorkflow(["cmd-a", "cmd-a"]);
    await triggerWorkflowRun(wf);

    // Same command id on both nodes → resolved once, reused for both.
    expect(resolveVariableValuesMock).toHaveBeenCalledTimes(1);
    expect(executeWorkflowMock).toHaveBeenCalledWith(wf, {
      n0: { token: "v" },
      n1: { token: "v" },
    });
  });

  it("defaults-only commands run with no prompt and an empty value map", async () => {
    // The default mock already resolves to {} for every command.
    const wf = makeWorkflow(["cmd-a"]);
    const runId = await triggerWorkflowRun(wf);

    expect(runId).toBe("run-123");
    expect(executeWorkflowMock).toHaveBeenCalledWith(wf, {});
  });
});
