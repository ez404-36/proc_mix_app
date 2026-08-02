import { afterEach, describe, expect, it, vi } from "vitest";

const createCommandMock = vi.fn();
const createWorkflowMock = vi.fn();
const createMiniAppMock = vi.fn();
const updateCommandMock = vi.fn();

vi.mock("./commandActions", () => ({
  createCommand: (input: unknown) => createCommandMock(input),
  updateCommand: (id: string, patch: unknown) =>
    updateCommandMock(id, patch),
  existingCommandApiSlugs: () => new Set<string>(),
}));
vi.mock("./miniappActions", () => ({
  createMiniApp: (input: unknown) => createMiniAppMock(input),
}));
vi.mock("./workflowActions", () => ({
  createWorkflow: (input: unknown) => createWorkflowMock(input),
  existingWorkflowApiSlugs: () => new Set<string>(),
}));

import type { Command, MiniApp, Workflow } from "../types";
import type { ProcMixExport } from "../utils/dataTransfer";
import { EXPORT_VERSION, isProcMixExport } from "../utils/dataTransfer";
import { applyImport } from "./dataImport";

/**
 * Build a `ProcMixExport` from a raw JSON document, narrowed by the REAL file
 * guard. This is how a malformed-but-accepted file is produced in these tests:
 * `isExportedMiniApp` deliberately validates only the envelope shape (id / name
 * / widgets array / tags), not the deep discriminated widget union, so a widget
 * with an unknown `kind` — or a missing `layout` — passes the guard and reaches
 * the importer exactly as it would in production. Going through the guard keeps
 * this type-safe without a cast.
 */
function parseEnvelope(raw: string): ProcMixExport {
  const parsed: unknown = JSON.parse(raw);
  if (!isProcMixExport(parsed)) {
    throw new Error("test fixture is not a valid ProcMixExport");
  }
  return parsed;
}

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

function miniApp(id: string, commandId = "c1"): MiniApp {
  return {
    id,
    name: `ma-${id}`,
    panelSize: { w: 400, h: 320 },
    widgets: [
      {
        id: "w-btn",
        kind: "button",
        layout: { x: 0, y: 0, w: 140, h: 44 },
        label: "Run",
        action: { kind: "commandRef", commandId },
      },
    ],
    tags: [],
    favorite: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 4,
    lastRunAt: "2026-01-02T00:00:00.000Z",
  };
}

function envelope(
  commands: Command[],
  workflows: Workflow[],
  miniapps: MiniApp[] = [],
): ProcMixExport {
  return {
    version: EXPORT_VERSION,
    exportedAt: "2026-01-01T00:00:00.000Z",
    commands,
    workflows,
    ...(miniapps.length > 0 ? { miniapps } : {}),
  };
}

afterEach(() => {
  createCommandMock.mockReset();
  createWorkflowMock.mockReset();
  createMiniAppMock.mockReset();
  updateCommandMock.mockReset();
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
      miniapps: 0,
      demotedAdmin: 0,
      clearedApiSlugs: 0,
      miniappsFailed: 0,
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

  it("drops a sound config that a legacy export file still carries", () => {
    createCommandMock.mockReturnValue(command("fresh"));
    createWorkflowMock.mockImplementation((input: unknown) => ({
      ...(input as Workflow),
      id: "NEW-WF-ID",
    }));

    // Sound is no longer exported, but an older bundle may still contain it.
    // The importer must strip it so it never leaks into the new record.
    applyImport(
      envelope(
        [
          command("c1", {
            sound: { success: { enabled: true, soundId: "builtin:chime" } },
          }),
        ],
        [
          {
            ...workflow("w1", "c1"),
            sound: { error: { enabled: true, soundId: "builtin:buzz" } },
          },
        ],
      ),
    );

    const cmdInput = createCommandMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(cmdInput).not.toHaveProperty("sound");
    const wfInput = createWorkflowMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(wfInput).not.toHaveProperty("sound");
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
        miniappIds: new Set(),
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
      miniapps: 0,
      demotedAdmin: 0,
      clearedApiSlugs: 0,
      miniappsFailed: 0,
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
        miniappIds: new Set(),
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
      miniapps: 0,
      demotedAdmin: 0,
      clearedApiSlugs: 0,
      miniappsFailed: 0,
    });
  });

  it("remaps a local command's workflowId to the imported workflow's new id", () => {
    // The imported local command references OLD workflow id "w1"; the store
    // mints "NEW-CMD" for it. The workflow is created with a fresh "NEW-WF".
    createCommandMock.mockImplementation((input: unknown) => ({
      ...command("NEW-CMD"),
      ...(input as Partial<Command>),
      id: "NEW-CMD",
    }));
    createWorkflowMock.mockImplementation((input: unknown) => ({
      ...(input as Workflow),
      id: "NEW-WF",
    }));

    applyImport(
      envelope(
        [command("c-local", { scope: "local", workflowId: "w1" })],
        [workflow("w1", "c-local")],
      ),
    );

    // After workflows are created, the local command is re-pointed at the
    // NEW workflow id via updateCommand.
    expect(updateCommandMock).toHaveBeenCalledWith("NEW-CMD", {
      workflowId: "NEW-WF",
    });
  });

  it("does not remap a local command whose owning workflow was not imported", () => {
    createCommandMock.mockImplementation((input: unknown) => ({
      ...command("NEW-CMD"),
      ...(input as Partial<Command>),
      id: "NEW-CMD",
    }));

    // Local command references "w-ghost", but no workflow is imported.
    applyImport(
      envelope([command("c-local", { scope: "local", workflowId: "w-ghost" })], []),
    );

    expect(updateCommandMock).not.toHaveBeenCalled();
  });

  it("keeps the original name when an imported command is not in the rename map", () => {
    createCommandMock.mockImplementation((input: { name: string }) => ({
      ...command("FRESH"),
      name: input.name,
    }));

    const result = applyImport(envelope([command("c1", { name: "Solo" })], []), {
      commandIds: new Set(["c1"]),
      workflowIds: new Set(),
      miniappIds: new Set(),
      rename: new Map(),
    });

    const input = createCommandMock.mock.calls[0]?.[0] as { name: string };
    expect(input.name).toBe("Solo");
    expect(result).toEqual({
      commands: 1,
      renamed: 0,
      workflows: 0,
      miniapps: 0,
      demotedAdmin: 0,
      clearedApiSlugs: 0,
      miniappsFailed: 0,
    });
  });

  it("creates each mini-app and reports the count", () => {
    createCommandMock.mockReturnValue(command("NEW-CMD"));
    createMiniAppMock.mockImplementation((input: unknown) => ({
      ...(input as MiniApp),
      id: "NEW-MA",
    }));

    const result = applyImport(
      envelope(
        [command("c1")],
        [],
        [miniApp("m1", "c1"), miniApp("m2", "c1")],
      ),
    );

    expect(createMiniAppMock).toHaveBeenCalledTimes(2);
    expect(result.miniapps).toBe(2);
  });

  it("remaps a mini-app widget's commandRef to the freshly imported command id", () => {
    createCommandMock.mockReturnValue(command("NEW-CMD"));
    createMiniAppMock.mockImplementation((input: unknown) => ({
      ...(input as MiniApp),
      id: "NEW-MA",
    }));

    // The button action references the OLD command id "c1".
    applyImport(envelope([command("c1")], [], [miniApp("m1", "c1")]));

    const maInput = createMiniAppMock.mock.calls[0]?.[0] as MiniApp;
    const btn = maInput.widgets[0];
    if (btn.kind !== "button") throw new Error("expected button widget");
    expect(btn.action).toEqual({
      kind: "commandRef",
      commandId: "NEW-CMD",
    });
  });

  it("leaves a commandRef untouched when the referenced command was not imported", () => {
    createMiniAppMock.mockImplementation((input: unknown) => ({
      ...(input as MiniApp),
      id: "NEW-MA",
    }));

    // No commands imported; the mini-app references "ghost".
    applyImport(envelope([], [], [miniApp("m1", "ghost")]));

    const maInput = createMiniAppMock.mock.calls[0]?.[0] as MiniApp;
    const btn = maInput.widgets[0];
    if (btn.kind !== "button") throw new Error("expected button widget");
    expect(btn.action).toEqual({
      kind: "commandRef",
      commandId: "ghost",
    });
  });

  it("forces runAsAdmin to false on inline mini-app actions and counts the demotions", () => {
    createMiniAppMock.mockImplementation((input: unknown) => ({
      ...(input as MiniApp),
      id: "NEW-MA",
    }));

    const armed: MiniApp = {
      id: "m1",
      name: "armed",
      panelSize: { w: 400, h: 320 },
      widgets: [
        {
          id: "w-btn",
          kind: "button",
          layout: { x: 0, y: 0, w: 140, h: 44 },
          label: "Run",
          action: {
            kind: "inline",
            name: "do",
            script: "echo hi",
            runAsAdmin: true,
          },
        },
      ],
      tags: [],
      favorite: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      runCount: 0,
    };

    const result = applyImport(envelope([], [], [armed]));

    const maInput = createMiniAppMock.mock.calls[0]?.[0] as MiniApp;
    const btn = maInput.widgets[0];
    if (btn.kind !== "button" || btn.action.kind !== "inline") {
      throw new Error("expected inline button action");
    }
    expect(btn.action.runAsAdmin).toBe(false);
    // One armed inline action was demoted.
    expect(result.demotedAdmin).toBe(1);
  });

  it("counts multiple demoted inline actions across a toggle's two actions", () => {
    createMiniAppMock.mockImplementation((input: unknown) => ({
      ...(input as MiniApp),
      id: "NEW-MA",
    }));

    const toggle: MiniApp = {
      id: "m1",
      name: "t",
      panelSize: { w: 400, h: 320 },
      widgets: [
        {
          id: "w-tog",
          kind: "toggle",
          layout: { x: 0, y: 0, w: 160, h: 44 },
          label: "T",
          onAction: {
            kind: "inline",
            name: "on",
            script: "on",
            runAsAdmin: true,
          },
          offAction: {
            kind: "inline",
            name: "off",
            script: "off",
            runAsAdmin: true,
          },
        },
      ],
      tags: [],
      favorite: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      runCount: 0,
    };

    const result = applyImport(envelope([], [], [toggle]));

    const maInput = createMiniAppMock.mock.calls[0]?.[0] as MiniApp;
    const tog = maInput.widgets[0];
    if (tog.kind !== "toggle") throw new Error("expected toggle widget");
    if (tog.onAction.kind !== "inline" || tog.offAction.kind !== "inline") {
      throw new Error("expected inline toggle actions");
    }
    expect(tog.onAction.runAsAdmin).toBe(false);
    expect(tog.offAction.runAsAdmin).toBe(false);
    // Both armed inline actions were demoted → counts as 2 (per-action).
    expect(result.demotedAdmin).toBe(2);
  });

  it("strips store-materialised fields and resets favorite to false", () => {
    createMiniAppMock.mockImplementation((input: unknown) => ({
      ...(input as MiniApp),
      id: "NEW-MA",
    }));

    applyImport(envelope([], [], [miniApp("m1")]));

    const maInput = createMiniAppMock.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(maInput).not.toHaveProperty("id");
    expect(maInput).not.toHaveProperty("createdAt");
    expect(maInput).not.toHaveProperty("updatedAt");
    expect(maInput).not.toHaveProperty("runCount");
    expect(maInput).not.toHaveProperty("lastRunAt");
    // The source had favorite: true; the import forces it to false.
    expect(maInput.favorite).toBe(false);
  });

  it("remaps a status widget's commandRef source", () => {
    createCommandMock.mockReturnValue(command("NEW-CMD"));
    createMiniAppMock.mockImplementation((input: unknown) => ({
      ...(input as MiniApp),
      id: "NEW-MA",
    }));

    const statusMa: MiniApp = {
      id: "m1",
      name: "s",
      panelSize: { w: 400, h: 320 },
      widgets: [
        {
          id: "w-st",
          kind: "status",
          layout: { x: 0, y: 0, w: 220, h: 60 },
          label: "S",
          source: { kind: "commandRef", commandId: "c1" },
          intervalMs: 5000,
          mapping: { mode: "raw" },
        },
      ],
      tags: [],
      favorite: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      runCount: 0,
    };

    applyImport(envelope([command("c1")], [], [statusMa]));

    const maInput = createMiniAppMock.mock.calls[0]?.[0] as MiniApp;
    const st = maInput.widgets[0];
    if (st.kind !== "status") throw new Error("expected status widget");
    expect(st.source).toEqual({ kind: "commandRef", commandId: "NEW-CMD" });
  });

  it("imports only the selected mini-apps", () => {
    createMiniAppMock.mockImplementation((input: unknown) => ({
      ...(input as MiniApp),
      id: "NEW-MA",
    }));

    const result = applyImport(
      envelope([], [], [miniApp("m1"), miniApp("m2"), miniApp("m3")]),
      {
        commandIds: new Set(),
        workflowIds: new Set(),
        miniappIds: new Set(["m2"]),
        rename: new Map(),
      },
    );

    expect(createMiniAppMock).toHaveBeenCalledTimes(1);
    const maInput = createMiniAppMock.mock.calls[0]?.[0] as MiniApp;
    expect(maInput.name).toBe("ma-m2");
    expect(result.miniapps).toBe(1);
  });

  it("imports every mini-app when no selection is supplied (legacy path)", () => {
    createMiniAppMock.mockImplementation((input: unknown) => ({
      ...(input as MiniApp),
      id: "NEW-MA",
    }));

    const result = applyImport(envelope([], [], [miniApp("m1"), miniApp("m2")]));

    expect(createMiniAppMock).toHaveBeenCalledTimes(2);
    expect(result.miniapps).toBe(2);
  });

  // --- C3: an unknown widget kind must not abort the import ----------------

  it("passes an unknown widget kind through instead of throwing (C3)", () => {
    createCommandMock.mockReturnValue(command("NEW-CMD"));
    createMiniAppMock.mockImplementation((input: unknown) => ({
      ...(input as MiniApp),
      id: "NEW-MA",
    }));

    // A file written by a NEWER ProcMix with a fifth widget kind. The envelope
    // guard accepts it (it validates only the mini-app's outer shape), so it
    // reaches `remapWidget` — which used to fall off the end of its switch and
    // return `undefined`, crashing the caller's destructure.
    const parsed = parseEnvelope(
      JSON.stringify({
        version: EXPORT_VERSION,
        exportedAt: "2026-01-01T00:00:00.000Z",
        commands: [],
        workflows: [],
        miniapps: [
          {
            id: "m1",
            name: "future",
            panelSize: { w: 400, h: 320 },
            tags: [],
            widgets: [
              {
                id: "w-future",
                kind: "gauge",
                layout: { x: 8, y: 8, w: 120, h: 64 },
                label: "Gauge",
              },
            ],
          },
        ],
      }),
    );

    const result = applyImport(parsed);

    expect(result.miniappsFailed).toBe(0);
    expect(result.miniapps).toBe(1);
    const maInput = createMiniAppMock.mock.calls[0]?.[0] as MiniApp;
    // The widget survives verbatim (id + kind preserved for traceability).
    const raw = maInput.widgets[0] as unknown as {
      id: string;
      kind: string;
      label: string;
    };
    expect(raw.id).toBe("w-future");
    expect(raw.kind).toBe("gauge");
    expect(raw.label).toBe("Gauge");
  });

  it("does not abort the whole import when a mini-app is malformed (C3)", () => {
    createCommandMock.mockReturnValue(command("NEW-CMD"));
    createWorkflowMock.mockImplementation((input: unknown) => ({
      ...(input as Workflow),
      id: "NEW-WF",
    }));
    createMiniAppMock.mockImplementation((input: unknown) => ({
      ...(input as MiniApp),
      id: "NEW-MA",
    }));

    // The middle mini-app has a toggle with NO `onAction` — the guard cannot
    // catch that (it does not walk the widget union) so building its input
    // throws. It must cost only itself: the commands/workflows were already
    // written to SQLite by the time mini-apps are processed, so aborting here
    // would leave a partially-applied import reported as a total failure.
    const parsed = parseEnvelope(
      JSON.stringify({
        version: EXPORT_VERSION,
        exportedAt: "2026-01-01T00:00:00.000Z",
        commands: [command("c1")],
        workflows: [workflow("w1", "c1")],
        miniapps: [
          { ...miniApp("good-1"), id: "good-1" },
          {
            id: "bad",
            name: "broken",
            panelSize: { w: 400, h: 320 },
            tags: [],
            widgets: [
              {
                id: "w-tog",
                kind: "toggle",
                layout: { x: 0, y: 0, w: 160, h: 44 },
                label: "T",
              },
            ],
          },
          { ...miniApp("good-2"), id: "good-2" },
        ],
      }),
    );

    const result = applyImport(parsed);

    // The good mini-apps on BOTH sides of the bad one were created.
    expect(createMiniAppMock).toHaveBeenCalledTimes(2);
    expect(result.miniapps).toBe(2);
    expect(result.miniappsFailed).toBe(1);
    // …and the commands/workflows are unaffected.
    expect(result.commands).toBe(1);
    expect(result.workflows).toBe(1);
  });

  // --- S5: geometry is clamped on import -----------------------------------

  it("clamps an oversized panelSize to the renderable maximum (S5)", () => {
    createMiniAppMock.mockImplementation((input: unknown) => ({
      ...(input as MiniApp),
      id: "NEW-MA",
    }));

    // Authored on a 2560px display — it would overflow a normal window.
    const huge: MiniApp = {
      ...miniApp("m1"),
      panelSize: { w: 1800, h: 1200 },
    };

    applyImport(envelope([], [], [huge]));

    const maInput = createMiniAppMock.mock.calls[0]?.[0] as MiniApp;
    expect(maInput.panelSize).toEqual({ w: 1200, h: 900 });
  });

  it("clamps an undersized panelSize up to the editor minimum (S5)", () => {
    createMiniAppMock.mockImplementation((input: unknown) => ({
      ...(input as MiniApp),
      id: "NEW-MA",
    }));

    const tiny: MiniApp = { ...miniApp("m1"), panelSize: { w: 10, h: 4 } };

    applyImport(envelope([], [], [tiny]));

    const maInput = createMiniAppMock.mock.calls[0]?.[0] as MiniApp;
    expect(maInput.panelSize).toEqual({ w: 200, h: 160 });
  });

  it("leaves a panelSize that is already in range untouched (S5)", () => {
    createMiniAppMock.mockImplementation((input: unknown) => ({
      ...(input as MiniApp),
      id: "NEW-MA",
    }));

    applyImport(envelope([], [], [miniApp("m1")]));

    const maInput = createMiniAppMock.mock.calls[0]?.[0] as MiniApp;
    expect(maInput.panelSize).toEqual({ w: 400, h: 320 });
  });

  it("clamps a widget whose layout falls outside the panel (S5)", () => {
    createMiniAppMock.mockImplementation((input: unknown) => ({
      ...(input as MiniApp),
      id: "NEW-MA",
    }));

    // The panel clamps to 1200×900; the widget is placed far beyond it and is
    // wider than the panel, so both its size and its origin must be pulled in.
    const stray: MiniApp = {
      ...miniApp("m1"),
      panelSize: { w: 1800, h: 1200 },
      widgets: [
        {
          id: "w-btn",
          kind: "button",
          layout: { x: 99999, y: 99999, w: 5000, h: 4000 },
          label: "Run",
          action: { kind: "commandRef", commandId: "ghost" },
        },
      ],
    };

    applyImport(envelope([], [], [stray]));

    const maInput = createMiniAppMock.mock.calls[0]?.[0] as MiniApp;
    // Size capped to the clamped panel, origin pulled back to the top-left.
    expect(maInput.widgets[0]?.layout).toEqual({
      x: 0,
      y: 0,
      w: 1200,
      h: 900,
    });
  });

  it("leaves a widget layout that already fits inside the panel untouched (S5)", () => {
    createMiniAppMock.mockImplementation((input: unknown) => ({
      ...(input as MiniApp),
      id: "NEW-MA",
    }));

    applyImport(envelope([], [], [miniApp("m1")]));

    const maInput = createMiniAppMock.mock.calls[0]?.[0] as MiniApp;
    expect(maInput.widgets[0]?.layout).toEqual({ x: 0, y: 0, w: 140, h: 44 });
  });
});
