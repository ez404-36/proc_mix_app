import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recordMock = vi.fn();

vi.mock("../utils/historyRepository", () => ({
  recordHistoryEventInDb: (...args: unknown[]) => recordMock(...args),
}));

vi.mock("@arco-design/web-react", () => ({
  Message: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// Use the real workflowStore — verify the wrapper composes with the actual
// add/update/delete implementations, not a stub. Stub the repository so the
// store never tries to invoke Tauri.
import { useWorkflowStore } from "../stores/workflowStore";
vi.mock("../utils/workflowRepository", () => ({
  upsertWorkflowInDb: vi.fn().mockResolvedValue(undefined),
  deleteWorkflowInDb: vi.fn().mockResolvedValue(undefined),
  listWorkflowsFromDb: vi.fn().mockResolvedValue([]),
}));

import type { HistoryEvent, Workflow } from "../types";
import {
  createWorkflow,
  deleteWorkflow,
  updateWorkflow,
} from "./workflowActions";

type NewWorkflowInput = Omit<
  Workflow,
  "id" | "createdAt" | "updatedAt" | "runCount"
>;

function baseInput(overrides: Partial<NewWorkflowInput> = {}): NewWorkflowInput {
  return {
    name: "WF",
    nodes: [],
    edges: [],
    tags: [],
    favorite: false,
    ...overrides,
  };
}

beforeEach(() => {
  recordMock.mockReset();
  recordMock.mockResolvedValue("logged-id");
  useWorkflowStore.setState({ workflows: [], hydrated: true });
});

afterEach(() => {
  useWorkflowStore.setState({ workflows: [], hydrated: true });
});

describe("createWorkflow", () => {
  it("adds a workflow to the store and records a workflowCreated event", () => {
    const w = createWorkflow(baseInput({ name: "Deploy" }));
    expect(w.id).toBeTruthy();
    expect(useWorkflowStore.getState().workflows).toHaveLength(1);
    expect(recordMock).toHaveBeenCalledTimes(1);
    const evt = recordMock.mock.calls[0]?.[0] as HistoryEvent;
    if (evt.kind !== "workflowCreated") throw new Error("kind narrowing");
    expect(evt.workflowId).toBe(w.id);
    expect(evt.snapshotAfter.name).toBe("Deploy");
  });
});

describe("updateWorkflow", () => {
  it("patches and records workflowEdited with both snapshots", () => {
    const w = createWorkflow(baseInput({ name: "Deploy" }));
    recordMock.mockClear();
    const result = updateWorkflow(w.id, { name: "Deploy 2" });
    expect(result?.before.name).toBe("Deploy");
    expect(result?.after.name).toBe("Deploy 2");
    expect(recordMock).toHaveBeenCalledTimes(1);
    const evt = recordMock.mock.calls[0]?.[0] as HistoryEvent;
    if (evt.kind !== "workflowEdited") throw new Error("kind narrowing");
    expect(evt.snapshotBefore.name).toBe("Deploy");
    expect(evt.snapshotAfter.name).toBe("Deploy 2");
  });

  it("returns null and records nothing for unknown id", () => {
    const result = updateWorkflow("nope", { name: "x" });
    expect(result).toBeNull();
    expect(recordMock).not.toHaveBeenCalled();
  });
});

describe("deleteWorkflow", () => {
  it("removes from store and records workflowDeleted with the snapshot", () => {
    const w = createWorkflow(baseInput());
    recordMock.mockClear();
    const removed = deleteWorkflow(w.id);
    expect(removed?.id).toBe(w.id);
    expect(useWorkflowStore.getState().workflows).toHaveLength(0);
    expect(recordMock).toHaveBeenCalledTimes(1);
    const evt = recordMock.mock.calls[0]?.[0] as HistoryEvent;
    if (evt.kind !== "workflowDeleted") throw new Error("kind narrowing");
    expect(evt.snapshotBefore.id).toBe(w.id);
  });

  it("returns null and records nothing when the id is unknown", () => {
    const removed = deleteWorkflow("does-not-exist");
    expect(removed).toBeNull();
    expect(recordMock).not.toHaveBeenCalled();
  });
});

describe("history-write failure does NOT roll back the action", () => {
  it("keeps the new workflow in the store even when recordHistoryEventInDb rejects", async () => {
    recordMock.mockReset();
    recordMock.mockRejectedValueOnce(new Error("disk full"));
    const w = createWorkflow(baseInput());
    await new Promise((r) => setTimeout(r, 0));
    expect(useWorkflowStore.getState().workflows).toHaveLength(1);
    expect(useWorkflowStore.getState().workflows[0]?.id).toBe(w.id);
  });
});
