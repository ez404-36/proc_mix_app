import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the inputs each create* receives so we can assert the slug was
// cleared on a colliding import. The mocks echo a fresh record back.
const createCommandMock = vi.fn();
const createWorkflowMock = vi.fn();
const updateCommandMock = vi.fn();

vi.mock("./commandActions", () => ({
  createCommand: (input: unknown) => createCommandMock(input),
  updateCommand: (id: string, patch: unknown) => updateCommandMock(id, patch),
}));
vi.mock("./workflowActions", () => ({
  createWorkflow: (input: unknown) => createWorkflowMock(input),
}));

import type { Command, Workflow } from "../types";
import type { ProcMixExport } from "../utils/dataTransfer";
import { EXPORT_VERSION } from "../utils/dataTransfer";
import { applyImport } from "./dataImport";
import { useCommandStore } from "../stores/commandStore";
import { useWorkflowStore } from "../stores/workflowStore";

function command(id: string, overrides: Partial<Command> = {}): Command {
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
    ...overrides,
  };
}

function workflow(id: string, overrides: Partial<Workflow> = {}): Workflow {
  return {
    id,
    name: `wf-${id}`,
    nodes: [{ id: "n-start", kind: "start", position: { x: 0, y: 0 } }],
    edges: [],
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
    ...overrides,
  };
}

function envelope(commands: Command[], workflows: Workflow[]): ProcMixExport {
  return {
    version: EXPORT_VERSION,
    exportedAt: "2026-01-01T00:00:00.000Z",
    commands,
    workflows,
  };
}

beforeEach(() => {
  createCommandMock.mockReset();
  createWorkflowMock.mockReset();
  updateCommandMock.mockReset();
  createCommandMock.mockImplementation((input: { name: string }) => ({
    ...command("new"),
    name: input.name,
  }));
  createWorkflowMock.mockImplementation((input: { name: string }) => ({
    ...workflow("new"),
    name: input.name,
  }));
  // Seed the stores with one existing command slug and one workflow slug.
  useCommandStore.setState({
    commands: [command("existing", { apiSlug: "taken-cmd", apiEnabled: true })],
  });
  useWorkflowStore.setState({
    workflows: [workflow("existing", { apiSlug: "taken-wf", apiEnabled: true })],
  });
});

describe("applyImport API-slug conflict resolution", () => {
  it("clears a command slug that collides with an existing one and counts it", () => {
    const result = applyImport(
      envelope(
        [command("c1", { apiSlug: "taken-cmd", apiEnabled: true })],
        [],
      ),
    );

    expect(result.clearedApiSlugs).toBe(1);
    const input = createCommandMock.mock.calls[0]?.[0] as {
      apiSlug?: string;
      apiEnabled?: boolean;
    };
    expect(input.apiSlug).toBeUndefined();
    expect(input.apiEnabled).toBe(false);
  });

  it("keeps a non-colliding command slug intact", () => {
    const result = applyImport(
      envelope(
        [command("c1", { apiSlug: "free-cmd", apiEnabled: true })],
        [],
      ),
    );

    expect(result.clearedApiSlugs).toBe(0);
    const input = createCommandMock.mock.calls[0]?.[0] as {
      apiSlug?: string;
      apiEnabled?: boolean;
    };
    expect(input.apiSlug).toBe("free-cmd");
    expect(input.apiEnabled).toBe(true);
  });

  it("clears a workflow slug that collides with an existing one", () => {
    const result = applyImport(
      envelope(
        [],
        [workflow("w1", { apiSlug: "taken-wf", apiEnabled: true })],
      ),
    );

    expect(result.clearedApiSlugs).toBe(1);
    const input = createWorkflowMock.mock.calls[0]?.[0] as {
      apiSlug?: string;
      apiEnabled?: boolean;
    };
    expect(input.apiSlug).toBeUndefined();
    expect(input.apiEnabled).toBe(false);
  });

  it("treats command and workflow slug namespaces separately", () => {
    // A workflow whose slug equals a COMMAND's taken slug is NOT a conflict.
    const result = applyImport(
      envelope(
        [],
        [workflow("w1", { apiSlug: "taken-cmd", apiEnabled: true })],
      ),
    );
    expect(result.clearedApiSlugs).toBe(0);
    const input = createWorkflowMock.mock.calls[0]?.[0] as { apiSlug?: string };
    expect(input.apiSlug).toBe("taken-cmd");
  });
});
