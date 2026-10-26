// Target-specific validation, preview, and application for assistant patches.
//
// The backend proves that a patch is contract-shaped and path-allowlisted.
// These adapters are the second, draft-aware boundary: they check the payload
// against the concrete editor representation before a user can click Apply.

import type { AssistantPatch, AssistantPatchOperation } from "../types/assistant";
import type { ExecutionTarget, Shell, VariableSpec } from "../types/command";
import type { OutputParserKind, OutputSchema } from "../types/outputSchema";
import type { MiniApp, MiniAppWidget, PanelSize } from "../types/miniapp";
import type {
  WorkflowEdgeBranch,
  WorkflowNodeKind,
} from "../types/workflow";
import type { ScheduleTargetKind } from "../types/schedule";
import type { WorkflowFlowEdge } from "./workflowGraph";
import { makeRowId } from "./commandFormState";
import type { FormState } from "../types/commandForm";

const SHELLS: readonly Shell[] = [
  "bash",
  "zsh",
  "fish",
  "sh",
  "pwsh",
  "powershell",
  "cmd",
];

export interface AssistantPatchDiff {
  operation: AssistantPatchOperation;
  before: unknown;
}

export type AssistantPatchApplication<TDraft> =
  | { readonly ok: true; readonly value: TDraft }
  | { readonly ok: false; readonly error: AssistantPatchApplyError };

export type AssistantPatchApplyError =
  | "invalidDraft"
  | "invalidOperation"
  | "invalidValue"
  | "unsupportedPath";

const WORKFLOW_NODE_KINDS: readonly WorkflowNodeKind[] = [
  "start",
  "command",
  "condition",
  "switch",
  "loop",
  "try",
  "parallel",
  "join",
  "data",
  "parser",
  "text",
  "end",
];

const OUTPUT_PARSER_KINDS: readonly OutputParserKind[] = [
  "raw",
  "lines",
  "json",
  "regex",
  "keyValue",
  "table",
  "javascript",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isShellValue(value: unknown): value is Shell {
  return typeof value === "string" && (SHELLS as readonly string[]).includes(value);
}

function readRoot(draft: unknown, path: string): unknown {
  if (!isRecord(draft)) return undefined;
  return draft[path];
}

export function previewAssistantPatch(
  patch: AssistantPatch,
  draft: unknown,
): AssistantPatchDiff[] {
  return patch.operations.map((operation) => ({
    operation,
    before: readRoot(draft, operation.path),
  }));
}

function isExecutionTarget(value: unknown): value is ExecutionTarget {
  if (!isRecord(value)) return false;
  if (value.kind === "local" || value.kind === "remotePrompt") return true;
  return value.kind === "remote" && typeof value.alias === "string";
}

function isVariableSpec(value: unknown): value is VariableSpec {
  if (!isRecord(value)) return false;
  return (
    typeof value.name === "string" &&
    value.name.length > 0 &&
    (value.defaultValue === undefined || typeof value.defaultValue === "string") &&
    (value.description === undefined || typeof value.description === "string") &&
    (value.sensitive === undefined || typeof value.sensitive === "boolean") &&
    (value.promptAtRuntime === undefined ||
      typeof value.promptAtRuntime === "boolean")
  );
}

function isOutputSchema(value: unknown): value is OutputSchema {
  if (!isRecord(value) || !Array.isArray(value.pipeline) || value.pipeline.length === 0) {
    return false;
  }
  if (value.source !== undefined && value.source !== "stdout") return false;
  if (
    (value.returnField !== undefined && typeof value.returnField !== "string") ||
    (value.sample !== undefined && typeof value.sample !== "string")
  ) {
    return false;
  }
  return value.pipeline.every((step) => {
    if (
      !isRecord(step) ||
      !OUTPUT_PARSER_KINDS.includes(step.parser as OutputParserKind)
    ) {
      return false;
    }
    return (
      Array.isArray(step.fields) &&
      step.fields.every(
        (field) =>
          isRecord(field) &&
          typeof field.name === "string" &&
          field.name.length > 0,
      )
    );
  });
}

function cloneCommandForm(form: FormState): FormState {
  return structuredClone(form);
}

function variableRowFromSpec(spec: VariableSpec): FormState["variables"][number] {
  return {
    rowId: makeRowId(),
    name: spec.name,
    defaultValue: spec.defaultValue ?? "",
    description: spec.description ?? "",
    sensitive: spec.sensitive ?? false,
    promptAtRuntime:
      spec.promptAtRuntime !== undefined
        ? spec.promptAtRuntime
        : spec.defaultValue === undefined,
    nameTouched: true,
  };
}

export function applyAssistantPatchToCommandForm(
  patch: AssistantPatch,
  form: FormState,
): AssistantPatchApplication<FormState> {
  let next = cloneCommandForm(form);
  for (const operation of patch.operations) {
    if (operation.path === "variables.append") {
      if (operation.op === "remove" || !isVariableSpec(operation.value)) {
        return { ok: false, error: "invalidValue" };
      }
      next = {
        ...next,
        variables: [...next.variables, variableRowFromSpec(operation.value)],
      };
      continue;
    }
    if (operation.path.includes(".")) {
      return { ok: false, error: "unsupportedPath" };
    }
    if (!(operation.path in next)) {
      return { ok: false, error: "unsupportedPath" };
    }

    const value = operation.value;
    switch (operation.path) {
      case "name":
      case "description":
      case "script":
      case "workingDir":
        if (typeof value !== "string") return { ok: false, error: "invalidValue" };
        next = { ...next, [operation.path]: value };
        break;
      case "shell":
        if (!isShellValue(value)) {
          return { ok: false, error: "invalidValue" };
        }
        next = { ...next, shell: value };
        break;
      case "args":
      case "tags":
        if (!isStringArray(value)) return { ok: false, error: "invalidValue" };
        next = { ...next, [operation.path]: value };
        break;
      case "timeoutSeconds": {
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value <= 0 ||
          value > 86_400
        ) {
          return { ok: false, error: "invalidValue" };
        }
        next = { ...next, timeoutSeconds: String(value) };
        break;
      }
      case "target":
        if (!isExecutionTarget(value)) return { ok: false, error: "invalidValue" };
        next = { ...next, target: value };
        break;
      case "variables": {
        if (!Array.isArray(value) || !value.every(isVariableSpec)) {
          return { ok: false, error: "invalidValue" };
        }
        next = {
          ...next,
          variables: (value as VariableSpec[]).map(variableRowFromSpec),
        };
        break;
      }
      case "outputSchema":
        if (!isOutputSchema(value)) return { ok: false, error: "invalidValue" };
        next = { ...next, outputSchema: value };
        break;
      default:
        return { ok: false, error: "unsupportedPath" };
    }
  }
  return { ok: true, value: next };
}

function isWorkflowNodeKind(value: unknown): value is WorkflowNodeKind {
  return typeof value === "string" && WORKFLOW_NODE_KINDS.includes(value as WorkflowNodeKind);
}

function isFlowNode(value: unknown): boolean {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.position)) {
    return false;
  }
  const kind = value.type ?? (isRecord(value.data) ? value.data.kind : undefined);
  return (
    isWorkflowNodeKind(kind) &&
    typeof value.position.x === "number" &&
    typeof value.position.y === "number" &&
    isRecord(value.data)
  );
}

function isWorkflowEdgeBranch(value: unknown): value is WorkflowEdgeBranch {
  return (
    typeof value === "string" &&
    (/^case:.+/.test(value) || /^branch:\d+$/.test(value) ||
      ["out", "then", "else", "default", "body", "done", "ok", "catch"].includes(value))
  );
}

function isWorkflowEdge(value: unknown): value is WorkflowFlowEdge {
  if (!isRecord(value)) return false;
  const branch = value.sourceHandle ?? "out";
  return (
    typeof value.id === "string" &&
    typeof value.source === "string" &&
    typeof value.target === "string" &&
    (branch === null || isWorkflowEdgeBranch(branch))
  );
}

export interface WorkflowAssistantDraft {
  readonly name: string;
  readonly description?: string;
  readonly nodes: unknown[];
  readonly edges: unknown[];
  readonly tags: string[];
}

export function applyAssistantPatchToWorkflowDraft(
  patch: AssistantPatch,
  draft: WorkflowAssistantDraft,
): AssistantPatchApplication<WorkflowAssistantDraft> {
  let next: WorkflowAssistantDraft = {
    name: draft.name,
    description: draft.description,
    nodes: structuredClone(draft.nodes),
    edges: structuredClone(draft.edges),
    tags: [...draft.tags],
  };

  for (const operation of patch.operations) {
    if (operation.path.includes(".")) {
      return { ok: false, error: "unsupportedPath" };
    }
    const value = operation.value;
    if (operation.path === "name" || operation.path === "description") {
      if (typeof value !== "string") return { ok: false, error: "invalidValue" };
      next = { ...next, [operation.path]: value };
    } else if (operation.path === "tags") {
      if (!isStringArray(value)) return { ok: false, error: "invalidValue" };
      next = { ...next, tags: value };
    } else if (operation.path === "nodes" || operation.path === "edges") {
      if (!Array.isArray(value)) return { ok: false, error: "invalidValue" };
      const valid = operation.path === "nodes" ? value.every(isFlowNode) : value.every(isWorkflowEdge);
      if (!valid) return { ok: false, error: "invalidValue" };
      next = { ...next, [operation.path]: structuredClone(value) };
    } else {
      return { ok: false, error: "unsupportedPath" };
    }
  }

  const nodeIds = new Set(
    next.nodes
      .filter((node): node is Record<string, unknown> => isRecord(node))
      .map((node) => node.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const edgesValid = next.edges.every((edge) => {
    if (!isWorkflowEdge(edge)) return false;
    return nodeIds.has(edge.source) && nodeIds.has(edge.target);
  });
  if (!edgesValid) return { ok: false, error: "invalidValue" };
  return { ok: true, value: next };
}

function isPanelSize(value: unknown): value is PanelSize {
  return (
    isRecord(value) &&
    typeof value.w === "number" &&
    Number.isFinite(value.w) &&
    value.w > 0 &&
    typeof value.h === "number" &&
    Number.isFinite(value.h) &&
    value.h > 0
  );
}

function isMiniAppWidget(value: unknown): value is MiniAppWidget {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.layout)) {
    return false;
  }
  const layout = value.layout;
  return (
    ["x", "y", "w", "h"].every((key) => typeof layout[key] === "number") &&
    (value.kind === "button" ||
      value.kind === "toggle" ||
      value.kind === "status" ||
      value.kind === "artifact" ||
      value.kind === "text")
  );
}

export function applyAssistantPatchToMiniApp(
  patch: AssistantPatch,
  draft: MiniApp,
): AssistantPatchApplication<MiniApp> {
  let next: MiniApp = structuredClone(draft);
  for (const operation of patch.operations) {
    if (operation.path.includes(".")) {
      return { ok: false, error: "unsupportedPath" };
    }
    const value = operation.value;
    if (operation.path === "name" || operation.path === "description") {
      if (typeof value !== "string") return { ok: false, error: "invalidValue" };
      next = { ...next, [operation.path]: value };
    } else if (operation.path === "tags") {
      if (!isStringArray(value)) return { ok: false, error: "invalidValue" };
      next = { ...next, tags: value };
    } else if (operation.path === "widgets") {
      if (!Array.isArray(value) || !value.every(isMiniAppWidget)) {
        return { ok: false, error: "invalidValue" };
      }
      next = { ...next, widgets: structuredClone(value) as MiniAppWidget[] };
    } else if (operation.path === "panelSize") {
      if (!isPanelSize(value)) return { ok: false, error: "invalidValue" };
      next = { ...next, panelSize: value };
    } else {
      return { ok: false, error: "unsupportedPath" };
    }
  }
  return { ok: true, value: next };
}

export interface ScheduleAssistantDraft {
  name: string;
  enabled: boolean;
  targetKind: ScheduleTargetKind;
  targetId: string;
  cron: string;
  variableValues: Record<string, unknown>;
  skipIfRunning: boolean;
  captureOutput: boolean;
  catchUpPolicy: "none" | "once" | "all";
  timeoutSeconds?: number;
  maxRetries: number;
}

function isScheduleTargetKind(value: unknown): value is ScheduleTargetKind {
  return value === "command" || value === "workflow";
}

function isScheduleVariableValues(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (item) =>
      typeof item === "string" ||
      (isRecord(item) &&
        Object.values(item).every((nested) => typeof nested === "string")),
  );
}

export function applyAssistantPatchToSchedule(
  patch: AssistantPatch,
  draft: ScheduleAssistantDraft,
): AssistantPatchApplication<ScheduleAssistantDraft> {
  let next: ScheduleAssistantDraft = structuredClone(draft);
  for (const operation of patch.operations) {
    if (operation.path.includes(".")) {
      return { ok: false, error: "unsupportedPath" };
    }
    const value = operation.value;
    switch (operation.path) {
      case "name":
      case "targetId":
      case "cron":
        if (typeof value !== "string" || value.trim() === "") {
          return { ok: false, error: "invalidValue" };
        }
        next = { ...next, [operation.path]: value };
        break;
      case "enabled":
      case "skipIfRunning":
      case "captureOutput":
        if (typeof value !== "boolean") {
          return { ok: false, error: "invalidValue" };
        }
        next = { ...next, [operation.path]: value };
        break;
      case "targetKind":
        if (!isScheduleTargetKind(value)) {
          return { ok: false, error: "invalidValue" };
        }
        next = { ...next, targetKind: value };
        break;
      case "catchUpPolicy":
        if (value !== "none" && value !== "once" && value !== "all") {
          return { ok: false, error: "invalidValue" };
        }
        next = { ...next, catchUpPolicy: value };
        break;
      case "variableValues":
        if (!isScheduleVariableValues(value)) {
          return { ok: false, error: "invalidValue" };
        }
        next = {
          ...next,
          variableValues: structuredClone(value) as Record<string, unknown>,
        };
        break;
      case "timeoutSeconds":
        if (value === null) {
          next = { ...next, timeoutSeconds: undefined };
        } else if (
          typeof value === "number" &&
          Number.isInteger(value) &&
          value > 0
        ) {
          next = { ...next, timeoutSeconds: value };
        } else {
          return { ok: false, error: "invalidValue" };
        }
        break;
      case "maxRetries":
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < 0
        ) {
          return { ok: false, error: "invalidValue" };
        }
        next = { ...next, maxRetries: value };
        break;
      default:
        return { ok: false, error: "unsupportedPath" };
    }
  }
  return { ok: true, value: next };
}
