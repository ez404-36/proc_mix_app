// Build a bounded, redacted snapshot of one user-initiated run.
//
// This module is the only place allowed to turn live command output into an
// assistant attachment. It intentionally accepts already-collected UI state,
// not an execution id: the assistant can never "fetch" a run by itself.

import { parseAnsiLine } from "./ansiParser";
import type { RunResult } from "../types/commandForm";
import type {
  AssistantRunSnapshot,
  AssistantTarget,
} from "../types/assistant";
import type { ExtractedResult, Execution } from "../types/execution";
import type { OutputSchema } from "../types/outputSchema";
import { REDACTION, redactSecrets } from "./redactSecrets";

/**
 * One stream may carry the full 64 KiB history/executor capture cap. The
 * backend validates each stream with the same limit, while the combined
 * history record remains capped at 64 KiB.
 */
export const ASSISTANT_RUN_SNAPSHOT_TAIL_CHARS = 64 * 1024;

export interface AssistantRunSnapshotInput {
  id: string;
  target: AssistantTarget;
  draftVersion: number;
  result: RunResult;
  status?: string;
  outputSchema?: OutputSchema;
  extracted?: ExtractedResult;
  durationMs?: number;
}

function isTerminalStatus(status: RunResult["status"]): boolean {
  return status === "finished" || status === "failed" || status === "cancelled" || status === "timedOut";
}

const SENSITIVE_FIELD_NAMES = new Set([
  "accesstoken",
  "apikey",
  "auth",
  "clientsecret",
  "password",
  "passwd",
  "pwd",
  "refreshtoken",
  "secret",
  "token",
]);

function stripAnsi(line: string): string {
  return parseAnsiLine(line)
    .map((segment) => segment.text)
    .join("");
}

function streamTail(
  result: RunResult,
  stream: "stdout" | "stderr",
): string {
  const text = result.lines
    .filter((line) => line.stream === stream)
    .map((line) => stripAnsi(line.text))
    .join("\n");
  const redacted = redactSecrets(text);
  if (redacted.length <= ASSISTANT_RUN_SNAPSHOT_TAIL_CHARS) return redacted;
  return redacted.slice(redacted.length - ASSISTANT_RUN_SNAPSHOT_TAIL_CHARS);
}

function redactUnknown(value: unknown, depth = 0): unknown {
  if (depth > 16) return "[depth limit]";
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SENSITIVE_FIELD_NAMES.has(key.toLowerCase().replace(/[-_\s]/g, ""))
          ? REDACTION
          : redactUnknown(item, depth + 1),
      ]),
    );
  }
  return value;
}

function redactOutputSchema(schema: OutputSchema): unknown {
  return redactUnknown(schema);
}

export function isAssistantRunSnapshotAvailable(
  result: Pick<RunResult, "status">,
): boolean {
  return isTerminalStatus(result.status);
}

export function buildAssistantRunSnapshot(
  input: AssistantRunSnapshotInput,
): AssistantRunSnapshot | null {
  if (!isAssistantRunSnapshotAvailable(input.result)) return null;
  return {
    id: input.id,
    target: input.target,
    draftVersion: input.draftVersion,
    createdAt: new Date().toISOString(),
    exitCode: input.result.exitCode,
    timedOut: input.result.timedOut,
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    stdoutTail: streamTail(input.result, "stdout"),
    stderrTail: streamTail(input.result, "stderr"),
    ...(input.outputSchema !== undefined
      ? { outputSchema: redactOutputSchema(input.outputSchema) }
      : {}),
    ...(input.extracted !== undefined
      ? { extractedFields: redactUnknown(input.extracted.fields) as Record<string, unknown> }
      : {}),
  };
}

export function buildExecutionRunResult(execution: Execution): RunResult {
  const status: RunResult["status"] =
    execution.status === "success"
      ? "finished"
      : execution.status === "running" || execution.status === "pending"
        ? "running"
        : execution.status === "cancelled"
          ? "cancelled"
          : "failed";
  return {
    status,
    exitCode: execution.exitCode ?? null,
    durationMs: execution.durationMs ?? null,
    timedOut: execution.timedOut === true,
    lines: execution.log
      .filter((line) => line.stream !== "meta")
      .map((line) => ({
        stream: line.stream === "stderr" ? "stderr" : "stdout",
        text: line.line,
      })),
  };
}
