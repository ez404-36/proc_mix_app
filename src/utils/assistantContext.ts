// Build the only object context an assistant may see.
//
// The output is an explicit allow-listed snapshot, never a raw editor store
// object. Secrets are removed structurally; free-text output is additionally
// passed through the existing best-effort command-line redactor.

import type {
  AssistantObjectContext,
  AssistantTarget,
} from "../types/assistant";
import type { Command, VariableSpec } from "../types/command";
import type { MiniApp } from "../types/miniapp";
import type { OutputSchema } from "../types/outputSchema";
import type { FormState } from "../types/commandForm";
import type { ScheduleTargetKind } from "../types/schedule";
import { REDACTION, redactSecrets } from "./redactSecrets";

export interface AssistantVariableContext {
  name: string;
  hasDefault: boolean;
  /**
   * Non-secret default value, included so the model can rewrite the whole
   * `variables` array without losing defaults. Sensitive defaults are
   * structurally excluded; only `hasDefault` is reported for them.
   */
  defaultValue?: string;
  promptAtRuntime: boolean;
  description?: string;
  sensitive: boolean;
}

export interface AssistantCommandContext {
  target: AssistantTarget;
  name: string;
  description?: string;
  script: string;
  shell?: Command["shell"];
  /**
   * Present only when the caller edits a saved `Command` whose storage shape
   * has a separate `args` array. The command FORM has no args field (the whole
   * command line lives in `script`), so form-based sessions omit it — the
   * backend would accept an `args` patch, but the form adapter would reject it
   * at Apply.
   */
  args?: string[];
  workingDir?: string;
  promptWorkingDir?: boolean;
  tags: string[];
  runsAsAdmin: boolean;
  timeoutSeconds?: number;
  variables?: AssistantVariableContext[];
  outputSchema?: OutputSchema;
  executionTarget?: { kind: "local" | "remotePrompt" } | { kind: "remote"; alias: string };
}

/**
 * Backend draft versions are `u32`. `Date.now()` exceeds that range, so IPC
 * rejects the whole request before the assistant command can produce a
 * user-facing error. A content hash gives a bounded version that changes when
 * the draft changes.
 */
export function createAssistantDraftVersion(snapshot: unknown): number {
  const serialized = JSON.stringify(snapshot) ?? "";
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) || 1;
}

const MAX_CONTEXT_DEPTH = 24;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactDeep(value: unknown, depth = 0, seen?: Set<object>): unknown {
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (depth >= MAX_CONTEXT_DEPTH) {
    throw new Error("Assistant context exceeds the supported nesting depth");
  }

  const object = value as object;
  const visited = seen ?? new Set<object>();
  if (visited.has(object)) {
    throw new Error("Assistant context contains a circular reference");
  }
  visited.add(object);

  const result = Array.isArray(value)
    ? value.map((item) => redactDeep(item, depth + 1, visited))
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          redactDeep(item, depth + 1, visited),
        ]),
      );
  visited.delete(object);
  return result;
}

function sanitizeVariable(variable: VariableSpec): AssistantVariableContext {
  return {
    name: variable.name,
    hasDefault: variable.defaultValue !== undefined,
    defaultValue: variable.sensitive === true ? undefined : variable.defaultValue,
    promptAtRuntime: variable.promptAtRuntime === true,
    description: variable.description
      ? redactSecrets(variable.description)
      : undefined,
    sensitive: variable.sensitive === true,
  };
}

function sanitizeOutputSchema(
  schema: OutputSchema | undefined,
): OutputSchema | undefined {
  if (!schema) {
    return undefined;
  }
  const redacted = redactDeep(schema);
  return isRecord(redacted) ? (redacted as unknown as OutputSchema) : undefined;
}

export function buildCommandAssistantContext(
  command: Command,
  draftVersion = 0,
): AssistantObjectContext<AssistantCommandContext> {
  const context: AssistantCommandContext = {
    target: "command",
    name: command.name,
    description: command.description,
    script: command.script,
    shell: command.shell,
    args: command.args,
    workingDir: command.workingDir,
    promptWorkingDir: command.promptWorkingDir,
    tags: command.tags,
    runsAsAdmin: command.runAsAdmin,
    timeoutSeconds: command.timeoutSeconds,
    variables: command.variables?.map(sanitizeVariable),
    outputSchema: sanitizeOutputSchema(command.outputSchema),
    executionTarget:
      command.target === undefined
        ? { kind: "local" }
        : command.target.kind === "remote"
          ? { kind: "remote", alias: redactSecrets(command.target.alias) }
          : { kind: command.target.kind },
  };

  return {
    target: "command",
    schemaVersion: 1,
    draftVersion,
    draft: context,
  };
}

export function buildCommandFormAssistantContext(
  form: FormState,
  draftVersion: number,
): AssistantObjectContext<AssistantCommandContext> {
  const context: AssistantCommandContext = {
    target: "command",
    name: form.name,
    description: form.description === "" ? undefined : form.description,
    script: form.script,
    shell: form.shell,
    workingDir: form.workingDir === "" ? undefined : form.workingDir,
    promptWorkingDir: form.promptWorkingDir,
    tags: form.tags,
    runsAsAdmin: form.runAsAdmin,
    timeoutSeconds: form.timeoutSeconds === "" ? undefined : Number(form.timeoutSeconds),
    variables: form.variables.map((row) => ({
      name: row.name,
      hasDefault: row.defaultValue !== "",
      defaultValue:
        row.sensitive || row.defaultValue === "" ? undefined : row.defaultValue,
      promptAtRuntime: row.promptAtRuntime,
      description: row.description === "" ? undefined : redactSecrets(row.description),
      sensitive: row.sensitive,
    })),
    outputSchema: sanitizeOutputSchema(form.outputSchema),
    executionTarget: form.target,
  };
  return { target: "command", schemaVersion: 1, draftVersion, draft: context };
}

function sanitizeWorkflowNode(node: unknown): unknown {
  if (!isRecord(node)) {
    return node;
  }

  const sanitized: Record<string, unknown> = { ...node };
  const sources = sanitized.variableSources;
  if (isRecord(sources)) {
    sanitized.variableSources = Object.fromEntries(
      Object.entries(sources).map(([name, source]) => {
        if (!isRecord(source) || source.kind !== "manual") {
          return [name, source];
        }
        return [name, { ...source, value: REDACTION }];
      }),
    );
  }

  const data = sanitized.data;
  if (Array.isArray(data)) {
    sanitized.data = data.map((assignment) => {
      if (!isRecord(assignment)) {
        return assignment;
      }
      const source = isRecord(assignment.source) ? assignment.source : undefined;
      if (source?.kind === "manual") {
        return { ...assignment, value: REDACTION, source: { ...source, value: REDACTION } };
      }
      return assignment;
    });
  }

  return sanitized;
}

export function buildWorkflowAssistantContext(
  workflow: {
    name: string;
    description?: string;
    nodes: readonly unknown[];
    edges: readonly unknown[];
    tags: readonly string[];
  },
  draftVersion = 0,
): AssistantObjectContext<Record<string, unknown>> {
  const nodes = redactDeep(workflow.nodes) as unknown[];
  return {
    target: "workflow",
    schemaVersion: 1,
    draftVersion,
    draft: {
      target: "workflow",
      name: workflow.name,
      description: workflow.description,
      nodes: nodes.map(sanitizeWorkflowNode),
      edges: redactDeep(workflow.edges),
      tags: workflow.tags,
    },
  };
}

function sanitizeMiniAppWidget(widget: unknown): unknown {
  const redacted = redactDeep(widget);
  if (!isRecord(redacted)) {
    return redacted;
  }
  if (redacted.kind === "artifact" && redacted.variant === "secret") {
    return { ...redacted, value: REDACTION };
  }
  return redacted;
}

export function buildMiniAppAssistantContext(
  miniApp: Pick<
    MiniApp,
    "name" | "description" | "widgets" | "tags" | "panelSize"
  >,
  draftVersion = 0,
): AssistantObjectContext<Record<string, unknown>> {
  return {
    target: "miniapp",
    schemaVersion: 1,
    draftVersion,
    draft: {
      target: "miniapp",
      name: miniApp.name,
      description: miniApp.description,
      widgets: miniApp.widgets.map(sanitizeMiniAppWidget),
      tags: miniApp.tags,
      panelSize: miniApp.panelSize,
    },
  };
}

export function buildScheduleAssistantContext(
  schedule: {
    name: string;
    enabled: boolean;
    targetKind: ScheduleTargetKind;
    targetId: string;
    cron: string;
    variableValues: unknown;
    skipIfRunning: boolean;
    captureOutput: boolean;
    catchUpPolicy: "none" | "once" | "all";
    timeoutSeconds?: number;
    maxRetries: number;
  },
  draftVersion = 0,
): AssistantObjectContext<Record<string, unknown>> {
  return {
    target: "schedule",
    schemaVersion: 1,
    draftVersion,
    draft: {
      target: "schedule",
      name: schedule.name,
      enabled: schedule.enabled,
      targetKind: schedule.targetKind,
      targetId: schedule.targetId,
      cron: schedule.cron,
      variableValues: redactDeep(schedule.variableValues),
      skipIfRunning: schedule.skipIfRunning,
      captureOutput: schedule.captureOutput,
      catchUpPolicy: schedule.catchUpPolicy,
      ...(schedule.timeoutSeconds !== undefined
        ? { timeoutSeconds: schedule.timeoutSeconds }
        : {}),
      maxRetries: schedule.maxRetries,
    },
  };
}
