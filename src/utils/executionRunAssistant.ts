// Build an isolated, run-scoped assistant request for the Console Runs view.
//
// Unlike editor assistants, this context is owned by one Execution: the exact
// captured script and runtime metadata take precedence over a saved draft.
// Env/raw variables are deliberately not sent; output is redacted by the
// shared snapshot builder before it crosses IPC.

import type {
  AssistantObjectContext,
  AssistantRunSnapshot,
  AssistantTarget,
} from "../types/assistant";
import type { Command, Execution } from "../types";
import type { Workflow } from "../types/workflow";
import {
  buildCommandAssistantContext,
  buildWorkflowAssistantContext,
  createAssistantDraftVersion,
} from "./assistantContext";
import { buildAssistantRunSnapshot } from "./assistantRunSnapshot";
import { redactSecrets } from "./redactSecrets";

export interface ExecutionRunAssistantSource {
  command?: Command;
  workflow?: Workflow;
}

export interface ExecutionRunAssistant {
  runId: string;
  subjectKey: string;
  target: AssistantTarget;
  objectId: string | null;
  draftVersion: number;
  context: AssistantObjectContext<Record<string, unknown>>;
  snapshot: AssistantRunSnapshot | null;
}

function isCompleted(execution: Execution): boolean {
  return (
    execution.status === "success" ||
    execution.status === "error" ||
    execution.status === "cancelled"
  );
}

function runStatus(execution: Execution): string {
  if (execution.status === "success") return "succeeded";
  if (execution.status === "error") {
    return execution.timedOut === true ? "timedOut" : "failed";
  }
  return execution.status;
}

function executionTargetMetadata(execution: Execution): Record<string, unknown> {
  const target = execution.target;
  if (target === undefined) return { kind: "local" };
  return target.kind === "remote"
    ? { kind: "remote", alias: redactSecrets(target.alias) }
    : { kind: target.kind };
}

function commandDraft(
  execution: Execution,
  command: Command | undefined,
  run: Record<string, unknown>,
): AssistantObjectContext<Record<string, unknown>> {
  const saved = command === undefined
    ? buildCommandAssistantContext(
        {
          id: execution.commandId ?? execution.id,
          name: execution.commandName,
          script: execution.script ?? "",
          tags: [],
          favorite: false,
          createdAt: new Date(execution.startedAt).toISOString(),
          updatedAt: new Date(execution.startedAt).toISOString(),
          runCount: 0,
          runAsAdmin: false,
        },
        0,
      )
    : buildCommandAssistantContext(command, 0);

  return {
    ...saved,
    draft: {
      ...saved.draft,
      assistantMode: "completedRunAnalysis",
      draftIsReadOnly: true,
      // The console owns the exact values that were executed. They override
      // a saved command that may have changed after this run started.
      name: execution.commandName,
      script: execution.script ?? "",
      shell: execution.shell,
      workingDir: execution.workingDir,
      executionTarget: executionTargetMetadata(execution),
      executedRun: run,
    },
  };
}

function workflowDraft(
  execution: Execution,
  workflow: Workflow | undefined,
  run: Record<string, unknown>,
): AssistantObjectContext<Record<string, unknown>> {
  const context = buildWorkflowAssistantContext(
    workflow ?? {
      name: execution.commandName,
      nodes: [],
      edges: [],
      tags: [],
    },
    0,
  );

  return {
    ...context,
    draft: {
      ...context.draft,
      assistantMode: "completedRunAnalysis",
      draftIsReadOnly: true,
      executedRun: run,
    },
  };
}

export function buildExecutionRunAssistant(
  execution: Execution,
  source: ExecutionRunAssistantSource,
): ExecutionRunAssistant | null {
  if (!isCompleted(execution)) return null;

  const isWorkflow = execution.isWorkflow === true;
  const run: Record<string, unknown> = {
    runId: execution.id,
    kind: isWorkflow ? "workflow" : "command",
    status: runStatus(execution),
    startedAt: new Date(execution.startedAt).toISOString(),
    ...(execution.finishedAt !== undefined
      ? { finishedAt: new Date(execution.finishedAt).toISOString() }
      : {}),
    exitCode: execution.exitCode ?? null,
    durationMs: execution.durationMs ?? null,
    timedOut: execution.timedOut === true,
    ...(execution.pid !== undefined ? { pid: execution.pid } : {}),
    workingDir:
      execution.workingDir === undefined
        ? undefined
        : redactSecrets(execution.workingDir),
    executionTarget: executionTargetMetadata(execution),
    variables: execution.variables?.map((variable) => ({
      name: variable.name,
      value: variable.sensitive === true ? "***" : redactSecrets(variable.value),
      sensitive: variable.sensitive === true,
    })),
    ...(execution.error !== undefined
      ? { error: redactSecrets(execution.error) }
      : {}),
    outputLineCount: execution.log.length,
    outputContainsTruncationMarker: execution.log.some(
      (line) => line.stream === "meta",
    ),
    outputRedactedForSecrets: true,
  };

  const context = isWorkflow
    ? workflowDraft(execution, source.workflow, run)
    : commandDraft(execution, source.command, run);
  const target: AssistantTarget = isWorkflow ? "workflow" : "command";
  const draftVersion = createAssistantDraftVersion({
    runId: execution.id,
    draft: context.draft,
  });
  context.draftVersion = draftVersion;

  const snapshot = buildAssistantRunSnapshot({
    id: `execution-${execution.id}`,
    target,
    draftVersion,
    status: runStatus(execution),
    result: {
      status:
        execution.status === "success"
          ? "finished"
          : execution.status === "cancelled"
            ? "cancelled"
            : "failed",
      exitCode: execution.exitCode ?? null,
      durationMs: execution.durationMs ?? null,
      timedOut: execution.timedOut === true,
      lines: execution.log.map((line) => ({
        stream: line.stream === "stderr" ? "stderr" : "stdout",
        text: line.line,
      })),
    },
    outputSchema: source.command?.outputSchema,
    extracted: execution.result,
    durationMs: execution.durationMs,
  });

  return {
    runId: execution.id,
    subjectKey: `${target}:${execution.workflowId ?? execution.commandId ?? execution.id}`,
    target,
    objectId: isWorkflow ? execution.workflowId ?? null : execution.commandId ?? null,
    draftVersion,
    context,
    snapshot,
  };
}
