import { afterEach, describe, expect, it, vi } from "vitest";

const createCommandMock = vi.fn();
const createWorkflowMock = vi.fn();

vi.mock("./commandActions", () => ({
  createCommand: (input: unknown) => createCommandMock(input),
}));
vi.mock("./workflowActions", () => ({
  createWorkflow: (input: unknown) => createWorkflowMock(input),
}));

import type { Command, Workflow } from "../types";
import type { ProcMixExport } from "../utils/dataTransfer";
import { EXPORT_VERSION } from "../utils/dataTransfer";
import { applyImport } from "./dataImport";

function command(id: string, overrides: Partial<Command> = {}): Command {
  return {
    id,
    name: `cmd-${id}`,
    script: "echo hi",
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 3,
    runAsAdmin: false,
    ...overrides,
  };
}

function workflow(id: string, commandId: string): Workflow {
  return {
    id,
    name: `wf-${id}`,
    nodes: [
      { id: "n-start", kind: "start", position: { x: 0, y: 0 } },
      { id: "n-cmd", kind: "command", commandId, position: { x: 120, y: 0 } },
    ],
    edges: [{ id: "e1", source: "n-start", target: "n-cmd", branch: "out" }],
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 5,
  };
}

function envelope(
  commands: Command[],
  workflows: Workflow[],
): ProcMixExport {
  return {
    version: EXPORT_VERSION,
    exportedAt: "2026-01-01T00:00:00.000Z",
    commands,
    workflows,
  };
}

afterEach(() => {
  createCommandMock.mockReset();
  createWorkflowMock.mockReset();
});

describe("applyImport", () => {
  it("creates each command and workflow and returns the counts", () => {
    createCommandMock.mockImplementation((input: { name: string }) => ({
      ...command("new"),
      name: input.name,
    }));
    createWorkflowMock.mockImplementation((input: { name: string }) => ({
      ...workflow("new", "x"),
      name: input.name,
    }));

    const result = applyImport(
      envelope([command("c1"), command("c2")], [workflow("w1", "c1")]),
    );

    expect(createCommandMock).toHaveBeenCalledTimes(2);
    expect(createWorkflowMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      commands: 2,
      renamed: 0,
      workflows: 1,
      demotedAdmin: 0,
    });
  });

  it("forces runAsAdmin to false on import and counts the demotions (M2)", () => {
    createCommandMock.mockReturnValue(command("fresh"));

    const result = applyImport(
      envelope(
        [
          command("c1", { runAsAdmin: true }),
          command("c2", { runAsAdmin: false }),
          command("c3", { runAsAdmin: true }),
        ],
        [],
      ),
    );

    // Every create input must have runAsAdmin === false, regardless of source.
    for (const call of createCommandMock.mock.calls) {
      const input = call[0] as { runAsAdmin?: boolean };
      expect(input.runAsAdmin).toBe(false);
    }
    // Two of the three commands were armed in the file → two demotions.
    expect(result.demotedAdmin).toBe(2);
  });

  it("strips store-materialised fields from the create input", () => {
    createCommandMock.mockReturnValue(command("fresh"));
    createWorkflowMock.mockReturnValue(workflow("fresh", "x"));

    applyImport(envelope([command("c1")], []));

    const input = createCommandMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(input).not.toHaveProperty("id");
    expect(input).not.toHaveProperty("createdAt");
    expect(input).not.toHaveProperty("updatedAt");
    expect(input).not.toHaveProperty("runCount");
    // Editable fields are carried through.
    expect(input.script).toBe("echo hi");
  });

  it("remaps a workflow node's commandId to the freshly imported command id", () => {
    // The store assigns a brand-new id; simulate that here.
    createCommandMock.mockReturnValue(command("NEW-CMD-ID"));
    createWorkflowMock.mockImplementation((input: unknown) => ({
      ...(input as Workflow),
      id: "NEW-WF-ID",
    }));

    // Workflow node points at the OLD command id "c1".
    applyImport(envelope([command("c1")], [workflow("w1", "c1")]));

    const wfInput = createWorkflowMock.mock.calls[0]?.[0] as Workflow;
    const cmdNode = wfInput.nodes.find((n) => n.kind === "command");
    // After remap it must reference the NEW command id, not the old one.
    expect(cmdNode?.commandId).toBe("NEW-CMD-ID");
  });

  it("leaves a node's commandId untouched when the command was not in the import", () => {
    createWorkflowMock.mockImplementation((input: unknown) => ({
      ...(input as Workflow),
      id: "NEW-WF-ID",
    }));

    // No commands imported, but the workflow references "ghost".
    applyImport(envelope([], [workflow("w1", "ghost")]));

    const wfInput = createWorkflowMock.mock.calls[0]?.[0] as Workflow;
    const cmdNode = wfInput.nodes.find((n) => n.kind === "command");
    expect(cmdNode?.commandId).toBe("ghost");
  });

  it("re-keys to a fresh id even when the imported command id collides with an existing one, and the workflow follows", () => {
    // Simulate the store ALWAYS minting a brand-new id (its real behaviour),
    // so importing a command whose id "c1" already exists in the store does
    // NOT overwrite it — a duplicate is created under a new id. The mock
    // returns a generated id distinct from the imported "c1".
    let counter = 0;
    createCommandMock.mockImplementation(() => command(`store-gen-${++counter}`));
    createWorkflowMock.mockImplementation((input: unknown) => ({
      ...(input as Workflow),
      id: "NEW-WF-ID",
    }));

    // The file's command id "c1" intentionally clashes with a hypothetical
    // existing store entry; the workflow node points at that same "c1".
    applyImport(envelope([command("c1")], [workflow("w1", "c1")]));

    // The command was created (a duplicate, new id) — never an overwrite of id.
    const cmdInput = createCommandMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(cmdInput).not.toHaveProperty("id");

    // The workflow node is remapped to the freshly-generated id, not "c1".
    const wfInput = createWorkflowMock.mock.calls[0]?.[0] as Workflow;
    const cmdNode = wfInput.nodes.find((n) => n.kind === "command");
    expect(cmdNode?.commandId).toBe("store-gen-1");
    expect(cmdNode?.commandId).not.toBe("c1");
  });

  it("imports only the selected subset of commands and workflows", () => {
    createCommandMock.mockImplementation(() => command("fresh"));
    createWorkflowMock.mockImplementation((input: unknown) => ({
      ...(input as Workflow),
      id: "NEW-WF-ID",
    }));

    const result = applyImport(
      envelope(
        [command("c1"), command("c2")],
        [workflow("w1", "c1"), workflow("w2", "c2")],
      ),
      {
        commandIds: new Set(["c1"]),
        workflowIds: new Set(["w2"]),
        rename: new Map(),
      },
    );

    // Only c1 created, only w2 created — the rest is filtered out.
    expect(createCommandMock).toHaveBeenCalledTimes(1);
    expect(createWorkflowMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      commands: 1,
      renamed: 0,
      workflows: 1,
      demotedAdmin: 0,
    });
  });

  it("creates a renamed name-duplicate under the resolved name (never overwrites)", () => {
    createCommandMock.mockImplementation((input: { name: string }) => ({
      ...command("NEW-CMD-ID"),
      name: input.name,
    }));
    createWorkflowMock.mockImplementation((input: unknown) => ({
      ...(input as Workflow),
      id: "NEW-WF-ID",
    }));

    const result = applyImport(
      envelope([command("c1", { name: "Deploy" })], [workflow("w1", "c1")]),
      {
        commandIds: new Set(["c1"]),
        workflowIds: new Set(["w1"]),
        rename: new Map([["c1", "Deploy (2)"]]),
      },
    );

    // A fresh command is created under the new name — no overwrite path exists.
    expect(createCommandMock).toHaveBeenCalledTimes(1);
    const input = createCommandMock.mock.calls[0]?.[0] as { name: string };
    expect(input.name).toBe("Deploy (2)");

    // The workflow node remaps to the freshly created command id.
    const wfInput = createWorkflowMock.mock.calls[0]?.[0] as Workflow;
    const cmdNode = wfInput.nodes.find((n) => n.kind === "command");
    expect(cmdNode?.commandId).toBe("NEW-CMD-ID");

    expect(result).toEqual({
      commands: 1,
      renamed: 1,
      workflows: 1,
      demotedAdmin: 0,
    });
  });

  it("keeps the original name when an imported command is not in the rename map", () => {
    createCommandMock.mockImplementation((input: { name: string }) => ({
      ...command("FRESH"),
      name: input.name,
    }));

    const result = applyImport(envelope([command("c1", { name: "Solo" })], []), {
      commandIds: new Set(["c1"]),
      workflowIds: new Set(),
      rename: new Map(),
    });

    const input = createCommandMock.mock.calls[0]?.[0] as { name: string };
    expect(input.name).toBe("Solo");
    expect(result).toEqual({
      commands: 1,
      renamed: 0,
      workflows: 0,
      demotedAdmin: 0,
    });
  });
});
