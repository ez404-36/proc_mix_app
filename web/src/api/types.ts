// Wire types for the built-in HTTP API server's web-facing endpoints.
//
// These mirror the Rust DTOs (serde `camelCase`) returned by `core::http_server`:
//   - ApiEntitySummary  ↔ handlers::ApiEntitySummary   (GET /api/commands|workflows)
//   - RunStatusResponse ↔ handlers::RunStatusResponse  (GET /api/run/{id})
//   - ApiHistoryPage    ↔ handlers::ApiHistoryPage      (GET /api/history)
//   - RunAccepted       ↔ POST /api/command|workflow/{ref}/run (202/200 body)
//   - Bootstrap         ↔ GET /api/bootstrap
//
// The command/workflow DETAIL endpoints return the full `CommandRecord` /
// `WorkflowRecord` serde shapes; those are typed loosely here (`unknown` record)
// until the read-only detail views (F4/F5) consume specific fields.

/** Console line as persisted/returned by the server (history log line). */
export interface HistoryLogLine {
  stream: "stdout" | "stderr" | "meta";
  line: string;
}

/** Structured output-schema extraction result, when a command declared one. */
export interface ExtractedResult {
  [key: string]: unknown;
}

/** Run terminal/intermediate status as returned by `GET /api/run/{id}`. */
export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

/** The two addressable entity kinds. */
export type EntityKind = "command" | "workflow";

/**
 * Summary row for the list endpoints (`GET /api/commands|workflows`). Enriched
 * with the display metadata the Home / Library views need (favorite, lastRunAt,
 * description, i18n keys) so they render without an N+1 detail fetch. The
 * preferred address is `apiSlug` when present, else `id`.
 */
export interface ApiEntitySummary {
  kind: EntityKind;
  id: string;
  name: string;
  /** i18n key for a built-in entity's name (commands only); absent otherwise. */
  nameKey?: string;
  description?: string;
  /** i18n key for a built-in entity's description (commands only). */
  descriptionKey?: string;
  apiSlug?: string;
  favorite: boolean;
  /** ISO timestamp of the last run, when the entity has been run. */
  lastRunAt?: string;
}

/** The address used to run / fetch an entity: its slug when set, else its id. */
export function entityRef(e: ApiEntitySummary): string {
  return e.apiSlug ?? e.id;
}

/**
 * Status + captured output of a single run (`GET /api/run/{executionId}`). Per
 * decision O2 (option B): `output` is present once the run reaches a terminal
 * state; a still-running poll returns `status: "running"` with no output yet.
 */
export interface RunStatusResponse {
  executionId: string;
  kind: "command" | "workflow";
  name: string;
  status: RunStatus;
  exitCode?: number;
  durationMs?: number;
  timedOut?: boolean;
  output?: HistoryLogLine[];
  result?: ExtractedResult;
}

/** One page of API-visible run history (`GET /api/history`). */
export interface ApiHistoryPage {
  /** Run events (loosely typed until the History view F7 consumes fields). */
  items: HistoryEventWire[];
  /** Upper-bound total for the two run kinds (see handlers::list_api_history). */
  total: number;
  page: number;
  pageSize: number;
}

/**
 * A history run event as returned on the wire. The discriminated `kind` plus
 * the run fields are flattened to the top level (serde `#[serde(flatten)]`).
 * Typed permissively here; the History view narrows on `kind`.
 */
export interface HistoryEventWire {
  id: string;
  createdAt: string;
  kind: "commandRun" | "workflowRun";
  executionId: string;
  commandId?: string;
  commandName?: string;
  workflowId?: string;
  workflowName?: string;
  status: RunStatus;
  exitCode?: number;
  durationMs?: number;
  timedOut?: boolean;
  output?: HistoryLogLine[];
  result?: ExtractedResult;
}

/** Response of a run trigger (`POST .../run`). The 202 async body. */
export interface RunAccepted {
  executionId: string;
  /** Present on `?wait=true` synchronous runs. */
  status?: RunStatus;
  exitCode?: number;
}

/** Non-secret startup config for the SPA (`GET /api/bootstrap`). */
export interface Bootstrap {
  /** App language snapshot at server-start time, or null when unset. */
  language: string | null;
}

// --- Entity detail (B1) -----------------------------------------------------
//
// `GET /api/command/{ref}` / `GET /api/workflow/{ref}` return the full
// CommandRecord / WorkflowRecord serde shapes. Only the fields the read-only
// detail modal displays are typed here; sensitive variable defaults are already
// stripped server-side, so a secret never reaches the browser.

/** A command variable spec, as needed by the read-only detail + run prompt. */
export interface VariableSpec {
  name: string;
  /** Absent when the value must be supplied at runtime. */
  defaultValue?: string;
  promptAtRuntime?: boolean;
  description?: string;
  /** Sensitive values are masked server-side (no default reaches the client). */
  sensitive?: boolean;
}

/** Full command detail (`GET /api/command/{ref}`). */
export interface CommandDetail {
  id: string;
  name: string;
  nameKey?: string;
  description?: string;
  descriptionKey?: string;
  script: string;
  shell?: string;
  tags: string[];
  categoryId?: string;
  favorite: boolean;
  timeoutSeconds?: number;
  variables?: VariableSpec[];
  apiSlug?: string;
}

/** A single workflow node, reduced to what the step list shows. */
export interface WorkflowNodeDetail {
  id: string;
  kind: string;
  label?: string;
  commandId?: string;
}

/** Full workflow detail (`GET /api/workflow/{ref}`). */
export interface WorkflowDetail {
  id: string;
  name: string;
  description?: string;
  nodes: WorkflowNodeDetail[];
  tags: string[];
  categoryId?: string;
  favorite: boolean;
  apiSlug?: string;
}
