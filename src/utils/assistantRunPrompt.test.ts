import { describe, expect, it } from "vitest";

import type { AssistantRunSnapshot } from "../types/assistant";
import {
  ASSISTANT_RUN_PROMPT_STREAM_CHARS,
  buildAssistantRunSnapshotPrompt,
} from "./assistantRunPrompt";

const snapshot: AssistantRunSnapshot = {
  id: "run-1",
  target: "command",
  draftVersion: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  exitCode: 0,
  timedOut: false,
  stdoutTail: "ready",
  stderrTail: "warning",
};

const labels = {
  request: "Analyze the run",
  exit: "exit code: 0",
  stdout: "stdout",
  stderr: "stderr",
  truncated: "The beginning is omitted",
};

describe("assistant run prompt", () => {
  it("builds a user-facing prompt with run output", () => {
    expect(buildAssistantRunSnapshotPrompt(snapshot, labels)).toBe(
      [
        "Analyze the run",
        "exit code: 0",
        "stdout:\n```\nready\n```",
        "stderr:\n```\nwarning\n```",
      ].join("\n\n"),
    );
  });

  it("bounds each output stream while preserving its tail", () => {
    const longSnapshot: AssistantRunSnapshot = {
      ...snapshot,
      stdoutTail: `old\n${"x".repeat(ASSISTANT_RUN_PROMPT_STREAM_CHARS + 10)}`,
    };
    const prompt = buildAssistantRunSnapshotPrompt(longSnapshot, labels);

    expect(prompt).toContain("The beginning is omitted");
    expect(prompt).not.toContain("old\nx");
    expect(prompt.length).toBeLessThan(8_000);
  });
});
