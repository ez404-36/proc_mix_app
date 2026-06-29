// HTTP client for the web UI (F2).
//
// The single place that talks to `/api/*`. Attaches the session Bearer token to
// every request, normalises errors, and exposes typed wrappers for the read /
// run / poll / bootstrap endpoints. Components and stores call these — never
// `fetch` directly. On a 401 it clears the session token so the app falls back
// to the login screen.

import { currentToken, useAuthStore } from "../stores/authStore";
import type {
  ApiEntitySummary,
  ApiHistoryPage,
  Bootstrap,
  CommandDetail,
  RunAccepted,
  RunStatusResponse,
  WorkflowDetail,
} from "./types";

/** Stable error codes the server returns in `{ error }`, surfaced to the UI. */
export type ApiErrorCode =
  | "unauthorized"
  | "forbiddenHost"
  | "rateLimited"
  | "notFound"
  | "missingVariable"
  | "runFailed"
  | "badRequest"
  | "network"
  | "unknown";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  /** For `missingVariable`, the offending variable name when provided. */
  readonly variable?: string;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    variable?: string,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.variable = variable;
  }
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  /** Query params appended to the path. */
  query?: Record<string, string | number | undefined>;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function mapErrorCode(status: number, body: unknown): ApiErrorCode {
  const code =
    typeof body === "object" && body !== null && "error" in body
      ? String((body as { error: unknown }).error)
      : "";
  switch (code) {
    case "forbiddenHost":
      return "forbiddenHost";
    case "rateLimited":
      return "rateLimited";
    case "notFound":
      return "notFound";
    case "missingVariable":
      return "missingVariable";
    case "runFailed":
      return "runFailed";
    default:
      break;
  }
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbiddenHost";
  if (status === 404) return "notFound";
  if (status === 400) return "badRequest";
  return "unknown";
}

/**
 * Core request. Throws {@link ApiError} on any non-2xx (or network failure).
 * A 401 also clears the session token so the UI returns to login.
 */
async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const token = currentToken();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let resp: Response;
  try {
    resp = await fetch(buildUrl(path, opts.query), {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    throw new ApiError(0, "network", err instanceof Error ? err.message : String(err));
  }

  let parsed: unknown = null;
  const text = await resp.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!resp.ok) {
    const code = mapErrorCode(resp.status, parsed);
    if (resp.status === 401) {
      // Token rejected — drop it so the app shows the login screen.
      useAuthStore.getState().clear();
    }
    const variable =
      typeof parsed === "object" && parsed !== null && "variable" in parsed
        ? String((parsed as { variable: unknown }).variable)
        : undefined;
    throw new ApiError(resp.status, code, code, variable);
  }

  return parsed as T;
}

// --- Typed endpoint wrappers ------------------------------------------------

/** Non-secret startup config (unauthenticated). Used before login. */
export function fetchBootstrap(): Promise<Bootstrap> {
  return request<Bootstrap>("/api/bootstrap");
}

/**
 * Validate a token by hitting an authenticated endpoint. Resolves when the
 * token is accepted; rejects with an {@link ApiError} (`unauthorized` /
 * `rateLimited`) otherwise. The token must already be in the auth store.
 */
export async function validateSession(): Promise<void> {
  await request<ApiEntitySummary[]>("/api/commands");
}

export function listCommands(): Promise<ApiEntitySummary[]> {
  return request<ApiEntitySummary[]>("/api/commands");
}

export function listWorkflows(): Promise<ApiEntitySummary[]> {
  return request<ApiEntitySummary[]>("/api/workflows");
}

export function getCommand(reference: string): Promise<CommandDetail> {
  return request<CommandDetail>(`/api/command/${encodeURIComponent(reference)}`);
}

export function getWorkflow(reference: string): Promise<WorkflowDetail> {
  return request<WorkflowDetail>(
    `/api/workflow/${encodeURIComponent(reference)}`,
  );
}

export function getHistory(
  page: number,
  pageSize: number,
): Promise<ApiHistoryPage> {
  return request<ApiHistoryPage>("/api/history", { query: { page, pageSize } });
}

export function getRunStatus(executionId: string): Promise<RunStatusResponse> {
  return request<RunStatusResponse>(
    `/api/run/${encodeURIComponent(executionId)}`,
  );
}

/** Fire a command run. `variables` satisfies any `missingVariable` retry. */
export function runCommand(
  reference: string,
  variables?: Record<string, string>,
): Promise<RunAccepted> {
  return request<RunAccepted>(
    `/api/command/${encodeURIComponent(reference)}/run`,
    { method: "POST", body: variables ? { variables } : {} },
  );
}

export function runWorkflow(
  reference: string,
  variables?: Record<string, string>,
): Promise<RunAccepted> {
  return request<RunAccepted>(
    `/api/workflow/${encodeURIComponent(reference)}/run`,
    { method: "POST", body: variables ? { variables } : {} },
  );
}
