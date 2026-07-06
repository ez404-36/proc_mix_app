import { describe, expect, it } from "vitest";
import type { Schedule, Workflow, WorkflowNode } from "../types";
import {
  checkCommandBlockers,
  checkWorkflowBlockers,
  type DeleteBlocker,
} from "./usageCheck";

function node(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: overrides.id ?? "n1",
    kind: "command",
    position: { x: 0, y: 0 },
    ...overrides,
  };
}

function wf(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: overrides.id ?? "w1",
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

function sched(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: overrides.id ?? "s1",
    name: "Nightly",
    enabled: true,
    targetKind: "command",
    targetId: "c1",
    cron: "0 0 * * *",
    variableValues: {},
    skipIfRunning: false,
    captureOutput: true,
    catchUpPolicy: "none",
    maxRetries: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
    ...overrides,
  };
}

describe("checkCommandBlockers", () => {
  it("returns an empty array when nothing references the command", () => {
    const workflows = [wf({ nodes: [node({ kind: "start" })] })];
    const schedules = [sched({ targetKind: "command", targetId: "other" })];

    expect(checkCommandBlockers("c1", workflows, schedules)).toEqual([]);
  });

  it("flags a workflow whose command node references the command", () => {
    const workflows = [
      wf({
        id: "w1",
        name: "Build & Deploy",
        nodes: [node({ kind: "command", commandId: "c1" })],
      }),
    ];

    const blockers = checkCommandBlockers("c1", workflows, []);

    expect(blockers).toEqual<DeleteBlocker[]>([
      { kind: "workflow", id: "w1", name: "Build & Deploy" },
    ]);
  });

  it("does not flag a non-command node with a matching commandId", () => {
    const workflows = [
      wf({ nodes: [node({ kind: "data", commandId: "c1" })] }),
    ];

    expect(checkCommandBlockers("c1", workflows, [])).toEqual([]);
  });

  it("flags a schedule that targets the command", () => {
    const schedules = [
      sched({ id: "s1", name: "Nightly", targetKind: "command", targetId: "c1" }),
    ];

    const blockers = checkCommandBlockers("c1", [], schedules);

    expect(blockers).toEqual<DeleteBlocker[]>([
      { kind: "schedule", id: "s1", name: "Nightly" },
    ]);
  });

  it("does not flag a workflow-targeting schedule with a matching id", () => {
    const schedules = [
      sched({ targetKind: "workflow", targetId: "c1" }),
    ];

    expect(checkCommandBlockers("c1", [], schedules)).toEqual([]);
  });

  it("returns both a workflow and a schedule blocker", () => {
    const workflows = [
      wf({ id: "w1", name: "WF", nodes: [node({ commandId: "c1" })] }),
    ];
    const schedules = [
      sched({ id: "s1", name: "Sched", targetKind: "command", targetId: "c1" }),
    ];

    const blockers = checkCommandBlockers("c1", workflows, schedules);

    expect(blockers).toEqual<DeleteBlocker[]>([
      { kind: "workflow", id: "w1", name: "WF" },
      { kind: "schedule", id: "s1", name: "Sched" },
    ]);
  });
});

describe("checkWorkflowBlockers", () => {
  it("returns an empty array when no schedule targets the workflow", () => {
    const schedules = [
      sched({ targetKind: "command", targetId: "w1" }),
      sched({ targetKind: "workflow", targetId: "other" }),
    ];

    expect(checkWorkflowBlockers("w1", schedules)).toEqual([]);
  });

  it("flags a schedule that targets the workflow", () => {
    const schedules = [
      sched({ id: "s1", name: "WF Sched", targetKind: "workflow", targetId: "w1" }),
    ];

    const blockers = checkWorkflowBlockers("w1", schedules);

    expect(blockers).toEqual<DeleteBlocker[]>([
      { kind: "schedule", id: "s1", name: "WF Sched" },
    ]);
  });
});
