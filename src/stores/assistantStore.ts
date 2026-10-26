import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { generateAssistantResponse } from "../services/assistantService";
import { cancelAssistantGeneration } from "../services/assistantService";
import type {
  AssistantAction,
  AssistantBackendError,
  AssistantChatMessage,
  AssistantGenerateResponse,
  AssistantObjectContext,
  AssistantRunSnapshot,
  AssistantTarget,
  AssistantContractFailure,
  AssistantContractIssue,
  AssistantBackendCodeError,
  AssistantSessionError,
} from "../types/assistant";
import { validateAssistantResponse } from "../utils/assistantContracts";
import { ASSISTANT_PATCH_RETRY_MARKER } from "../utils/assistantPatchFeedback";

interface AssistantSession {
  target: AssistantTarget;
  objectId: string | null;
  draftVersion: number;
  messages: AssistantChatMessage[];
  runSnapshot: AssistantRunSnapshot | null;
  attachedRunSnapshotId: string | undefined;
  isGenerating: boolean;
  streamingText: string | null;
  error: AssistantSessionError | null;
}

interface AssistantStoreState {
  session: AssistantSession | null;
  startSession: (
    target: AssistantTarget,
    objectId: string | null,
    draftVersion: number,
  ) => void;
  sendMessage: (
    context: AssistantObjectContext<unknown>,
    userMessage: string,
  ) => Promise<void>;
  cancelSession: () => Promise<void>;
  setRunSnapshot: (snapshot: AssistantRunSnapshot | null) => void;
}

function messageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Backend contract failures arrive as `ASSISTANT_INVALID_RESPONSE: <Debug
 * variant>` (see `contract::AssistantContractError`). Mapping the variant
 * keeps the panel's detailed "…: {{issue}}" message instead of the generic
 * invalid-response text.
 */
const CONTRACT_ISSUE_DEBUG_NAMES: Record<string, AssistantContractIssue> = {
  Action: "action",
  MessageLength: "messageLength",
  Operation: "operation",
  OperationCount: "operationCount",
  Path: "path",
  ResponseLength: "responseLength",
  Summary: "summary",
  Warnings: "warnings",
};

function errorFromThrowable(error: unknown): AssistantSessionError {
  if (typeof error === "string") {
    const providerHttp = /^ASSISTANT_PROVIDER_HTTP_(\d{3})$/.exec(error);
    if (providerHttp !== null) {
      return {
        kind: "providerHttp",
        status: Number(providerHttp[1]),
      };
    }
    const map: Record<string, AssistantBackendError> = {
      ASSISTANT_DISABLED: "disabled",
      ASSISTANT_NOT_CONFIGURED: "notConfigured",
      ASSISTANT_AUTH_FAILED: "authFailed",
      ASSISTANT_NETWORK: "network",
      ASSISTANT_TIMEOUT: "timeout",
      ASSISTANT_PROVIDER: "provider",
      ASSISTANT_INVALID_RESPONSE: "invalidAssistantResponse",
      ASSISTANT_INPUT_TOO_LARGE: "inputTooLarge",
      ASSISTANT_RUN_SNAPSHOTS_DISABLED: "runSnapshotsDisabled",
    };
    const code = Object.keys(map).find((prefix) => error.startsWith(prefix));
    if (code !== undefined) {
      if (code === "ASSISTANT_INVALID_RESPONSE") {
        const issue =
          CONTRACT_ISSUE_DEBUG_NAMES[error.split(":")[1]?.trim() ?? ""];
        if (issue !== undefined) {
          return {
            kind: "contract",
            issue,
          } satisfies AssistantContractFailure;
        }
      }
      return map[code];
    }
  }
  if (
    error instanceof Error &&
    error.message === "Invalid assistant response returned by backend"
  ) {
    return "invalidAssistantResponse";
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    error.kind === "contract" &&
    "issue" in error &&
    typeof error.issue === "string"
  ) {
    return { kind: "contract", issue: error.issue as AssistantContractIssue };
  }
  if (typeof error === "object" && error !== null && "kind" in error) {
    const kind = error.kind;
    if (kind === "providerHttp" || kind === "contract" || kind === "backendCode") {
      return error as AssistantSessionError;
    }
  }
  if (error instanceof Error && error.message.startsWith("ASSISTANT_")) {
    return {
      kind: "backendCode",
      code: error.message,
    } satisfies AssistantBackendCodeError;
  }
  return "invalidResponse";
}

export const useAssistantStore = create<AssistantStoreState>()((set, get) => ({
  session: null,
  startSession: (target, objectId, draftVersion) => {
    const current = get().session;
    if (
      current?.target === target &&
      current.objectId === objectId &&
      current.draftVersion === draftVersion
    ) {
      return;
    }
    if (current?.target === target && current.objectId === objectId) {
      set({
        session: {
          ...current,
          draftVersion,
          runSnapshot: null,
          attachedRunSnapshotId: undefined,
        },
      });
      return;
    }
    set({
      session: {
        target,
        objectId,
        draftVersion,
        messages: [],
        runSnapshot: null,
        attachedRunSnapshotId: undefined,
        isGenerating: false,
        streamingText: null,
        error: null,
      },
    });
  },
  sendMessage: async (context, userMessage) => {
    const current = get().session;
    if (!current || current.isGenerating || userMessage.trim() === "") return;
    const attachedRunSnapshot =
      current.runSnapshot !== null &&
      current.attachedRunSnapshotId === current.runSnapshot.id
        ? current.runSnapshot
        : null;
    const user: AssistantChatMessage = {
      id: messageId(),
      role: "user",
      text: userMessage.trim(),
      createdAt: new Date().toISOString(),
      ...(userMessage.trim().startsWith(ASSISTANT_PATCH_RETRY_MARKER)
        ? { kind: "patchRetry" as const }
        : {}),
    };
    set({
      session: {
        ...current,
        messages: [...current.messages, user],
        runSnapshot: null,
        attachedRunSnapshotId: undefined,
        isGenerating: true,
        streamingText: null,
        error: null,
      },
    });

    let unlisten: UnlistenFn | undefined;
    let streamed = "";
    try {
      unlisten = await listen<string>("assistant-stream-delta", (event) => {
        streamed += event.payload;
        set((state) => ({
          session: state.session
            ? { ...state.session, streamingText: streamed }
            : state.session,
        }));
      });
      const request = {
        target: current.target,
        objectId: current.objectId,
        draftVersion: current.draftVersion,
        userMessage: user.text,
        ...(attachedRunSnapshot !== null
          ? { attachedRunSnapshotId: attachedRunSnapshot.id }
          : {}),
      };
      const response: AssistantGenerateResponse =
        attachedRunSnapshot !== null
          ? await generateAssistantResponse(
              request,
              context,
              attachedRunSnapshot,
            )
          : await generateAssistantResponse(request, context);
      const validation = validateAssistantResponse(current.target, response);
      if (!validation.isValid) {
        throw {
          kind: "contract",
          issue: validation.issue ?? "action",
        } satisfies AssistantContractFailure;
      }
      const assistant: AssistantChatMessage = {
        id: response.messageId,
        role: "assistant",
        text: response.text,
        createdAt: new Date().toISOString(),
        action: response.action as AssistantAction | undefined,
      };
      set((state) => ({
        session: state.session
          ? {
              ...state.session,
              messages: [...state.session.messages, assistant],
              runSnapshot: null,
              attachedRunSnapshotId: undefined,
              isGenerating: false,
              streamingText: null,
              error: null,
            }
          : state.session,
      }));
    } catch (error: unknown) {
      set((state) => ({
        session: state.session
          ? {
              ...state.session,
              runSnapshot: null,
              attachedRunSnapshotId: undefined,
              isGenerating: false,
              streamingText: null,
              error: errorFromThrowable(error),
            }
          : state.session,
      }));
    } finally {
      unlisten?.();
    }
  },
  cancelSession: async () => {
    const current = get().session;
    if (!current?.isGenerating) return;
    try {
      await cancelAssistantGeneration();
    } finally {
      set({
        session: {
          ...current,
          isGenerating: false,
          streamingText: null,
          error: null,
        },
      });
    }
  },
  setRunSnapshot: (snapshot) => {
    set((state) => ({
      session: state.session
        ? {
            ...state.session,
            runSnapshot: snapshot,
            attachedRunSnapshotId: snapshot?.id,
          }
        : state.session,
    }));
  },
}));
