import type { AssistantPatch, AssistantTarget } from "../types/assistant";
import { ASSISTANT_ALLOWED_PATCH_ROOTS } from "./assistantContracts";
import type { AssistantPatchApplyError } from "./assistantPatches";

const MAX_FAILED_PATCH_CHARS = 4_000;

export type AssistantPatchFeedbackError =
  | AssistantPatchApplyError
  | "applyFailed";

/**
 * First line of every auto-generated retry request. The chat uses it to
 * recognize these user messages and render them as collapsed error details
 * instead of a full chat bubble.
 */
export const ASSISTANT_PATCH_RETRY_MARKER =
  "The previous proposed patch failed ProcMix validation and was NOT applied.";

function truncateByChars(value: string, maxChars: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxChars) return value;
  return `${characters.slice(0, maxChars).join("")}\n… [truncated]`;
}

/**
 * Assistant generation is stateless: the backend sends only the current object
 * context and one user request. A failed patch therefore has to be repeated in
 * the retry request, bounded below the backend user-message limit.
 */
export function buildAssistantPatchRetryPrompt(input: {
  target: AssistantTarget;
  patch: AssistantPatch;
  error: AssistantPatchFeedbackError;
}): string {
  const allowedRoots = ASSISTANT_ALLOWED_PATCH_ROOTS[input.target].join(", ");
  const failedPatch = truncateByChars(
    JSON.stringify(input.patch) ?? "",
    MAX_FAILED_PATCH_CHARS,
  );

  return [
    ASSISTANT_PATCH_RETRY_MARKER,
    `APPLY_ERROR: ${input.error}`,
    `ALLOWED_PATCH_ROOTS: ${allowedRoots}`,
    "Use only exact root paths (no dotted paths), complete arrays, and add/replace operations; remove is not supported by the editor adapters.",
    ...(input.target === "command"
      ? [
          "Exception: to append one command variable use {\"op\":\"add\",\"path\":\"variables.append\",\"value\":{...}} instead of rewriting the whole variables array.",
          "The command editor has no separate `args` field: put the whole command line (including ${name} variable references) into `script` instead.",
        ]
      : []),
    "FAILED_PATCH_JSON:",
    failedPatch,
    "Return one corrected patch for the current OBJECT_CONTEXT_JSON.",
  ].join("\n");
}
