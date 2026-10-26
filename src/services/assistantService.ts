// Typed wrappers around assistant providers, settings and generation.
//
// Components/stores must use this service rather than `invoke` directly. IPC
// results are validated here because they remain serialization boundaries.

import { invoke } from "@tauri-apps/api/core";
import type {
  AssistantGenerateRequest,
  AssistantGenerateResponse,
  AssistantObjectContext,
  AssistantProvider,
  AssistantProviderInput,
  AssistantProviderKind,
  AssistantProviderModel,
  AssistantProviderPreset,
  AssistantProviderTestResult,
  AssistantRunSnapshot,
  AssistantSettings,
  AssistantRunAccess,
  AssistantTarget,
} from "../types/assistant";
import {
  isAssistantGenerateResponse,
  isAssistantRunAccess,
  isAssistantSettings,
} from "../utils/assistantContracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertProvider(value: unknown): AssistantProvider {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.baseUrl !== "string" ||
    typeof value.enabled !== "boolean" ||
    typeof value.hasApiKey !== "boolean" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error("Invalid assistant provider returned by backend");
  }
  return value as unknown as AssistantProvider;
}

function assertProviderPreset(value: unknown): AssistantProviderPreset {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    typeof value.label !== "string" ||
    typeof value.defaultBaseUrl !== "string" ||
    typeof value.requiresApiKey !== "boolean" ||
    typeof value.isLocal !== "boolean"
  ) {
    throw new Error("Invalid assistant provider preset returned by backend");
  }
  return value as unknown as AssistantProviderPreset;
}

function assertProviderModel(value: unknown): AssistantProviderModel {
  if (
    !isRecord(value) ||
    typeof value.providerId !== "string" ||
    typeof value.modelId !== "string" ||
    typeof value.name !== "string" ||
    typeof value.verified !== "boolean" ||
    typeof value.hidden !== "boolean" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error("Invalid assistant model returned by backend");
  }
  return value as unknown as AssistantProviderModel;
}

export async function getAssistantSettings(): Promise<AssistantSettings> {
  const settings: unknown = await invoke("get_assistant_settings");
  if (!isAssistantSettings(settings)) {
    throw new Error("Invalid assistant settings returned by backend");
  }
  return settings;
}

export async function setAssistantSettings(settings: AssistantSettings): Promise<void> {
  await invoke("set_assistant_settings", { settings });
}

export async function getAssistantRunAccess(
  target: AssistantTarget,
  objectId: string,
): Promise<AssistantRunAccess> {
  const access: unknown = await invoke("get_assistant_run_access", {
    target,
    objectId,
  });
  if (!isAssistantRunAccess(access)) {
    throw new Error("Invalid assistant run access returned by backend");
  }
  return access;
}

export async function setAssistantRunAccess(
  target: AssistantTarget,
  objectId: string,
  access: AssistantRunAccess,
): Promise<void> {
  await invoke("set_assistant_run_access", { target, objectId, access });
}

export async function listAssistantProviderPresets(): Promise<
  AssistantProviderPreset[]
> {
  const presets: unknown = await invoke("list_assistant_provider_presets");
  if (!Array.isArray(presets)) {
    throw new Error("Invalid assistant provider presets returned by backend");
  }
  return presets.map(assertProviderPreset);
}

export async function listAssistantProviders(): Promise<AssistantProvider[]> {
  const providers: unknown = await invoke("list_assistant_providers");
  if (!Array.isArray(providers)) {
    throw new Error("Invalid assistant providers returned by backend");
  }
  return providers.map(assertProvider);
}

export async function saveAssistantProvider(
  provider: AssistantProviderInput,
  providerId?: string,
): Promise<AssistantProvider> {
  const saved: unknown = await invoke("save_assistant_provider", {
    provider,
    providerId: providerId ?? null,
  });
  return assertProvider(saved);
}

export async function setAssistantProviderEnabled(
  providerId: string,
  enabled: boolean,
): Promise<void> {
  await invoke("set_assistant_provider_enabled", { providerId, enabled });
}

export async function deleteAssistantProvider(providerId: string): Promise<void> {
  await invoke("delete_assistant_provider", { providerId });
}

export async function getAssistantProviderApiKeyStatus(
  providerId: string,
): Promise<boolean> {
  return invoke<boolean>("assistant_provider_api_key_status", { providerId });
}

export async function setAssistantProviderApiKey(
  providerId: string,
  apiKey: string,
): Promise<void> {
  await invoke("set_assistant_provider_api_key", { providerId, apiKey });
}

export async function clearAssistantProviderApiKey(
  providerId: string,
): Promise<void> {
  await invoke("clear_assistant_provider_api_key", { providerId });
}

export async function testAssistantProvider(
  providerId: string,
): Promise<AssistantProviderTestResult> {
  const result: unknown = await invoke("test_assistant_provider", { providerId });
  if (
    !isRecord(result) ||
    typeof result.ok !== "boolean" ||
    typeof result.modelCount !== "number"
  ) {
    throw new Error("Invalid provider test result returned by backend");
  }
  return result as unknown as AssistantProviderTestResult;
}

export async function listAssistantProviderModels(
  providerId: string,
  includeHidden = false,
): Promise<AssistantProviderModel[]> {
  const models: unknown = await invoke("list_assistant_provider_models", {
    providerId,
    includeHidden,
  });
  if (!Array.isArray(models)) {
    throw new Error("Invalid assistant models returned by backend");
  }
  return models.map(assertProviderModel);
}

export async function setAssistantProviderModelHidden(
  providerId: string,
  modelId: string,
  hidden: boolean,
): Promise<void> {
  await invoke("set_assistant_provider_model_hidden", {
    providerId,
    modelId,
    hidden,
  });
}

export async function setAssistantActiveModel(
  providerId: string,
  modelId: string,
): Promise<void> {
  await invoke("set_assistant_active_model", { providerId, modelId });
}

export async function setAssistantActiveProvider(
  providerId: string,
): Promise<void> {
  await invoke("set_assistant_active_provider", { providerId });
}

export async function cancelAssistantGeneration(): Promise<void> {
  await invoke("assistant_cancel");
}

export async function generateAssistantResponse(
  request: AssistantGenerateRequest,
  context: AssistantObjectContext<unknown>,
  runSnapshot?: AssistantRunSnapshot,
): Promise<AssistantGenerateResponse> {
  const response: unknown = await invoke("assistant_generate", {
    request,
    context,
    ...(runSnapshot !== undefined ? { runSnapshot } : {}),
  });
  if (!isAssistantGenerateResponse(response)) {
    throw new Error("Invalid assistant response returned by backend");
  }
  return response;
}

export type { AssistantProviderKind };
