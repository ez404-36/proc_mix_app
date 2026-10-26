// Assistant — object-scoped draft helper contracts.
//
// The model never receives execution tools. It can only propose a validated
// patch or ask the user to run something / provide output. These types mirror
// `src-tauri/src/core/assistant/contract.rs` and use camelCase on the wire.

export type AssistantTarget = "command" | "workflow" | "miniapp" | "schedule";

/** Stable machine-readable errors returned from the assistant backend. */
export type AssistantBackendError =
  | "disabled"
  | "notConfigured"
  | "authFailed"
  | "network"
  | "timeout"
  | "provider"
  | "invalidAssistantResponse"
  | "inputTooLarge"
  | "runSnapshotsDisabled";

/** Provider failures preserve only the non-sensitive HTTP status. */
export interface AssistantProviderHttpError {
  kind: "providerHttp";
  status: number;
}

export type AssistantContractIssue =
  | "action"
  | "messageLength"
  | "operation"
  | "operationCount"
  | "path"
  | "responseLength"
  | "summary"
  | "warnings";

export interface AssistantContractFailure {
  kind: "contract";
  issue: AssistantContractIssue;
}

export interface AssistantBackendCodeError {
  kind: "backendCode";
  code: string;
}

export type AssistantSessionError =
  | AssistantBackendError
  | "invalidResponse"
  | AssistantProviderHttpError
  | AssistantContractFailure
  | AssistantBackendCodeError;

export type AssistantPatchOperationKind = "add" | "replace" | "remove";

/**
 * A deliberately constrained patch operation. The `path` is an assistant
 * field path (not a general JSON Path); target adapters validate it against
 * the concrete draft shape before rendering or applying a patch.
 */
export interface AssistantPatchOperation {
  op: AssistantPatchOperationKind;
  path: string;
  /** Absent for `remove`; otherwise JSON-compatible patch payload. */
  value?: unknown;
}

export interface AssistantPatch {
  summary: string;
  warnings?: string[];
  operations: AssistantPatchOperation[];
}

export type AssistantAction =
  | { kind: "proposePatch"; patch: AssistantPatch }
  | { kind: "requestRun"; reason: string; suggestedStep?: string }
  | { kind: "requestOutput"; reason: string; whatToCopy?: string };

export interface AssistantChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  /**
   * Client-only classification. `"patchRetry"` marks auto-generated retry
   * requests after a failed patch apply; the panel renders them as collapsed
   * error details. Backend responses never carry this field.
   */
  kind?: "patchRetry";
  action?: AssistantAction;
}

export interface AssistantGenerateRequest {
  target: AssistantTarget;
  /** Identifies the open editor session; backend never loads objects by id. */
  objectId: string | null;
  draftVersion: number;
  userMessage: string;
  attachedRunSnapshotId?: string;
  /** Explicit one-request consent when the global snapshot default is off. */
  runSnapshotConsent?: boolean;
}

/**
 * Sanitized result of one user-initiated run. Raw env/variable values are
 * structurally excluded; text is redacted and bounded before this object is
 * created.
 */
export interface AssistantRunSnapshot {
  id: string;
  target: AssistantTarget;
  draftVersion: number;
  createdAt: string;
  /** Historical/live outcome; optional for backward-compatible callers. */
  status?: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs?: number;
  stdoutTail: string;
  stderrTail: string;
  outputSchema?: unknown;
  extractedFields?: Record<string, unknown>;
}

export interface AssistantGenerateResponse {
  messageId: string;
  text: string;
  action?: AssistantAction;
  warnings: string[];
}

export interface AssistantObjectContext<TDraft> {
  target: AssistantTarget;
  schemaVersion: 1;
  draftVersion: number;
  draft: TDraft;
}

export type AssistantProviderKind =
  | "custom"
  | "lm-studio"
  | "ollama"
  | "openai"
  | "openrouter"
  | "minimax"
  | "groq"
  | "deepseek"
  | "mistral"
  | "together"
  | "cerebras"
  | "perplexity"
  | "xai"
  | "zhipu"
  | "zhipu-coding"
  | "zai-responses"
  | "codex";

export interface AssistantProviderPreset {
  kind: AssistantProviderKind;
  label: string;
  defaultBaseUrl: string;
  requiresApiKey: boolean;
  isLocal: boolean;
}

/** Non-secret provider instance. API keys are keychain-only. */
export interface AssistantProvider {
  id: string;
  name: string;
  kind: AssistantProviderKind;
  baseUrl: string;
  enabled: boolean;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantProviderModel {
  providerId: string;
  modelId: string;
  name: string;
  verified: boolean;
  hidden: boolean;
  updatedAt: string;
}

export interface AssistantProviderTestResult {
  ok: boolean;
  modelCount: number;
  error?: string;
}

/** Non-secret assistant settings. Provider selection references instances. */
export interface AssistantSettings {
  enabled: boolean;
  timeoutMs: number;
  activeProviderId: string | null;
  activeModelId: string | null;
  allowRunSnapshots: boolean;
  allowRemoteEndpoints: boolean;
}

export interface AssistantProviderInput {
  id?: string;
  name: string;
  kind: AssistantProviderKind;
  baseUrl: string;
  enabled: boolean;
}
