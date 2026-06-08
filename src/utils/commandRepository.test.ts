import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import type { Command } from "../types";
import {
  type CommandRecord,
  commandToRecord,
  deleteCommandInDb,
  listCommandsFromDb,
  recordToCommand,
  upsertCommandInDb,
} from "./commandRepository";

const fullCommand: Command = {
  id: "id-1",
  name: "My Command",
  nameKey: "seeds.x.name",
  description: "desc",
  descriptionKey: "seeds.x.description",
  icon: "icon",
  script: "echo hi",
  shell: "bash",
  args: ["a", "b"],
  workingDir: "/tmp",
  env: { FOO: "bar" },
  tags: ["t1"],
  categoryId: "cat-1",
  favorite: true,
  createdAt: "2026-05-28T00:00:00Z",
  updatedAt: "2026-05-28T00:00:01Z",
  lastRunAt: "2026-05-28T00:00:02Z",
  runCount: 3,
  runAsAdmin: true,
};

const fullRecord: CommandRecord = {
  id: "id-1",
  name: "My Command",
  nameKey: "seeds.x.name",
  description: "desc",
  descriptionKey: "seeds.x.description",
  icon: "icon",
  script: "echo hi",
  shell: "bash",
  args: ["a", "b"],
  workingDir: "/tmp",
  env: { FOO: "bar" },
  tags: ["t1"],
  categoryId: "cat-1",
  favorite: true,
  createdAt: "2026-05-28T00:00:00Z",
  updatedAt: "2026-05-28T00:00:01Z",
  lastRunAt: "2026-05-28T00:00:02Z",
  runCount: 3,
  runAsAdmin: true,
};

const minimalCommand: Command = {
  id: "id-2",
  name: "Bare",
  script: "true",
  tags: [],
  favorite: false,
  createdAt: "2026-05-28T00:00:00Z",
  updatedAt: "2026-05-28T00:00:00Z",
  runCount: 0,
  runAsAdmin: false,
};

const minimalRecord: CommandRecord = {
  id: "id-2",
  name: "Bare",
  nameKey: null,
  description: null,
  descriptionKey: null,
  icon: null,
  script: "true",
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

beforeEach(() => {
  invokeMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("commandToRecord / recordToCommand", () => {
  it("encodes a fully-populated command into the wire format", () => {
    expect(commandToRecord(fullCommand)).toEqual(fullRecord);
  });

  it("decodes a fully-populated wire record back to a command", () => {
    expect(recordToCommand(fullRecord)).toEqual(fullCommand);
  });

  it("round-trips a fully-populated command without loss", () => {
    expect(recordToCommand(commandToRecord(fullCommand))).toEqual(fullCommand);
  });

  it("encodes a minimal command with all optional fields as null", () => {
    expect(commandToRecord(minimalCommand)).toEqual(minimalRecord);
  });

  it("decodes nulls back to undefined on the UI side", () => {
    expect(recordToCommand(minimalRecord)).toEqual(minimalCommand);
  });

  it("drops an unknown shell value to undefined during decode", () => {
    const rec: CommandRecord = { ...minimalRecord, shell: "totally-not-a-shell" };
    expect(recordToCommand(rec).shell).toBeUndefined();
  });

  // Legacy databases that predate the admin feature have no
  // `runAsAdmin` column; the Rust side deserialises with serde-default,
  // but a record loaded from such a DB into JS will have the field
  // literally absent. The decoder must default it to `false` rather
  // than leaking `undefined` into the Command type.
  it("defaults runAsAdmin to false when the record predates the field", () => {
    const legacy = { ...minimalRecord };
    delete (legacy as Partial<CommandRecord>).runAsAdmin;
    const cmd = recordToCommand(legacy);
    expect(cmd.runAsAdmin).toBe(false);
  });
});

describe("listCommandsFromDb", () => {
  it("invokes list_commands and maps the records", async () => {
    invokeMock.mockResolvedValueOnce([fullRecord, minimalRecord]);
    const result = await listCommandsFromDb();
    expect(invokeMock).toHaveBeenCalledWith("list_commands", undefined);
    expect(result).toEqual([fullCommand, minimalCommand]);
  });
});

describe("upsertCommandInDb", () => {
  it("invokes upsert_command with a `command` argument carrying the record", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await upsertCommandInDb(fullCommand);
    expect(invokeMock).toHaveBeenCalledWith("upsert_command", {
      command: fullRecord,
    });
  });
});

describe("deleteCommandInDb", () => {
  it("invokes delete_command with the id", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await deleteCommandInDb("id-1");
    expect(invokeMock).toHaveBeenCalledWith("delete_command", { id: "id-1" });
  });
});
