import { describe, expect, it } from "vitest";

import type { RunResult } from "../types/commandForm";
import type { OutputSchema } from "../types/outputSchema";
import {
  ASSISTANT_RUN_SNAPSHOT_TAIL_CHARS,
  buildAssistantRunSnapshot,
} from "./assistantRunSnapshot";

const terminal: RunResult = {
  status: "finished",
  exitCode: 0,
  durationMs: 10,
  timedOut: false,
  lines: [
    { stream: "stdout", text: "token=secret123" },
    { stream: "stderr", text: "warning" },
  ],
};

const schema: OutputSchema = {
    pipeline: [
      { parser: "regex", pattern: "token=(?<token>\\S+)", fields: [] },
    ],
  sample: "token=secret123",
};

describe("assistant run snapshots", () => {
  it("redacts output, schema sample, and extracted fields", () => {
    const snapshot = buildAssistantRunSnapshot({
      id: "run-1",
      target: "command",
      draftVersion: 3,
      result: terminal,
      outputSchema: schema,
      extracted: { fields: { token: "secret123" }, returnValue: null },
    });

    expect(snapshot).toMatchObject({ exitCode: 0, draftVersion: 3 });
    expect(snapshot?.stdoutTail).toContain("***");
    expect(snapshot?.stdoutTail).not.toContain("secret123");
    expect(JSON.stringify(snapshot?.outputSchema)).not.toContain("secret123");
    expect(snapshot?.extractedFields?.token).toBe("***");
  });

  it("returns null while running and bounds each stream tail", () => {
    expect(
      buildAssistantRunSnapshot({
        id: "run-running",
        target: "command",
        draftVersion: 1,
        result: { ...terminal, status: "running", exitCode: null },
      }),
    ).toBeNull();

    const snapshot = buildAssistantRunSnapshot({
      id: "run-big",
      target: "command",
      draftVersion: 1,
      result: {
        ...terminal,
        lines: [
          {
            stream: "stdout",
            text: "x".repeat(ASSISTANT_RUN_SNAPSHOT_TAIL_CHARS + 100),
          },
        ],
      },
    });

    expect(snapshot?.stdoutTail).toHaveLength(ASSISTANT_RUN_SNAPSHOT_TAIL_CHARS);
  });
});
