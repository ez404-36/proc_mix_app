import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import type { Command, HistoryEvent, Workflow } from "../types";
import {
  type CommandRecord,
  type WireHistoryEvent,
  clearHistoryInDb,
  deleteHistoryEventInDb,
  eventToWire,
  getHistoryEventFromDb,
  listHistoryFromDb,
  recordHistoryEventInDb,
  updateRunHistoryEventInDb,
  wireToEvent,
} from "./historyRepository";

const sampleCommand: Command = {
  id: "cmd-1",
  name: "Greet",
  script: "echo hi",
  tags: [],
  favorite: false,
  createdAt: "2026-05-28T00:00:00Z",
  updatedAt: "2026-05-28T00:00:00Z",
  runCount: 0,
  runAsAdmin: false,
};

const sampleRecord: CommandRecord = {
  id: "cmd-1",
  name: "Greet",
  nameKey: null,
  description: null,
  descriptionKey: null,
  icon: null,
  script: "echo hi",
  shell: null,
  args: null,
  workingDir: null,
  env: null,
  tags: [],
  categoryId: null,
  favorite: false,
  createdAt: "2026-05-28T00:00:00Z",
  updatedAt: "2026-05-28T00:00:00Z",
  lastRunAt: null,
  runCount: 0,
  runAsAdmin: false,
};

describe("wireToEvent", () => {
  it("converts commandCreated and decodes snapshotAfter from null to undefined", () => {
    const wire: WireHistoryEvent = {
      id: "e1",
      createdAt: "2026-05-28T00:00:00Z",
      kind: "commandCreated",
      commandId: "cmd-1",
      commandName: "Greet",
      snapshotAfter: sampleRecord,
    };
    const evt = wireToEvent(wire);
    expect(evt.kind).toBe("commandCreated");
    if (evt.kind !== "commandCreated") throw new Error("kind narrowing");
    expect(evt.snapshotAfter.nameKey).toBeUndefined();
    expect(evt.snapshotAfter.description).toBeUndefined();
    expect(evt.snapshotAfter.shell).toBeUndefined();
  });

  it("converts commandEdited with both snapshots", () => {
    const wire: WireHistoryEvent = {
      id: "e2",
      createdAt: "2026-05-28T00:00:01Z",
      kind: "commandEdited",
      commandId: "cmd-1",
      commandName: "Greet",
      snapshotBefore: sampleRecord,
      snapshotAfter: { ...sampleRecord, name: "Greet 2" },
    };
    const evt = wireToEvent(wire);
    if (evt.kind !== "commandEdited") throw new Error("kind narrowing");
    expect(evt.snapshotBefore.name).toBe("Greet");
    expect(evt.snapshotAfter.name).toBe("Greet 2");
  });

  it("converts commandDeleted with snapshotBefore", () => {
    const wire: WireHistoryEvent = {
      id: "e3",
      createdAt: "2026-05-28T00:00:02Z",
      kind: "commandDeleted",
      commandId: "cmd-1",
      commandName: "Greet",
      snapshotBefore: sampleRecord,
    };
    const evt = wireToEvent(wire);
    if (evt.kind !== "commandDeleted") throw new Error("kind narrowing");
    expect(evt.snapshotBefore.id).toBe("cmd-1");
  });

  it("converts commandRun and collapses absent exitCode/durationMs to undefined", () => {
    const wire: WireHistoryEvent = {
      id: "e4",
      createdAt: "2026-05-28T00:00:03Z",
      kind: "commandRun",
      commandId: "cmd-1",
      commandName: "Greet",
      executionId: "exec-9",
      status: "running",
    };
    const evt = wireToEvent(wire);
    if (evt.kind !== "commandRun") throw new Error("kind narrowing");
    expect(evt.exitCode).toBeUndefined();
    expect(evt.durationMs).toBeUndefined();
    expect(evt.status).toBe("running");
  });

  it("collapses commandRun exitCode null to undefined (defensive)", () => {
    const wire: WireHistoryEvent = {
      id: "e5",
      createdAt: "2026-05-28T00:00:04Z",
      kind: "commandRun",
      commandId: "cmd-1",
      commandName: "Greet",
      executionId: "exec-9",
      exitCode: null,
      durationMs: null,
      status: "cancelled",
    };
    const evt = wireToEvent(wire);
    if (evt.kind !== "commandRun") throw new Error("kind narrowing");
    expect(evt.exitCode).toBeUndefined();
    expect(evt.durationMs).toBeUndefined();
  });

  it("keeps commandRun exitCode 0 (NOT collapse to undefined — 0 is a real value)", () => {
    const wire: WireHistoryEvent = {
      id: "e6",
      createdAt: "2026-05-28T00:00:05Z",
      kind: "commandRun",
      commandId: "cmd-1",
      commandName: "Greet",
      executionId: "exec-9",
      exitCode: 0,
      durationMs: 100,
      status: "succeeded",
    };
    const evt = wireToEvent(wire);
    if (evt.kind !== "commandRun") throw new Error("kind narrowing");
    expect(evt.exitCode).toBe(0);
    expect(evt.durationMs).toBe(100);
  });

  it("converts commandRestored / commandReverted preserving originalEventId", () => {
    const restored = wireToEvent({
      id: "e7",
      createdAt: "2026-05-28T00:00:06Z",
      kind: "commandRestored",
      commandId: "cmd-1",
      commandName: "Greet",
      originalEventId: "src-e3",
    });
    if (restored.kind !== "commandRestored")
      throw new Error("kind narrowing");
    expect(restored.originalEventId).toBe("src-e3");

    const reverted = wireToEvent({
      id: "e8",
      createdAt: "2026-05-28T00:00:07Z",
      kind: "commandReverted",
      commandId: "cmd-1",
      commandName: "Greet",
      originalEventId: "src-e2",
    });
    if (reverted.kind !== "commandReverted")
      throw new Error("kind narrowing");
    expect(reverted.originalEventId).toBe("src-e2");
  });
});

describe("eventToWire", () => {
  it("converts commandCreated and encodes snapshotAfter optionals as null", () => {
    const e: HistoryEvent = {
      id: "e1",
      createdAt: "2026-05-28T00:00:00Z",
      kind: "commandCreated",
      commandId: "cmd-1",
      commandName: "Greet",
      snapshotAfter: sampleCommand,
    };
    const wire = eventToWire(e);
    expect(wire.kind).toBe("commandCreated");
    if (wire.kind !== "commandCreated") throw new Error("kind narrowing");
    expect(wire.snapshotAfter.nameKey).toBeNull();
    expect(wire.snapshotAfter.description).toBeNull();
    expect(wire.snapshotAfter.shell).toBeNull();
  });

  it("commandRun: absent exitCode/durationMs are omitted (NOT null) on the wire", () => {
    const e: HistoryEvent = {
      id: "e1",
      createdAt: "2026-05-28T00:00:00Z",
      kind: "commandRun",
      commandId: "cmd-1",
      commandName: "Greet",
      executionId: "exec-9",
      status: "running",
    };
    const wire = eventToWire(e);
    if (wire.kind !== "commandRun") throw new Error("kind narrowing");
    expect("exitCode" in wire).toBe(false);
    expect("durationMs" in wire).toBe(false);
  });

  it("commandRun: present exitCode 0 is preserved on the wire", () => {
    const e: HistoryEvent = {
      id: "e1",
      createdAt: "2026-05-28T00:00:00Z",
      kind: "commandRun",
      commandId: "cmd-1",
      commandName: "Greet",
      executionId: "exec-9",
      exitCode: 0,
      durationMs: 250,
      status: "succeeded",
    };
    const wire = eventToWire(e);
    if (wire.kind !== "commandRun") throw new Error("kind narrowing");
    expect(wire.exitCode).toBe(0);
    expect(wire.durationMs).toBe(250);
  });

  it("roundtrips every variant through wire then back", () => {
    const variants: HistoryEvent[] = [
      {
        id: "e1",
        createdAt: "2026-05-28T00:00:00Z",
        kind: "commandCreated",
        commandId: "cmd-1",
        commandName: "Greet",
        snapshotAfter: sampleCommand,
      },
      {
        id: "e2",
        createdAt: "2026-05-28T00:00:01Z",
        kind: "commandEdited",
        commandId: "cmd-1",
        commandName: "Greet",
        snapshotBefore: sampleCommand,
        snapshotAfter: { ...sampleCommand, name: "Greet 2" },
      },
      {
        id: "e3",
        createdAt: "2026-05-28T00:00:02Z",
        kind: "commandDeleted",
        commandId: "cmd-1",
        commandName: "Greet",
        snapshotBefore: sampleCommand,
      },
      {
        id: "e4",
        createdAt: "2026-05-28T00:00:03Z",
        kind: "commandRun",
        commandId: "cmd-1",
        commandName: "Greet",
        executionId: "exec-9",
        exitCode: 0,
        durationMs: 100,
        status: "succeeded",
      },
      {
        id: "e5",
        createdAt: "2026-05-28T00:00:04Z",
        kind: "commandRestored",
        commandId: "cmd-1",
        commandName: "Greet",
        originalEventId: "src-e3",
      },
      {
        id: "e6",
        createdAt: "2026-05-28T00:00:05Z",
        kind: "commandReverted",
        commandId: "cmd-1",
        commandName: "Greet",
        originalEventId: "src-e2",
      },
    ];
    for (const e of variants) {
      const wire = eventToWire(e);
      const back = wireToEvent(wire);
      expect(back).toEqual(e);
    }
  });

  it("roundtrips every workflow variant through wire then back", () => {
    const sampleWorkflow: Workflow = {
      id: "wf-1",
      name: "Deploy",
      nodes: [{ id: "n-start", kind: "start", position: { x: 0, y: 0 } }],
      edges: [],
      tags: [],
      favorite: false,
      createdAt: "2026-05-28T00:00:00Z",
      updatedAt: "2026-05-28T00:00:00Z",
      runCount: 0,
    };
    const variants: HistoryEvent[] = [
      {
        id: "w1",
        createdAt: "2026-05-28T00:00:00Z",
        kind: "workflowCreated",
        workflowId: "wf-1",
        workflowName: "Deploy",
        snapshotAfter: sampleWorkflow,
      },
      {
        id: "w2",
        createdAt: "2026-05-28T00:00:01Z",
        kind: "workflowEdited",
        workflowId: "wf-1",
        workflowName: "Deploy",
        snapshotBefore: sampleWorkflow,
        snapshotAfter: { ...sampleWorkflow, name: "Deploy 2" },
      },
      {
        id: "w3",
        createdAt: "2026-05-28T00:00:02Z",
        kind: "workflowDeleted",
        workflowId: "wf-1",
        workflowName: "Deploy",
        snapshotBefore: sampleWorkflow,
      },
      {
        id: "w4",
        createdAt: "2026-05-28T00:00:03Z",
        kind: "workflowRun",
        workflowId: "wf-1",
        workflowName: "Deploy",
        executionId: "run-9",
        exitCode: 0,
        durationMs: 320,
        status: "succeeded",
      },
    ];
    for (const e of variants) {
      const wire = eventToWire(e);
      const back = wireToEvent(wire);
      expect(back).toEqual(e);
    }
  });

  it("workflowRun: absent exitCode/durationMs are omitted (NOT null) on the wire", () => {
    const e: HistoryEvent = {
      id: "w5",
      createdAt: "2026-05-28T00:00:00Z",
      kind: "workflowRun",
      workflowId: "wf-1",
      workflowName: "Deploy",
      executionId: "run-9",
      status: "running",
    };
    const wire = eventToWire(e);
    if (wire.kind !== "workflowRun") throw new Error("kind narrowing");
    expect("exitCode" in wire).toBe(false);
    expect("durationMs" in wire).toBe(false);
  });
});

describe("IPC wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });
  afterEach(() => {
    invokeMock.mockReset();
  });

  it("listHistoryFromDb forwards filter/page/pageSize and decodes items", async () => {
    invokeMock.mockResolvedValueOnce({
      items: [
        {
          id: "e1",
          createdAt: "2026-05-28T00:00:00Z",
          kind: "commandCreated",
          commandId: "cmd-1",
          commandName: "Greet",
          snapshotAfter: sampleRecord,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    const page = await listHistoryFromDb(
      { kinds: ["commandCreated"], commandNameQuery: "gr" },
      1,
      10,
    );
    expect(invokeMock).toHaveBeenCalledWith("list_history", {
      filter: { kinds: ["commandCreated"], commandNameQuery: "gr" },
      page: 1,
      pageSize: 10,
    });
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.kind).toBe("commandCreated");
  });

  it("getHistoryEventFromDb returns null when Rust returns null", async () => {
    invokeMock.mockResolvedValueOnce(null);
    const got = await getHistoryEventFromDb("missing");
    expect(got).toBeNull();
  });

  it("getHistoryEventFromDb decodes a wire event", async () => {
    invokeMock.mockResolvedValueOnce({
      id: "e1",
      createdAt: "2026-05-28T00:00:00Z",
      kind: "commandDeleted",
      commandId: "cmd-1",
      commandName: "Greet",
      snapshotBefore: sampleRecord,
    });
    const got = await getHistoryEventFromDb("e1");
    expect(got?.kind).toBe("commandDeleted");
  });

  it("recordHistoryEventInDb forwards the wire event and returns the id", async () => {
    invokeMock.mockResolvedValueOnce("e1");
    const e: HistoryEvent = {
      id: "e1",
      createdAt: "2026-05-28T00:00:00Z",
      kind: "commandCreated",
      commandId: "cmd-1",
      commandName: "Greet",
      snapshotAfter: sampleCommand,
    };
    const id = await recordHistoryEventInDb(e);
    expect(id).toBe("e1");
    const [cmd, args] = invokeMock.mock.calls[0] ?? [];
    expect(cmd).toBe("record_history_event");
    const wire = (args as { event: WireHistoryEvent }).event;
    if (wire.kind !== "commandCreated") throw new Error("kind narrowing");
    expect(wire.snapshotAfter.nameKey).toBeNull();
  });

  it("updateRunHistoryEventInDb sends null for absent fields", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await updateRunHistoryEventInDb("exec-9", undefined, undefined, "cancelled");
    expect(invokeMock).toHaveBeenCalledWith("update_run_history_event", {
      executionId: "exec-9",
      exitCode: null,
      durationMs: null,
      status: "cancelled",
      timedOut: null,
    });
  });

  it("updateRunHistoryEventInDb sends exitCode 0 (NOT null)", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await updateRunHistoryEventInDb("exec-9", 0, 100, "succeeded");
    expect(invokeMock).toHaveBeenCalledWith("update_run_history_event", {
      executionId: "exec-9",
      exitCode: 0,
      durationMs: 100,
      status: "succeeded",
      // Non-timeout runs send `timedOut: null` so the Rust side stores
      // `None`; only a genuine timeout sends `true`.
      timedOut: null,
    });
  });

  it("deleteHistoryEventInDb forwards the id", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await deleteHistoryEventInDb("e1");
    expect(invokeMock).toHaveBeenCalledWith("delete_history_event", {
      id: "e1",
    });
  });

  it("clearHistoryInDb calls the command with no args", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await clearHistoryInDb();
    // The mock wrapper receives (cmd, undefined) when `invoke(cmd)` is
    // called with no payload — the second slot is the args object.
    expect(invokeMock).toHaveBeenCalledWith("clear_history", undefined);
  });
});
