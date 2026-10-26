import { describe, expect, it } from "vitest";

import type { Command, HistoryEvent } from "../types";
import { buildHistoryRunAssistant } from "./historyRunAssistant";

const command: Command = {
  id: "cmd-1",
  name: "Deploy",
  description: "Deploy the service",
  script: "deploy --env production",
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

const event: HistoryEvent = {
  id: "event-1",
  createdAt: "2026-01-02T00:00:00.000Z",
  kind: "commandRun",
  commandId: command.id,
  commandName: command.name,
  executionId: "execution-1",
  status: "succeeded",
  exitCode: 0,
  durationMs: 123,
  output: [
    { stream: "stdout", line: "first line" },
    { stream: "stderr", line: "a warning" },
  ],
  result: {
    returnValue: "first line",
    fields: { value: "first line" },
  },
};

describe("history run assistant", () => {
  it("sends the command definition and the complete persisted execution result", () => {
    const assistant = buildHistoryRunAssistant(event, { command });

    expect(assistant).not.toBeNull();
    expect(assistant?.target).toBe("command");
    expect(assistant?.objectId).toBe(command.id);
    expect(assistant?.context.draft).toMatchObject({
      name: command.name,
      script: command.script,
      description: command.description,
      definitionIsAtRunTime: true,
    });
    expect(assistant?.context.draft.historicalRun).toMatchObject({
      eventId: event.id,
      status: "succeeded",
      exitCode: 0,
      timedOut: false,
      durationMs: 123,
      outputLineCount: 2,
      outputCaptured: true,
      resultCaptured: true,
      definitionUpdatedAfterRun: false,
    });
    expect(assistant?.snapshot).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      durationMs: 123,
      timedOut: false,
    });
    expect(assistant?.snapshot?.stdoutTail).toBe("first line");
    expect(assistant?.snapshot?.stderrTail).toBe("a warning");
    expect(assistant?.snapshot?.outputSchema).toEqual(command.outputSchema);
    expect(assistant?.snapshot?.extractedFields).toEqual({ value: "first line" });
  });

  it("warns the assistant when the current definition changed after the run", () => {
    const assistant = buildHistoryRunAssistant(event, {
      command: {
        ...command,
        script: "deploy --env staging",
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
    });

    expect(assistant?.context.draft).toMatchObject({
      script: "deploy --env staging",
      definitionIsAtRunTime: false,
    });
    expect(assistant?.context.draft.historicalRun).toMatchObject({
      definitionUpdatedAfterRun: true,
    });
  });
});
