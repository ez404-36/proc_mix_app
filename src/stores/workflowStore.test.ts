import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Avoid importing the real Tauri runtime indirectly.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

// Mock the IPC repository so the store tests stay focused on state
// transitions; the wire format is exercised in `workflowRepository.test.ts`.
const listMock = vi.fn();
const upsertMock = vi.fn();
const deleteMock = vi.fn();
vi.mock("../utils/workflowRepository", () => ({
  listWorkflowsFromDb: () => listMock(),
  upsertWorkflowInDb: (wf: unknown) => upsertMock(wf),
  deleteWorkflowInDb: (id: string) => deleteMock(id),
}));

// Mock Arco's Message so failure paths don't try to render a toast in jsdom.
const messageErrorMock = vi.fn();
vi.mock("@arco-design/web-react", () => ({
  Message: { error: (...args: unknown[]) => messageErrorMock(...args) },
}));

import type { Workflow } from "../types";
import { useWorkflowStore } from "./workflowStore";

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
  useWorkflowStore.setState({ workflows: [], hydrated: true });
  listMock.mockReset();
  upsertMock.mockReset();
  upsertMock.mockResolvedValue(undefined);
  deleteMock.mockReset();
  deleteMock.mockResolvedValue(undefined);
  messageErrorMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workflowStore.addWorkflow", () => {
  it("appends a workflow with generated id, timestamps and runCount=0", () => {
    const created = useWorkflowStore.getState().addWorkflow(baseInput());
    expect(created.id).toBeTypeOf("string");
    expect(created.id.length).toBeGreaterThan(0);
    expect(created.runCount).toBe(0);
    expect(created.createdAt).toBe(created.updatedAt);
    expect(useWorkflowStore.getState().workflows).toHaveLength(1);
  });

  it("persists the new workflow via upsertWorkflowInDb", () => {
    useWorkflowStore.getState().addWorkflow(baseInput({ name: "Persisted" }));
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect((upsertMock.mock.calls[0]?.[0] as Workflow).name).toBe("Persisted");
  });

  it("falls back to a Math.random id when crypto.randomUUID is unavailable", () => {
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      value: undefined,
      configurable: true,
    });
    try {
      const created = useWorkflowStore.getState().addWorkflow(baseInput());
      expect(created.id).toMatch(/^wf-/);
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        value: original,
        configurable: true,
      });
    }
  });

  it("surfaces a Message.error toast when persistence fails", async () => {
    upsertMock.mockRejectedValueOnce(new Error("boom"));
    useWorkflowStore.getState().addWorkflow(baseInput());
    await new Promise((r) => setTimeout(r, 0));
    expect(messageErrorMock).toHaveBeenCalledWith("Failed to save workflow");
  });
});

describe("workflowStore.updateWorkflow", () => {
  it("patches a workflow, refreshes updatedAt and returns before/after", async () => {
    const created = useWorkflowStore.getState().addWorkflow(baseInput());
    upsertMock.mockClear();
    await new Promise((r) => setTimeout(r, 5));
    const result = useWorkflowStore
      .getState()
      .updateWorkflow(created.id, { name: "Renamed" });
    expect(result?.before.name).toBe("WF");
    expect(result?.after.name).toBe("Renamed");
    expect(result?.after.updatedAt).not.toBe(created.updatedAt);
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  it("is a no-op and returns null when the id does not exist", () => {
    const result = useWorkflowStore
      .getState()
      .updateWorkflow("nope", { name: "x" });
    expect(result).toBeNull();
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe("workflowStore.deleteWorkflow", () => {
  it("removes a workflow and returns the snapshot", () => {
    const created = useWorkflowStore.getState().addWorkflow(baseInput());
    const removed = useWorkflowStore.getState().deleteWorkflow(created.id);
    expect(removed?.id).toBe(created.id);
    expect(useWorkflowStore.getState().workflows).toHaveLength(0);
    expect(deleteMock).toHaveBeenCalledWith(created.id);
  });

  it("returns null but still issues the delete IPC for an unknown id", () => {
    const removed = useWorkflowStore.getState().deleteWorkflow("nope");
    expect(removed).toBeNull();
    expect(deleteMock).toHaveBeenCalledWith("nope");
  });

  it("surfaces a Message.error toast when persistence fails", async () => {
    const created = useWorkflowStore.getState().addWorkflow(baseInput());
    deleteMock.mockRejectedValueOnce(new Error("boom"));
    useWorkflowStore.getState().deleteWorkflow(created.id);
    await new Promise((r) => setTimeout(r, 0));
    expect(messageErrorMock).toHaveBeenCalledWith("Failed to delete workflow");
  });
});

describe("workflowStore.toggleFavorite", () => {
  it("flips favorite and persists", () => {
    const created = useWorkflowStore.getState().addWorkflow(baseInput());
    upsertMock.mockClear();
    useWorkflowStore.getState().toggleFavorite(created.id);
    const updated = useWorkflowStore
      .getState()
      .workflows.find((w) => w.id === created.id);
    expect(updated?.favorite).toBe(true);
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });
});

describe("workflowStore.markWorkflowRun", () => {
  it("increments runCount and sets lastRunAt", () => {
    const created = useWorkflowStore.getState().addWorkflow(baseInput());
    useWorkflowStore.getState().markWorkflowRun(created.id);
    const updated = useWorkflowStore
      .getState()
      .workflows.find((w) => w.id === created.id);
    expect(updated?.runCount).toBe(1);
    expect(updated?.lastRunAt).toBeTypeOf("string");
  });

  it("is a no-op when the id does not exist", () => {
    useWorkflowStore.getState().addWorkflow(baseInput());
    upsertMock.mockClear();
    useWorkflowStore.getState().markWorkflowRun("nope");
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe("workflowStore.hydrateFromDb", () => {
  beforeEach(() => {
    useWorkflowStore.setState({ workflows: [], hydrated: false });
  });

  it("loads workflows from the repository and marks hydrated", async () => {
    const fixture: Workflow = {
      id: "from-db",
      name: "Loaded",
      nodes: [],
      edges: [],
      tags: [],
      favorite: false,
      createdAt: "2026-05-28T00:00:00Z",
      updatedAt: "2026-05-28T00:00:00Z",
      runCount: 0,
    };
    listMock.mockResolvedValueOnce([fixture]);
    await useWorkflowStore.getState().hydrateFromDb();
    expect(useWorkflowStore.getState().workflows).toEqual([fixture]);
    expect(useWorkflowStore.getState().hydrated).toBe(true);
  });

  it("flips hydrated=true even when the IPC call rejects", async () => {
    listMock.mockRejectedValueOnce(new Error("ipc-down"));
    await useWorkflowStore.getState().hydrateFromDb();
    expect(useWorkflowStore.getState().hydrated).toBe(true);
    expect(useWorkflowStore.getState().workflows).toEqual([]);
  });
});
