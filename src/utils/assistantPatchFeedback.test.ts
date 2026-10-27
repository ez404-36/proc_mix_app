import { describe, expect, it } from "vitest";

import {
  ASSISTANT_PATCH_RETRY_MARKER,
  buildAssistantPatchRetryPrompt,
} from "./assistantPatchFeedback";

describe("buildAssistantPatchRetryPrompt", () => {
  it("includes the apply error, allowed roots and failed patch", () => {
    const prompt = buildAssistantPatchRetryPrompt({
      target: "command",
      patch: {
        summary: "Change script",
        operations: [
          { op: "replace", path: "outputSchema.pipeline", value: [] },
        ],
      },
      error: "unsupportedPath",
    });

    expect(prompt).toContain("APPLY_ERROR: unsupportedPath");
    expect(prompt.startsWith(ASSISTANT_PATCH_RETRY_MARKER)).toBe(true);
    expect(prompt).toContain("ALLOWED_PATCH_ROOTS: name, description");
    expect(prompt).toContain("FAILED_PATCH_JSON:");
    expect(prompt).toContain("outputSchema.pipeline");
  });

  it("truncates oversized failed patches", () => {
    const prompt = buildAssistantPatchRetryPrompt({
      target: "command",
      patch: {
        summary: "Large patch",
        operations: [
          { op: "replace", path: "script", value: "x".repeat(10_000) },
        ],
      },
      error: "invalidValue",
    });

    expect(prompt.length).toBeLessThan(6_000);
    expect(prompt).toContain("… [truncated]");
  });

  it("tells the model that the command form has no args field", () => {
    const commandPrompt = buildAssistantPatchRetryPrompt({
      target: "command",
      patch: { summary: "s", operations: [] },
      error: "unsupportedPath",
    });
    expect(commandPrompt).toContain("no separate `args` field");

    const workflowPrompt = buildAssistantPatchRetryPrompt({
      target: "workflow",
      patch: { summary: "s", operations: [] },
      error: "unsupportedPath",
    });
    expect(workflowPrompt).not.toContain("`args` field");
  });
});
