import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import type { Command, MiniApp, Workflow } from "../types";
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

function sampleMiniApp(id = "ma-1"): MiniApp {
  return {
    id,
    name: "VPN panel",
    panelSize: { w: 400, h: 320 },
    widgets: [
      {
        id: "w-btn",
        kind: "button",
        layout: { x: 0, y: 0, w: 140, h: 44 },
        label: "Connect",
        action: { kind: "commandRef", commandId: "cmd-1" },
      },
    ],
    tags: [],
    favorite: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runCount: 7,
    lastRunAt: "2026-01-02T00:00:00.000Z",
  };
}

/** A mini-app carrying one artifact of each variant, all with a value set. */
function miniAppWithArtifacts(): MiniApp {
  return {
    ...sampleMiniApp("ma-secrets"),
    widgets: [
      {
        id: "w-secret",
        kind: "artifact",
        layout: { x: 0, y: 0, w: 200, h: 44 },
        name: "apiToken",
        label: "API token",
        value: "s3cr3t-token",
        variant: "secret",
      },
      {
        id: "w-path",
        kind: "artifact",
        layout: { x: 0, y: 60, w: 200, h: 44 },
        name: "configPath",
        label: "Config",
        value: "/etc/openvpn3/my.conf",
        variant: "path",
      },
      {
        id: "w-text",
        kind: "artifact",
        layout: { x: 0, y: 120, w: 200, h: 44 },
        name: "region",
        label: "Region",
        value: "eu-west-1",
        variant: "text",
      },
    ],
  };
}

/** The exported artifact widget with the given id, as a plain record. */
function exportedArtifact(
  envelope: ProcMixExport,
  widgetId: string,
): Record<string, unknown> {
  const widget = envelope.miniapps?.[0]?.widgets.find((w) => w.id === widgetId);
  if (widget === undefined) throw new Error(`no widget ${widgetId}`);
  return widget as unknown as Record<string, unknown>;
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

  it("rejects an unknown version", () => {
    // v1 and v2 are both accepted; anything else is rejected.
    expect(isProcMixExport({ ...sampleEnvelope(), version: 3 })).toBe(false);
    expect(isProcMixExport({ ...sampleEnvelope(), version: 0 })).toBe(false);
  });

  it("accepts a v1 legacy envelope (no `miniapps` key)", () => {
    // A file exported before Mini-Apps shipped has version 1 and no miniapps.
    // It must still import, so the guard accepts it.
    const v1 = { ...sampleEnvelope(), version: 1 };
    delete (v1 as { miniapps?: unknown }).miniapps;
    expect(isProcMixExport(v1)).toBe(true);
  });

  it("accepts a v2 envelope carrying an optional `miniapps` array", () => {
    const withMiniApps: ProcMixExport = {
      ...sampleEnvelope(),
      miniapps: [sampleMiniApp()],
    };
    expect(isProcMixExport(withMiniApps)).toBe(true);
  });

  it("accepts a v2 envelope with no `miniapps` key (mini-apps are optional)", () => {
    const noMiniApps = { ...sampleEnvelope() };
    delete (noMiniApps as { miniapps?: unknown }).miniapps;
    expect(isProcMixExport(noMiniApps)).toBe(true);
  });

  it("rejects a `miniapps` array containing a malformed entry", () => {
    const bad = {
      ...sampleEnvelope(),
      miniapps: [{ id: "ma-1", name: "no-widgets" }],
    };
    expect(isProcMixExport(bad)).toBe(false);
  });

  it("rejects a `miniapps` value that is not an array", () => {
    const bad = { ...sampleEnvelope(), miniapps: { id: "ma-1" } };
    expect(isProcMixExport(bad)).toBe(false);
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

  it("omits the `miniapps` key when none are passed (compact v2 file)", async () => {
    invokeMock.mockResolvedValue(true);
    await exportData([sampleCommand()], [sampleWorkflow()], []);
    const [, args] = invokeMock.mock.calls[0] as [
      string,
      { payload: string },
    ];
    const parsed = JSON.parse(args.payload) as Record<string, unknown>;
    // No mini-apps → the key is omitted entirely, not written as `[]`.
    expect(parsed).not.toHaveProperty("miniapps");
  });

  it("includes mini-apps (per-install state stripped) when the array is non-empty", async () => {
    invokeMock.mockResolvedValue(true);
    await exportData(
      [sampleCommand()],
      [sampleWorkflow()],
      [sampleMiniApp()],
    );
    const [, args] = invokeMock.mock.calls[0] as [
      string,
      { payload: string },
    ];
    const envelope = JSON.parse(args.payload) as ProcMixExport;
    expect(envelope.miniapps).toHaveLength(1);
    const exportedMa = envelope.miniapps![0] as Record<string, unknown>;
    // Per-install state is stripped; id (the reference key) is kept.
    expect(exportedMa.id).toBe("ma-1");
    expect(exportedMa.name).toBe("VPN panel");
    expect(exportedMa).not.toHaveProperty("favorite");
    expect(exportedMa).not.toHaveProperty("runCount");
    expect(exportedMa).not.toHaveProperty("lastRunAt");
    expect(exportedMa).not.toHaveProperty("createdAt");
    expect(exportedMa).not.toHaveProperty("updatedAt");
  });

  // --- S7: secret artifact values must never reach the file ---------------

  it("blanks a secret artifact's value on export (S7)", async () => {
    invokeMock.mockResolvedValue(true);
    await exportData([], [], [miniAppWithArtifacts()]);
    const [, args] = invokeMock.mock.calls[0] as [string, { payload: string }];
    const envelope = JSON.parse(args.payload) as ProcMixExport;

    const secret = exportedArtifact(envelope, "w-secret");
    // The credential is gone…
    expect(secret.value).toBe("");
    // …but the widget is still a usable, correctly-typed input for the
    // recipient — only the VALUE is withheld.
    expect(secret.variant).toBe("secret");
    expect(secret.name).toBe("apiToken");
    expect(secret.label).toBe("API token");
  });

  it("never writes the secret string anywhere in the payload (S7)", async () => {
    invokeMock.mockResolvedValue(true);
    await exportData([], [], [miniAppWithArtifacts()]);
    const [, args] = invokeMock.mock.calls[0] as [string, { payload: string }];
    // Belt-and-braces: scan the RAW serialized document, not just the parsed
    // widget, so a future field that echoes the value is caught too.
    expect(args.payload).not.toContain("s3cr3t-token");
  });

  it("keeps non-secret artifact values (they are part of the definition) (S7)", async () => {
    invokeMock.mockResolvedValue(true);
    await exportData([], [], [miniAppWithArtifacts()]);
    const [, args] = invokeMock.mock.calls[0] as [string, { payload: string }];
    const envelope = JSON.parse(args.payload) as ProcMixExport;

    expect(exportedArtifact(envelope, "w-path").value).toBe(
      "/etc/openvpn3/my.conf",
    );
    expect(exportedArtifact(envelope, "w-text").value).toBe("eu-west-1");
  });

  it("does not mutate the source mini-app when blanking secrets (S7)", async () => {
    invokeMock.mockResolvedValue(true);
    const source = miniAppWithArtifacts();
    await exportData([], [], [source]);

    // The in-memory record the user is still editing keeps its value; only the
    // exported COPY is blanked.
    const secret = source.widgets.find((w) => w.id === "w-secret");
    if (secret?.kind !== "artifact") throw new Error("expected artifact");
    expect(secret.value).toBe("s3cr3t-token");
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
