import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  captureRowToCommandInput,
  saveCaptureAsCommand,
  saveCaptureAsWorkflow,
} from "./recordingActions";
import { createCommand } from "./commandActions";
import { createWorkflow } from "./workflowActions";
import type { CaptureRow } from "../stores/captureStore";
import type { Command, Workflow } from "../types";

vi.mock("./commandActions", () => ({
  createCommand: vi.fn(),
}));
vi.mock("./workflowActions", () => ({
  createWorkflow: vi.fn(),
}));

const mockedCreateCommand = vi.mocked(createCommand);
const mockedCreateWorkflow = vi.mocked(createWorkflow);

function row(overrides: Partial<CaptureRow> = {}): CaptureRow {
  return {
    id: "cap-1",
    pid: 100,
    ppid: 1,
    image: "C:/Program Files/Git/bin/git.exe",
    commandLine: "git status",
    timestamp: "0",
    ...overrides,
  };
}

let cmdSeq = 0;
beforeEach(() => {
  vi.clearAllMocks();
  cmdSeq = 0;
  // Each createCommand returns a materialised command with a fresh id.
  mockedCreateCommand.mockImplementation((input) => {
    cmdSeq += 1;
    return {
      id: `cmd-${cmdSeq}`,
      name: input.name,
      script: input.script,
      shell: input.shell,
      tags: input.tags,
      favorite: input.favorite,
      runAsAdmin: input.runAsAdmin,
      createdAt: "t",
      updatedAt: "t",
      runCount: 0,
    } as Command;
  });
  mockedCreateWorkflow.mockImplementation(
    (input) => ({ id: "wf-1", ...input, createdAt: "t", updatedAt: "t", runCount: 0 }) as Workflow,
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("captureRowToCommandInput", () => {
  it("names the command from the image basename without .exe", () => {
    const input = captureRowToCommandInput(row());
    expect(input.name).toBe("git");
  });

  it("uses cmd as the shell", () => {
    expect(captureRowToCommandInput(row()).shell).toBe("cmd");
  });

  it("re-redacts secrets at the save boundary (defence in depth)", () => {
    // Even if a raw secret somehow reached the row, saving must mask it.
    const input = captureRowToCommandInput(
      row({ commandLine: "mysql --password=hunter2" }),
    );
    expect(input.script).toBe("mysql --password=***");
    expect(input.script).not.toContain("hunter2");
  });

  it("falls back to a truncated command line when image has no basename", () => {
    const input = captureRowToCommandInput(
      row({ image: "", commandLine: "some-long-command-line" }),
    );
    expect(input.name).toBe("some-long-command-line");
  });
});

describe("saveCaptureAsCommand", () => {
  it("creates one command per row, in order", () => {
    const created = saveCaptureAsCommand([
      row({ id: "a", image: "C:/a/git.exe" }),
      row({ id: "b", image: "C:/b/ffmpeg.exe" }),
    ]);
    expect(mockedCreateCommand).toHaveBeenCalledTimes(2);
    expect(created.map((c) => c.name)).toEqual(["git", "ffmpeg"]);
  });

  it("is a no-op for an empty selection", () => {
    expect(saveCaptureAsCommand([])).toEqual([]);
    expect(mockedCreateCommand).not.toHaveBeenCalled();
  });
});

describe("saveCaptureAsWorkflow", () => {
  it("returns null and creates nothing for an empty selection", () => {
    expect(saveCaptureAsWorkflow("WF", [])).toBeNull();
    expect(mockedCreateWorkflow).not.toHaveBeenCalled();
    expect(mockedCreateCommand).not.toHaveBeenCalled();
  });

  it("builds a linear start → command… → end graph", () => {
    saveCaptureAsWorkflow("My flow", [
      row({ id: "a", image: "C:/a/git.exe" }),
      row({ id: "b", image: "C:/b/ffmpeg.exe" }),
    ]);

    expect(mockedCreateWorkflow).toHaveBeenCalledOnce();
    const input = mockedCreateWorkflow.mock.calls[0]![0];

    expect(input.name).toBe("My flow");
    // start + 2 commands + end = 4 nodes.
    expect(input.nodes).toHaveLength(4);
    const kinds = input.nodes.map((n) => n.kind);
    expect(kinds).toEqual(["start", "command", "command", "end"]);

    // Command nodes reference the created command ids in order.
    const commandNodes = input.nodes.filter((n) => n.kind === "command");
    expect(commandNodes.map((n) => n.commandId)).toEqual(["cmd-1", "cmd-2"]);

    // Edges form a single chain: 3 edges for 4 nodes, all "out".
    expect(input.edges).toHaveLength(3);
    expect(input.edges.every((e) => e.branch === "out")).toBe(true);
  });

  it("wires every edge to an existing node (no dangling references)", () => {
    saveCaptureAsWorkflow("Flow", [
      row({ id: "a" }),
      row({ id: "b" }),
      row({ id: "c" }),
    ]);
    const input = mockedCreateWorkflow.mock.calls[0]![0];
    const nodeIds = new Set(input.nodes.map((n) => n.id));
    for (const edge of input.edges) {
      expect(nodeIds.has(edge.source)).toBe(true);
      expect(nodeIds.has(edge.target)).toBe(true);
    }
    // The chain is connected: exactly one start with one outgoing edge,
    // one end with one incoming edge.
    const startNode = input.nodes.find((n) => n.kind === "start")!;
    const endNode = input.nodes.find((n) => n.kind === "end")!;
    expect(input.edges.filter((e) => e.source === startNode.id)).toHaveLength(1);
    expect(input.edges.filter((e) => e.target === endNode.id)).toHaveLength(1);
  });
});
