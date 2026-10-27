import { describe, expect, it } from "vitest";

import type { Command, Execution } from "../types";
import { buildExecutionRunAssistant } from "./executionRunAssistant";

const command: Command = {
  id: "cmd-1",
  name: "Saved name",
  description: "Saved description",
  script: "echo old",
  tags: ["ops"],
  favorite: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  runCount: 1,
  runAsAdmin: false,
  outputSchema: {
    pipeline: [{ parser: "raw", fields: [] }],
    source: "stdout",
  },
};

const execution: Execution = {
  id: "run-1",
  commandId: command.id,
  commandName: "Disk usage",
  script: "df -h",
  shell: "bash",
  status: "success",
  startedAt: Date.parse("2026-01-02T00:00:00.000Z"),
  finishedAt: Date.parse("2026-01-02T00:00:01.000Z"),
  exitCode: 0,
  durationMs: 1000,
  log: [
    { stream: "stdout", line: "/dev/nvme0n1p5 870G 376G 449G 46% /", ts: 1 },
    { stream: "stderr", line: "warning", ts: 2 },
  ],
  result: {
    returnValue: "/dev/nvme0n1p5 870G 376G 449G 46% /",
    fields: { root: "46%" },
  },
};

describe("execution run assistant", () => {
  it("uses the executed script and attaches the complete captured result", () => {
    const assistant = buildExecutionRunAssistant(execution, { command });

    expect(assistant?.target).toBe("command");
    expect(assistant?.objectId).toBe(command.id);
    expect(assistant?.context.draft).toMatchObject({
      assistantMode: "completedRunAnalysis",
      draftIsReadOnly: true,
      name: "Disk usage",
      script: "df -h",
      shell: "bash",
      description: "Saved description",
    });
    expect(assistant?.context.draft.executedRun).toMatchObject({
      runId: "run-1",
      status: "succeeded",
      exitCode: 0,
      durationMs: 1000,
      outputLineCount: 2,
    });
    expect(assistant?.snapshot?.stdoutTail).toBe(
      "/dev/nvme0n1p5 870G 376G 449G 46% /",
    );
    expect(assistant?.snapshot?.stderrTail).toBe("warning");
    expect(assistant?.snapshot?.outputSchema).toEqual(command.outputSchema);
    expect(assistant?.snapshot?.extractedFields).toEqual({ root: "46%" });
  });

  it("returns no run-scoped assistant while the execution is still live", () => {
    expect(
      buildExecutionRunAssistant(
        { ...execution, status: "running", exitCode: null, result: undefined },
        { command },
      ),
    ).toBeNull();
  });
});
