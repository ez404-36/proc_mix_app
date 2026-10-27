import type { AssistantRunSnapshot } from "../types/assistant";

/** Keeps the prepared prompt below the backend's user-message limit. */
export const ASSISTANT_RUN_PROMPT_STREAM_CHARS = 3_000;
const MAX_PROMPT_STREAM_CHARS = ASSISTANT_RUN_PROMPT_STREAM_CHARS;

export interface AssistantRunSnapshotPromptLabels {
  status?: string;
  duration?: string;
  request: string;
  exit: string;
  stdout: string;
  stderr: string;
  truncated: string;
}

function streamTail(text: string, truncated: string): string {
  if (text.length <= MAX_PROMPT_STREAM_CHARS) {
    return text;
  }
  return `${truncated}\n${text.slice(-MAX_PROMPT_STREAM_CHARS)}`;
}

function fenced(label: string, text: string): string {
  return `${label}:\n\`\`\`\n${text}\n\`\`\``;
}

export function buildAssistantRunSnapshotPrompt(
  snapshot: AssistantRunSnapshot,
  labels: AssistantRunSnapshotPromptLabels,
): string {
  return [
    snapshot.status !== undefined && labels.status !== undefined
      ? `${labels.status}: ${snapshot.status}`
      : undefined,
    snapshot.durationMs !== undefined && labels.duration !== undefined
      ? `${labels.duration}: ${snapshot.durationMs} ms`
      : undefined,
    labels.request,
    labels.exit,
    fenced(labels.stdout, streamTail(snapshot.stdoutTail, labels.truncated)),
    fenced(labels.stderr, streamTail(snapshot.stderrTail, labels.truncated)),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n\n");
}
