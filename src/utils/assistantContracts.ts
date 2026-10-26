// Runtime boundary for assistant model responses.
//
// TypeScript types alone cannot validate data that crosses IPC/provider
// boundaries. These guards deliberately accept `unknown` and reject malformed
// or unsafe model output before it can reach UI state or an editor store.

import type {
  AssistantAction,
  AssistantBackendError,
  AssistantContractIssue,
  AssistantGenerateResponse,
  AssistantObjectContext,
  AssistantPatch,
  AssistantPatchOperation,
  AssistantSettings,
  AssistantTarget,
} from "../types/assistant";

export const ASSISTANT_TARGETS = ["command", "workflow", "miniapp"] as const;

export const ASSISTANT_LIMITS = {
  maxMessageLength: 8_000,
  maxResponseLength: 32_000,
  maxPatchSummaryLength: 2_000,
  maxPatchWarningLength: 1_000,
  maxPatchOperations: 32,
  maxPatchWarnings: 16,
  maxPatchPathLength: 256,
} as const;

/**
 * Root fields an assistant may replace or add. Target adapters independently
 * validate the payload shape and dependencies before Apply. Identity, audit
 * and API-exposure fields are intentionally absent.
 */
export const ASSISTANT_ALLOWED_PATCH_ROOTS: Record<
  AssistantTarget,
  readonly string[]
> = {
  command: [
    "name",
    "description",
    "script",
    "shell",
    "args",
    "workingDir",
    "variables",
    "outputSchema",
    "timeoutSeconds",
    "tags",
    "target",
  ],
  workflow: ["name", "description", "nodes", "edges", "tags"],
  miniapp: ["name", "description", "widgets", "tags", "panelSize"],
};

export function isAssistantTarget(value: unknown): value is AssistantTarget {
  return (
    typeof value === "string" &&
    (ASSISTANT_TARGETS as readonly string[]).includes(value)
  );
}

export function isAssistantSettings(value: unknown): value is AssistantSettings {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.enabled === "boolean" &&
    typeof value.timeoutMs === "number" &&
    Number.isFinite(value.timeoutMs) &&
    (value.activeProviderId === null ||
      value.activeProviderId === undefined ||
      typeof value.activeProviderId === "string") &&
    (value.activeModelId === null ||
      value.activeModelId === undefined ||
      typeof value.activeModelId === "string") &&
    typeof value.allowRunSnapshots === "boolean" &&
    typeof value.allowRemoteEndpoints === "boolean"
  );
}

export function serializeAssistantContext(
  context: AssistantObjectContext<unknown>,
  maxChars: number,
): string {
  const json = JSON.stringify(context);
  if (json === undefined) {
    throw new Error("Assistant context is not JSON-serializable");
  }
  if (json.length > maxChars) {
    throw new Error("ASSISTANT_INPUT_TOO_LARGE");
  }
  return json;
}

export function isAssistantBackendError(
  value: unknown,
): value is AssistantBackendError {
  return (
    value === "disabled" ||
    value === "notConfigured" ||
    value === "authFailed" ||
    value === "network" ||
    value === "timeout" ||
    value === "provider" ||
    value === "invalidAssistantResponse" ||
    value === "inputTooLarge" ||
    value === "runSnapshotsDisabled"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPatchOperation(value: unknown): value is AssistantPatchOperation {
  if (!isRecord(value)) {
    return false;
  }

  const { op, path, value: patchValue } = value;
  return (
    (op === "add" || op === "replace" || op === "remove") &&
    typeof path === "string" &&
    path.length > 0 &&
    (op === "remove" ? patchValue === undefined : patchValue !== undefined)
  );
}

export function isAssistantPatch(value: unknown): value is AssistantPatch {
  if (!isRecord(value)) {
    return false;
  }

  const { summary, warnings, operations } = value;
  return (
    isNonEmptyString(summary) &&
    (warnings === undefined || isStringArray(warnings)) &&
    Array.isArray(operations) &&
    operations.every(isPatchOperation)
  );
}

export function isAssistantAction(value: unknown): value is AssistantAction {
  if (!isRecord(value)) {
    return false;
  }

  if (value.kind === "proposePatch") {
    return isRecord(value.patch) && isAssistantPatch(value.patch);
  }

  if (value.kind === "requestRun" || value.kind === "requestOutput") {
    const hasRequiredReason = isNonEmptyString(value.reason);
    if (value.kind === "requestRun") {
      return hasRequiredReason && isOptionalString(value.suggestedStep);
    }

    return hasRequiredReason && isOptionalString(value.whatToCopy);
  }

  return false;
}

export function isAssistantGenerateResponse(
  value: unknown,
): value is AssistantGenerateResponse {
  if (!isRecord(value)) {
    return false;
  }

  const { messageId, text, action, warnings } = value;
  return (
    typeof messageId === "string" &&
    messageId.length > 0 &&
    typeof text === "string" &&
    (action === undefined || isAssistantAction(action)) &&
    isStringArray(warnings)
  );
}

export function isAssistantPatchPathAllowed(
  target: AssistantTarget,
  path: string,
): boolean {
  const exactOrPrefix = path.split(".", 1)[0];
  if (exactOrPrefix === undefined) {
    return false;
  }

  return ASSISTANT_ALLOWED_PATCH_ROOTS[target].some(
    (root) => path === root || path.startsWith(`${root}.`),
  );
}

export type { AssistantContractIssue };

export interface AssistantContractValidation {
  readonly isValid: boolean;
  readonly issue?: AssistantContractIssue;
}

const VALID_CONTRACT: AssistantContractValidation = { isValid: true };

function invalid(issue: AssistantContractIssue): AssistantContractValidation {
  return { isValid: false, issue };
}

function validatePatch(
  target: AssistantTarget,
  patch: AssistantPatch,
): AssistantContractValidation {
  if (
    patch.summary.length === 0 ||
    patch.summary.length > ASSISTANT_LIMITS.maxPatchSummaryLength
  ) {
    return invalid("summary");
  }

  if (
    patch.operations.length === 0 ||
    patch.operations.length > ASSISTANT_LIMITS.maxPatchOperations
  ) {
    return invalid("operationCount");
  }

  if (
    patch.warnings !== undefined &&
    (patch.warnings.length > ASSISTANT_LIMITS.maxPatchWarnings ||
      patch.warnings.some(
        (warning) => warning.length > ASSISTANT_LIMITS.maxPatchWarningLength,
      ))
  ) {
    return invalid("warnings");
  }

  for (const operation of patch.operations) {
    const pathAllowed = isAssistantPatchPathAllowed(target, operation.path);
    if (
      !isPatchOperation(operation) ||
      operation.path.length > ASSISTANT_LIMITS.maxPatchPathLength ||
      !pathAllowed
    ) {
      return invalid(pathAllowed ? "operation" : "path");
    }
  }

  return VALID_CONTRACT;
}

/**
 * Validate the full response against semantic contract limits in addition to
 * the structural shape checks performed by the type guards.
 */
export function validateAssistantResponse(
  target: AssistantTarget,
  response: AssistantGenerateResponse,
): AssistantContractValidation {
  if (response.text.length > ASSISTANT_LIMITS.maxResponseLength) {
    return invalid("responseLength");
  }

  if (response.action === undefined) {
    return VALID_CONTRACT;
  }

  if (!isAssistantAction(response.action)) {
    return invalid("action");
  }

  if (response.action.kind === "proposePatch") {
    return validatePatch(target, response.action.patch);
  }

  if (response.action.reason.length > ASSISTANT_LIMITS.maxMessageLength) {
    return invalid("messageLength");
  }

  return VALID_CONTRACT;
}
