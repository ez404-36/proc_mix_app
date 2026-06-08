// "Save as Command" / "Save as Workflow" for the Process Capture recorder.
//
// Turns selected `CaptureRow`s into real ProcMix entities through the
// EXISTING action layer (`commandActions.createCommand` /
// `workflowActions.createWorkflow`) — this module introduces no new runtime,
// no new persistence, and no new history events. See
// `docs/process-capture.md` (Step 7).
//
// Defence in depth: the rows already carry a redacted command line (the
// store redacts at ingest), but we run `redactSecrets` ONE MORE TIME here at
// the save boundary so a future change to the store's ingest path can never
// let an un-redacted secret reach SQLite.

import type { CaptureRow } from "../stores/captureStore";
import type { Command, Shell, WorkflowEdge, WorkflowNode } from "../types";
import { redactSecrets } from "../utils/redactSecrets";
import { createCommand } from "./commandActions";
import { createWorkflow } from "./workflowActions";

/** Input accepted by `commandActions.createCommand`. */
type NewCommandInput = Parameters<typeof createCommand>[0];
/** Input accepted by `workflowActions.createWorkflow`. */
type NewWorkflowInput = Parameters<typeof createWorkflow>[0];

/**
 * Shell used for commands materialised from a capture. Process Capture is
 * Windows-only, and the captured strings are native Windows command lines,
 * so `cmd` is the faithful interpreter. The user can change it later in the
 * CommandForm.
 */
const CAPTURE_SHELL: Shell = "cmd";

/** Lowercase-free basename of an image path, used to name the command. */
function imageBasename(image: string): string {
  const base = image.split(/[/\\]/).pop() ?? image;
  // Drop a trailing .exe for a cleaner default name; keep other suffixes.
  return base.replace(/\.exe$/i, "");
}

/**
 * Build the `createCommand` input for a single captured row. The command
 * line is re-redacted here (defence in depth) before it becomes the script.
 */
export function captureRowToCommandInput(row: CaptureRow): NewCommandInput {
  const script = redactSecrets(row.commandLine);
  const name = imageBasename(row.image) || row.commandLine.slice(0, 40);
  return {
    name,
    script,
    shell: CAPTURE_SHELL,
    tags: [],
    favorite: false,
    runAsAdmin: false,
  };
}

/**
 * Create one Command per selected row. Returns the materialised commands in
 * the same order as the input rows so the caller can report a count or
 * pre-select them. No-op (empty array) when given no rows.
 */
export function saveCaptureAsCommand(rows: CaptureRow[]): Command[] {
  return rows.map((row) => createCommand(captureRowToCommandInput(row)));
}

let nodeSeq = 0;
function nextLocalId(prefix: string): string {
  nodeSeq += 1;
  return `${prefix}-${nodeSeq}`;
}

/**
 * Create a Command for every selected row, then a linear Workflow that runs
 * them in order: `start → command₁ → … → commandₙ → end`. Returns the
 * created workflow, or `null` when given no rows (nothing to build).
 *
 * Node positions are laid out left-to-right purely so the graph is legible
 * if the user later opens it in the editor; the runner ignores `position`.
 */
export function saveCaptureAsWorkflow(
  name: string,
  rows: CaptureRow[],
): ReturnType<typeof createWorkflow> | null {
  if (rows.length === 0) return null;

  // Materialise the commands first; the workflow nodes reference them by id.
  const commands = saveCaptureAsCommand(rows);

  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  const STEP_X = 220;

  const startId = nextLocalId("start");
  nodes.push({
    id: startId,
    kind: "start",
    position: { x: 0, y: 0 },
  });

  let prevId = startId;
  commands.forEach((command, index) => {
    const nodeId = nextLocalId("cmd");
    nodes.push({
      id: nodeId,
      kind: "command",
      commandId: command.id,
      label: command.name,
      position: { x: STEP_X * (index + 1), y: 0 },
    });
    edges.push({
      id: nextLocalId("edge"),
      source: prevId,
      target: nodeId,
      branch: "out",
    });
    prevId = nodeId;
  });

  const endId = nextLocalId("end");
  nodes.push({
    id: endId,
    kind: "end",
    position: { x: STEP_X * (commands.length + 1), y: 0 },
  });
  edges.push({
    id: nextLocalId("edge"),
    source: prevId,
    target: endId,
    branch: "out",
  });

  const input: NewWorkflowInput = {
    name,
    nodes,
    edges,
    tags: [],
    favorite: false,
  };
  return createWorkflow(input);
}
