import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import type { Workflow } from "../types";
import {
  type WorkflowRecord,
  deleteWorkflowInDb,
  listWorkflowsFromDb,
  recordToWorkflow,
  upsertWorkflowInDb,
  workflowToRecord,
} from "./workflowRepository";

const fullWorkflow: Workflow = {
  id: "wf-1",
  name: "Deploy",
  description: "Build then deploy",
  icon: "rocket",
  nodes: [
    {
      id: "n-start",
      kind: "start",
      position: { x: 0, y: 0 },
    },
    {
      id: "n-build",
      kind: "command",
      commandId: "cmd-build",
      label: "Build",
      position: { x: 120, y: 40 },
    },
    {
      id: "n-cond",
      kind: "condition",
      position: { x: 240, y: 40 },
    },
    {
      id: "n-end",
      kind: "end",
      position: { x: 360, y: 40 },
    },
  ],
  edges: [
    { id: "e1", source: "n-start", target: "n-build", branch: "out" },
    { id: "e2", source: "n-build", target: "n-cond", branch: "out" },
    { id: "e3", source: "n-cond", target: "n-end", branch: "then" },
    { id: "e4", source: "n-cond", target: "n-end", branch: "else" },
  ],
  tags: ["ci"],
  categoryId: "cat-1",
  favorite: true,
  createdAt: "2026-05-28T00:00:00Z",
  updatedAt: "2026-05-28T00:00:01Z",
  lastRunAt: "2026-05-28T00:00:02Z",
  runCount: 4,
};

describe("workflowRepository conversions", () => {
  it("round-trips a full workflow domain -> record -> domain", () => {
    const back = recordToWorkflow(workflowToRecord(fullWorkflow));
    expect(back).toEqual(fullWorkflow);
  });

  it("collapses undefined optionals to null in the record", () => {
    const minimal: Workflow = {
      id: "wf-2",
      name: "Minimal",
      nodes: [],
      edges: [],
      tags: [],
      favorite: false,
      createdAt: "2026-05-28T00:00:00Z",
      updatedAt: "2026-05-28T00:00:00Z",
      runCount: 0,
    };
    const rec = workflowToRecord(minimal);
    expect(rec.description).toBeNull();
    expect(rec.icon).toBeNull();
    expect(rec.categoryId).toBeNull();
    expect(rec.lastRunAt).toBeNull();
    // Node optionals also collapse to null on the wire.
  });

  it("decodes null optionals back to undefined", () => {
    const rec: WorkflowRecord = {
      id: "wf-3",
      name: "FromWire",
      description: null,
      icon: null,
      nodes: [
        { id: "n1", kind: "command", commandId: null, label: null, position: { x: 1, y: 2 } },
      ],
      edges: [{ id: "e1", source: "n1", target: "n1", branch: "out" }],
      tags: [],
      categoryId: null,
      favorite: false,
      createdAt: "2026-05-28T00:00:00Z",
      updatedAt: "2026-05-28T00:00:00Z",
      lastRunAt: null,
      runCount: 0,
    };
    const wf = recordToWorkflow(rec);
    expect(wf.description).toBeUndefined();
    expect(wf.icon).toBeUndefined();
    expect(wf.categoryId).toBeUndefined();
    expect(wf.lastRunAt).toBeUndefined();
    expect(wf.nodes[0]?.commandId).toBeUndefined();
    expect(wf.nodes[0]?.label).toBeUndefined();
  });

  it("treats absent nodes/edges on the wire as empty arrays", () => {
    const rec: WorkflowRecord = {
      id: "wf-4",
      name: "NoGraph",
      description: null,
      icon: null,
      tags: [],
      categoryId: null,
      favorite: false,
      createdAt: "2026-05-28T00:00:00Z",
      updatedAt: "2026-05-28T00:00:00Z",
      lastRunAt: null,
      runCount: 0,
    };
    const wf = recordToWorkflow(rec);
    expect(wf.nodes).toEqual([]);
    expect(wf.edges).toEqual([]);
  });

  it("falls back to safe defaults for unknown node kind / edge branch", () => {
    const rec: WorkflowRecord = {
      id: "wf-5",
      name: "Bogus",
      description: null,
      icon: null,
      nodes: [
        { id: "n1", kind: "totally-bogus", commandId: null, label: null, position: { x: 0, y: 0 } },
      ],
      edges: [{ id: "e1", source: "n1", target: "n1", branch: "made-up" }],
      tags: [],
      categoryId: null,
      favorite: false,
      createdAt: "2026-05-28T00:00:00Z",
      updatedAt: "2026-05-28T00:00:00Z",
      lastRunAt: null,
      runCount: 0,
    };
    const wf = recordToWorkflow(rec);
    expect(wf.nodes[0]?.kind).toBe("command");
    expect(wf.edges[0]?.branch).toBe("out");
  });
});

describe("workflowRepository IPC wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("listWorkflowsFromDb invokes list_workflows and maps records", async () => {
    invokeMock.mockResolvedValueOnce([workflowToRecord(fullWorkflow)]);
    const result = await listWorkflowsFromDb();
    expect(invokeMock).toHaveBeenCalledWith("list_workflows", undefined);
    expect(result).toEqual([fullWorkflow]);
  });

  it("upsertWorkflowInDb invokes upsert_workflow with a `workflow` record", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await upsertWorkflowInDb(fullWorkflow);
    expect(invokeMock).toHaveBeenCalledWith("upsert_workflow", {
      workflow: workflowToRecord(fullWorkflow),
    });
  });

  it("deleteWorkflowInDb invokes delete_workflow with the id", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await deleteWorkflowInDb("wf-1");
    expect(invokeMock).toHaveBeenCalledWith("delete_workflow", { id: "wf-1" });
  });
});
