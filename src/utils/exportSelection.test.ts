import { describe, expect, it } from "vitest";
import type { Command, Workflow } from "../types";
import {
  collectWorkflowCommandIds,
  computeForcedCommandIds,
  isCommandLocked,
  resolveExportSelection,
  selectExportRecords,
  toggleInSet,
} from "./exportSelection";

function command(id: string): Command {
  return {
    id,
    name: `cmd-${id}`,
    script: "echo hi",
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
    runAsAdmin: false,
  };
}

function workflow(
  id: string,
  commandIds: ReadonlyArray<string | undefined>,
): Workflow {
  return {
    id,
    name: `wf-${id}`,
    nodes: [
      { id: `${id}-start`, kind: "start", position: { x: 0, y: 0 } },
      ...commandIds.map((commandId, i) => ({
        id: `${id}-n${i}`,
        kind: "command" as const,
        commandId,
        position: { x: 100 * (i + 1), y: 0 },
      })),
    ],
    edges: [],
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
  };
}

describe("collectWorkflowCommandIds", () => {
  it("returns unique commandIds in encounter order", () => {
    const wf = workflow("w1", ["c1", "c2", "c1"]);
    expect(collectWorkflowCommandIds(wf)).toEqual(["c1", "c2"]);
  });

  it("ignores nodes without a commandId (start/condition/end)", () => {
    const wf = workflow("w1", [undefined, "c1", undefined]);
    expect(collectWorkflowCommandIds(wf)).toEqual(["c1"]);
  });

  it("returns an empty array for a workflow with no command nodes", () => {
    const wf = workflow("w1", []);
    expect(collectWorkflowCommandIds(wf)).toEqual([]);
  });
});

describe("computeForcedCommandIds", () => {
  const workflows = [
    workflow("w1", ["c1", "c2"]),
    workflow("w2", ["c2", "c3"]),
    workflow("w3", ["c4"]),
  ];

  it("is empty when no workflows are selected", () => {
    expect(computeForcedCommandIds(new Set(), workflows).size).toBe(0);
  });

  it("collects the commands of a single selected workflow", () => {
    const forced = computeForcedCommandIds(new Set(["w1"]), workflows);
    expect([...forced].sort()).toEqual(["c1", "c2"]);
  });

  it("unions across multiple selected workflows (dedups shared commands)", () => {
    const forced = computeForcedCommandIds(new Set(["w1", "w2"]), workflows);
    expect([...forced].sort()).toEqual(["c1", "c2", "c3"]);
  });

  it("ignores unselected workflows", () => {
    const forced = computeForcedCommandIds(new Set(["w3"]), workflows);
    expect([...forced]).toEqual(["c4"]);
  });
});

describe("isCommandLocked", () => {
  it("reflects membership in the forced set", () => {
    const forced = new Set(["c1"]);
    expect(isCommandLocked("c1", forced)).toBe(true);
    expect(isCommandLocked("c2", forced)).toBe(false);
  });
});

describe("resolveExportSelection", () => {
  const workflows = [
    workflow("w1", ["c1", "c2"]),
    workflow("w2", ["c2"]),
  ];

  it("unions explicit command checks with forced commands", () => {
    const resolved = resolveExportSelection({
      checkedCommandIds: new Set(["c5"]),
      checkedWorkflowIds: new Set(["w1"]),
      workflows,
    });
    expect([...resolved.commandIds].sort()).toEqual(["c1", "c2", "c5"]);
    expect([...resolved.workflowIds]).toEqual(["w1"]);
  });

  it("includes forced commands even when the user never checked them", () => {
    const resolved = resolveExportSelection({
      checkedCommandIds: new Set(),
      checkedWorkflowIds: new Set(["w1"]),
      workflows,
    });
    expect([...resolved.commandIds].sort()).toEqual(["c1", "c2"]);
  });

  it("releases a purely-forced command when its workflow is deselected", () => {
    // c1 is only forced by w1. With w1 not selected, it is gone.
    const resolved = resolveExportSelection({
      checkedCommandIds: new Set(),
      checkedWorkflowIds: new Set(),
      workflows,
    });
    expect(resolved.commandIds.has("c1")).toBe(false);
  });

  it("keeps a command that the user also explicitly checked after deselecting its workflow", () => {
    const resolved = resolveExportSelection({
      checkedCommandIds: new Set(["c1"]),
      checkedWorkflowIds: new Set(),
      workflows,
    });
    expect(resolved.commandIds.has("c1")).toBe(true);
  });

  it("keeps a command still forced by another selected workflow", () => {
    // c2 is required by both w1 and w2. Deselect w1, keep w2 → c2 stays.
    const resolved = resolveExportSelection({
      checkedCommandIds: new Set(),
      checkedWorkflowIds: new Set(["w2"]),
      workflows,
    });
    expect(resolved.commandIds.has("c2")).toBe(true);
    expect(resolved.commandIds.has("c1")).toBe(false);
  });
});

describe("selectExportRecords", () => {
  it("maps resolved id sets back to records preserving input order", () => {
    const commands = [command("c1"), command("c2"), command("c3")];
    const wfs = [workflow("w1", ["c1"]), workflow("w2", ["c2"])];
    const out = selectExportRecords(
      { commandIds: new Set(["c3", "c1"]), workflowIds: new Set(["w2"]) },
      commands,
      wfs,
    );
    expect(out.commands.map((c) => c.id)).toEqual(["c1", "c3"]);
    expect(out.workflows.map((w) => w.id)).toEqual(["w2"]);
  });
});

describe("toggleInSet", () => {
  it("adds an absent id", () => {
    expect([...toggleInSet(new Set(["a"]), "b")].sort()).toEqual(["a", "b"]);
  });

  it("removes a present id", () => {
    expect([...toggleInSet(new Set(["a", "b"]), "a")]).toEqual(["b"]);
  });

  it("does not mutate the input set", () => {
    const original = new Set(["a"]);
    const next = toggleInSet(original, "b");
    expect([...original]).toEqual(["a"]);
    expect(next).not.toBe(original);
  });
});
