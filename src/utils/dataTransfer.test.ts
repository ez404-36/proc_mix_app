import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import type { Command, Workflow } from "../types";
import {
  EXPORT_VERSION,
  exportData,
  importData,
  InvalidImportError,
  isProcMixExport,
  type ProcMixExport,
} from "./dataTransfer";

function sampleCommand(id = "cmd-1"): Command {
  return {
    id,
    name: "Build",
    script: "echo build",
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
    runAsAdmin: false,
    sound: { success: { enabled: true, soundId: "builtin:chime" } },
  };
}

function sampleWorkflow(id = "wf-1"): Workflow {
  return {
    id,
    name: "Deploy",
    nodes: [
      { id: "n-start", kind: "start", position: { x: 0, y: 0 } },
      {
        id: "n-cmd",
        kind: "command",
        commandId: "cmd-1",
        position: { x: 120, y: 0 },
      },
    ],
    edges: [{ id: "e1", source: "n-start", target: "n-cmd", branch: "out" }],
    tags: [],
    favorite: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 0,
    sound: { error: { enabled: true, soundId: "builtin:buzz" } },
  };
}

function sampleEnvelope(): ProcMixExport {
  return {
    version: EXPORT_VERSION,
    exportedAt: "2026-01-01T00:00:00.000Z",
    commands: [sampleCommand()],
    workflows: [sampleWorkflow()],
  };
}

afterEach(() => {
  invokeMock.mockReset();
});

describe("isProcMixExport", () => {
  it("accepts a well-formed envelope", () => {
    expect(isProcMixExport(sampleEnvelope())).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(isProcMixExport(null)).toBe(false);
    expect(isProcMixExport("nope")).toBe(false);
    expect(isProcMixExport([])).toBe(false);
  });

  it("rejects the wrong version", () => {
    expect(isProcMixExport({ ...sampleEnvelope(), version: 2 })).toBe(false);
  });

  it("rejects missing arrays", () => {
    const { commands: _c, ...noCommands } = sampleEnvelope();
    expect(isProcMixExport(noCommands)).toBe(false);
    const { workflows: _w, ...noWorkflows } = sampleEnvelope();
    expect(isProcMixExport(noWorkflows)).toBe(false);
  });

  it("rejects a malformed command inside the array", () => {
    const bad = sampleEnvelope();
    const broken = { ...bad, commands: [{ id: "x", name: "no-script" }] };
    expect(isProcMixExport(broken)).toBe(false);
  });

  it("rejects a workflow with a malformed node", () => {
    const bad = sampleEnvelope();
    const broken = {
      ...bad,
      workflows: [{ ...sampleWorkflow(), nodes: [{ id: "n" }] }],
    };
    expect(isProcMixExport(broken)).toBe(false);
  });

  it("accepts a command whose tags is a non-empty array of strings", () => {
    const envelope = sampleEnvelope();
    const withTags = {
      ...envelope,
      commands: [{ ...sampleCommand(), tags: ["build", "ci"] }],
    };
    // Every tag is a string → the isStringArray predicate holds for each.
    expect(isProcMixExport(withTags)).toBe(true);
  });

  it("rejects a command whose tags array contains a non-string element", () => {
    const envelope = sampleEnvelope();
    const badTags = {
      ...envelope,
      commands: [{ ...sampleCommand(), tags: ["ok", 42] }],
    };
    // The non-string element makes the isStringArray predicate fail.
    expect(isProcMixExport(badTags)).toBe(false);
  });
});

describe("exportData", () => {
  it("builds the envelope and invokes export_data with the stringified payload", async () => {
    invokeMock.mockResolvedValue(true);
    const commands = [sampleCommand()];
    const workflows = [sampleWorkflow()];

    const result = await exportData(commands, workflows);

    expect(result).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = invokeMock.mock.calls[0] as [
      string,
      { payload: string },
    ];
    expect(cmd).toBe("export_data");
    const parsed: unknown = JSON.parse(args.payload);
    expect(isProcMixExport(parsed)).toBe(true);
    const envelope = parsed as ProcMixExport;
    expect(envelope.version).toBe(EXPORT_VERSION);
    expect(envelope.commands).toHaveLength(1);
    expect(envelope.workflows).toHaveLength(1);
    // Regression: schedules are local to a machine's clock and must never
    // be part of the export bundle.
    expect(parsed).not.toHaveProperty("schedules");
    // Per-install state is stripped from the export; the definition + the
    // id reference key are kept.
    const exportedCmd = envelope.commands[0] as Record<string, unknown>;
    expect(exportedCmd).not.toHaveProperty("favorite");
    expect(exportedCmd).not.toHaveProperty("runCount");
    expect(exportedCmd).not.toHaveProperty("lastRunAt");
    expect(exportedCmd).not.toHaveProperty("createdAt");
    expect(exportedCmd).not.toHaveProperty("updatedAt");
    // The per-entity sound config is a local preference, not portable, and
    // must never be written to the export bundle.
    expect(exportedCmd).not.toHaveProperty("sound");
    expect(exportedCmd.id).toBe("cmd-1");
    expect(exportedCmd.script).toBe("echo build");
    const exportedWf = envelope.workflows[0] as Record<string, unknown>;
    expect(exportedWf).not.toHaveProperty("favorite");
    expect(exportedWf).not.toHaveProperty("runCount");
    expect(exportedWf).not.toHaveProperty("createdAt");
    expect(exportedWf).not.toHaveProperty("sound");
  });

  it("propagates the cancel result (false)", async () => {
    invokeMock.mockResolvedValue(false);
    await expect(exportData([], [])).resolves.toBe(false);
  });
});

describe("importData", () => {
  it("returns null when the user cancelled (Rust returned null)", async () => {
    invokeMock.mockResolvedValue(null);
    await expect(importData()).resolves.toBeNull();
  });

  it("parses and validates a good document", async () => {
    invokeMock.mockResolvedValue(JSON.stringify(sampleEnvelope()));
    const result = await importData();
    expect(result).not.toBeNull();
    expect(result?.commands).toHaveLength(1);
    expect(result?.workflows).toHaveLength(1);
  });

  it("throws InvalidImportError on non-JSON input", async () => {
    invokeMock.mockResolvedValue("{ not json");
    await expect(importData()).rejects.toBeInstanceOf(InvalidImportError);
  });

  it("throws InvalidImportError on valid JSON that is not an export", async () => {
    invokeMock.mockResolvedValue(JSON.stringify({ hello: "world" }));
    await expect(importData()).rejects.toBeInstanceOf(InvalidImportError);
  });
});
