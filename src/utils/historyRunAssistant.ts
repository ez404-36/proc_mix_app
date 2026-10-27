// Build an assistant session for one persisted run in История.
//
// The assistant receives the same allow-listed object snapshot used by the
// editor assistants, augmented with bounded run metadata. Output always goes
// through the shared redacting run-snapshot builder; this module never sends
// the raw history event over IPC.

import type { AssistantObjectContext, AssistantTarget } from "../types/assistant";
import type {
  CommandRunEvent,
  HistoryEvent,
  QuickLaunchEvent,
  ScheduledRunEvent,
  WorkflowRunEvent,
} from "../types/history";
import { buildCommandAssistantContext } from "./assistantContext";
import { buildAssistantRunSnapshot } from "./assistantRunSnapshot";
import {
  buildWorkflowAssistantContext,
  createAssistantDraftVersion,
} from "./assistantContext";
import type { AssistantRunSnapshot } from "../types/assistant";
import type { Command } from "../types/command";
import type { Workflow } from "../types/workflow";
import { redactSecrets } from "./redactSecrets";

type RunEvent =
  | CommandRunEvent
  | WorkflowRunEvent
  | ScheduledRunEvent
  | QuickLaunchEvent;

export interface HistoryRunAssistantSubject {
  command?: Command;
  workflow?: Workflow;
}

export interface HistoryRunAssistantData {
  runId: string;
  subjectKey: string;
  target: AssistantTarget;
  objectId: string | null;
  draftVersion: number;
  context: AssistantObjectContext<Record<string, unknown>>;
  snapshot: AssistantRunSnapshot | null;
}

/** Logical command/workflow id for the run's actual (not schedule) subject. */
export function historyRunSubjectId(event: HistoryEvent): string | null {
  if (!isRunEvent(event)) return null;
  if (event.kind === "scheduledRun") return event.targetId;
  if (event.kind === "quickLaunch") return event.targetId;
  if (event.kind === "commandRun") return event.commandId;
  return event.workflowId;
}

function isRunEvent(event: HistoryEvent): event is RunEvent {
  return (
    event.kind === "commandRun" ||
    event.kind === "workflowRun" ||
    event.kind === "scheduledRun" ||
    event.kind === "quickLaunch"
  );
}

function eventTarget(event: RunEvent): {
  target: AssistantTarget;
  id: string;
  name: string;
} {
  if (event.kind === "commandRun") {
    return { target: "command", id: event.commandId, name: event.commandName };
  }
  if (event.kind === "workflowRun") {
    return {
      target: "workflow",
      id: event.workflowId,
      name: event.workflowName,
    };
  }
  return {
    target: event.targetKind,
    id: event.targetId,
    name:
      event.kind === "quickLaunch"
        ? event.targetName
        : event.targetKind === "command"
          ? "command"
          : "workflow",
  };
}

function eventStatus(event: RunEvent): string {
  if (event.kind === "commandRun" || event.kind === "workflowRun") {
    return event.status;
  }
  return event.status;
}

function isTimedOut(event: RunEvent): boolean {
  return (
    (event.kind === "commandRun" || event.kind === "workflowRun") &&
    event.timedOut === true
  );
}

function executionTargetMetadata(
  target: Command["target"],
): Record<string, unknown> | undefined {
  if (target === undefined) return { kind: "local" };
  return target.kind === "remote"
    ? { kind: "remote", alias: redactSecrets(target.alias) }
    : { kind: target.kind };
}

function commandContext(
  command: Command | undefined,
  name: string,
  metadata: Record<string, unknown>,
  draftVersion: number,
): AssistantObjectContext<Record<string, unknown>> {
  if (command === undefined) {
    return {
      target: "command",
      schemaVersion: 1,
      draftVersion,
      draft: {
        target: "command",
        name,
        script: "",
        tags: [],
        runsAsAdmin: false,
        isArchived: true,
        historicalRun: metadata,
      },
    };
  }

  const context = buildCommandAssistantContext(command, draftVersion);
  return {
    ...context,
    draft: {
      ...context.draft,
      isArchived: false,
      historicalRun: metadata,
    },
  };
}

export function buildHistoryRunAssistant(
  event: HistoryEvent,
  subject: HistoryRunAssistantSubject,
): HistoryRunAssistantData | null {
  if (!isRunEvent(event)) return null;

  const target = eventTarget(event);
  const targetName =
    event.kind === "scheduledRun"
      ? (target.target === "command"
          ? subject.command?.name
          : subject.workflow?.name) ?? target.name
      : target.name;
  const output = event.output ?? [];
  const definition =
    target.target === "command" ? subject.command : subject.workflow;
  const definitionUpdatedAfterRun =
    definition !== undefined && definition.updatedAt > event.createdAt;
  const hasMetadata =
    event.kind !== "commandRun" && event.kind !== "workflowRun";
  const metadata: Record<string, unknown> = {
    eventId: event.id,
    status: eventStatus(event),
    exitCode: event.exitCode ?? null,
    timedOut: isTimedOut(event),
    startedAt: event.createdAt,
    ...(event.durationMs !== undefined
      ? { durationMs: event.durationMs }
      : {}),
    ...(event.kind === "commandRun"
      ? { executionTarget: executionTargetMetadata(event.target) }
      : {}),
    ...(hasMetadata && event.kind === "scheduledRun"
      ? {
          source: "schedule",
          scheduleName: redactSecrets(event.scheduleName),
          manual: event.manual,
        }
      : {}),
    ...(hasMetadata && event.kind === "quickLaunch"
      ? {
          source: event.source,
          ...(event.selectedPath !== undefined
            ? { selectedPath: redactSecrets(event.selectedPath) }
            : {}),
        }
      : {}),
    outputCaptured: event.output !== undefined,
    outputLineCount: output.length,
    outputPersistedCharacters: output.reduce(
      (total, line) => total + line.line.length,
      0,
    ),
    outputContainsTruncationMarker: output.some(
      (line) => line.stream === "meta",
    ),
    resultCaptured: event.result !== undefined,
    outputRedactedForSecrets: true,
    definitionUpdatedAfterRun,
  };

  const baseContext =
    target.target === "command"
      ? commandContext(
          subject.command,
          targetName,
          metadata,
          0,
        )
      : buildWorkflowAssistantContext(
          subject.workflow ?? {
            name: targetName,
            nodes: [],
            edges: [],
            tags: [],
          },
          0,
        );

  const context: AssistantObjectContext<Record<string, unknown>> = {
    ...baseContext,
    draft: {
      ...baseContext.draft,
      definitionIsAtRunTime: !definitionUpdatedAfterRun,
      historicalRun: metadata,
    },
  };
  const draftVersion = createAssistantDraftVersion({
    eventId: event.id,
    draft: context.draft,
  });
  context.draftVersion = draftVersion;

  const outputSchema =
    target.target === "command" ? subject.command?.outputSchema : undefined;
  const snapshot = buildAssistantRunSnapshot({
    id: `history-${event.id}`,
    target: target.target,
    draftVersion,
    status: eventStatus(event),
    result: {
      status: "finished",
      exitCode: event.exitCode ?? null,
      durationMs: event.durationMs ?? null,
      timedOut: isTimedOut(event),
      lines: output.map((line) => ({
        stream: line.stream === "stderr" ? "stderr" : "stdout",
        text: line.line,
      })),
    },
    outputSchema,
    extracted: event.result,
    durationMs: event.durationMs,
  });

  return {
    runId: event.id,
    subjectKey: `${target.target}:${target.id}`,
    target: target.target,
    objectId: target.id,
    draftVersion,
    context,
    snapshot,
  };
}
