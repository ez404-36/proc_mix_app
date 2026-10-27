import { describe, expect, it } from "vitest";

import type { AssistantGenerateResponse } from "../types/assistant";
import {
  ASSISTANT_LIMITS,
  isAssistantAction,
  isAssistantGenerateResponse,
  isAssistantPatchPathAllowed,
  validateAssistantResponse,
} from "./assistantContracts";

const validResponse: AssistantGenerateResponse = {
  messageId: "message-1",
  text: "Proposed a command change.",
  warnings: [],
  action: {
    kind: "proposePatch",
    patch: {
      summary: "Set the script.",
      operations: [{ op: "replace", path: "script", value: "echo ok" }],
    },
  },
};

describe("assistant contracts", () => {
  it("accepts a structurally and semantically valid patch response", () => {
    expect(isAssistantGenerateResponse(validResponse)).toBe(true);
    expect(validateAssistantResponse("command", validResponse)).toEqual({
      isValid: true,
    });
  });

  it("rejects execution-shaped or malformed actions", () => {
    expect(isAssistantAction({ kind: "execute", script: "rm -rf /" })).toBe(
      false,
    );
    expect(isAssistantAction({ kind: "proposePatch" })).toBe(false);
    expect(isAssistantAction({ kind: "requestRun" })).toBe(false);
  });

  it("enforces target-specific patch roots", () => {
    expect(isAssistantPatchPathAllowed("command", "script")).toBe(true);
    expect(isAssistantPatchPathAllowed("command", "outputSchema.pipeline")).toBe(
      true,
    );
    expect(isAssistantPatchPathAllowed("command", "id")).toBe(false);
    expect(isAssistantPatchPathAllowed("workflow", "widgets")).toBe(false);
  });

  it("rejects empty and disallowed patches", () => {
    const emptyPatchResponse: AssistantGenerateResponse = {
      ...validResponse,
      action: {
        kind: "proposePatch",
        patch: { summary: "empty", operations: [] },
      },
    };
    const forbiddenPathResponse: AssistantGenerateResponse = {
      ...validResponse,
      action: {
        kind: "proposePatch",
        patch: {
          summary: "identity change",
          operations: [{ op: "replace", path: "id", value: "new" }],
        },
      },
    };

    expect(validateAssistantResponse("command", emptyPatchResponse)).toEqual({
      isValid: false,
      issue: "operationCount",
    });
    expect(validateAssistantResponse("command", forbiddenPathResponse)).toEqual({
      isValid: false,
      issue: "path",
    });
  });

  it("rejects a response above the hard output limit", () => {
    const oversized: AssistantGenerateResponse = {
      ...validResponse,
      text: "x".repeat(ASSISTANT_LIMITS.maxResponseLength + 1),
    };

    expect(validateAssistantResponse("command", oversized)).toEqual({
      isValid: false,
      issue: "responseLength",
    });
  });
});
