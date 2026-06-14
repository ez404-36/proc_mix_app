// Resolve the "example input" and "example result" payloads shown in the
// node-editor modal's two preview columns. These reflect ACTUAL data from the
// most recent editor run when available: a command-bearing node carries the
// `executionId` of its underlying command run on the active workflow run, and
// that execution's captured stdout / structured result lives in
// `executionStore`. A node's INPUT is its single predecessor's RESULT (the
// value handed down the path), so the same resolution is applied to the
// predecessor.
//
// This module is pure: callers pass the already-read store slices so it has no
// store dependency and stays unit-testable.

import type {
  Command,
  DataAssignment,
  DataSource,
  ExtractedResult,
  OutputSchema,
} from "../types";
import type { WorkflowNodeOutput } from "../stores/workflowRunStore";
import type { WorkflowFlowNode } from "./workflowGraph";

/** Max characters of raw stdout to surface in a preview pane (a tail beyond
 * this is elided). Keeps a chatty command from flooding the modal. */
const MAX_PREVIEW_CHARS = 4000;

/**
 * A node's resolved run output, ready to render in a preview pane. Both
 * representations are kept so the preview column can offer a raw/schema tab
 * toggle when both exist:
 *   - `structured` → the command's extracted output-schema result, when it
 *      declared a schema and extraction succeeded.
 *   - `text`       → the joined stdout (+ stderr) lines (the raw output).
 * Both absent → the node produced no capturable output this run (e.g. it has
 * not run yet, or is a non-command kind). `truncated` flags an elided raw tail.
 */
export interface NodeRunOutput {
  structured?: ExtractedResult;
  text?: string;
  truncated: boolean;
}

/**
 * Resolve the run output of a single node from its captured per-node output
 * (see `workflowRunStore.nodeOutputs`). Carries BOTH the structured extraction
 * (when present) and the raw stdout text, so the preview can toggle between
 * them. Returns `null` when the node produced no captured output this run.
 */
export function nodeRunOutput(
  nodeOutput: WorkflowNodeOutput | undefined,
): NodeRunOutput | null {
  if (nodeOutput === undefined) return null;
  const raw = nodeOutput.stdout === "" ? undefined : nodeOutput.stdout;
  let text: string | undefined = raw;
  let truncated = false;
  if (raw !== undefined && raw.length > MAX_PREVIEW_CHARS) {
    text = raw.slice(-MAX_PREVIEW_CHARS);
    truncated = true;
  }
  // Nothing at all (no stdout, no result) → treat as "no output".
  if (text === undefined && nodeOutput.result === undefined) return null;
  return {
    structured: nodeOutput.result,
    text,
    truncated,
  };
}

/** Whether a structured result holds anything renderable (it ran with a
 * schema). An extraction error still counts — it is shown to the user. */
export function hasStructured(output: NodeRunOutput | null): boolean {
  return output?.structured !== undefined;
}

/** Whether raw stdout text is available for this output. */
export function hasRaw(output: NodeRunOutput | null): boolean {
  return output?.text !== undefined && output.text !== "";
}

/** Render the structured result to a pretty-printed display string. Returns
 * an empty string when there is no structured result. */
export function structuredText(output: NodeRunOutput | null): string {
  const structured = output?.structured;
  if (structured === undefined) return "";
  const { fields, returnValue, error } = structured;
  if (error !== undefined) return error;
  // Prefer the chosen return value; fall back to the full field map.
  const value = returnValue ?? fields;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    // A value that cannot be serialised (e.g. a cyclic structure injected by
    // a future source) still shows something rather than throwing.
    return String(value);
  }
}

/** Render the raw stdout text. Returns an empty string when none. */
export function rawText(output: NodeRunOutput | null): string {
  return output?.text ?? "";
}

/**
 * The default display string for an output: the structured result when the
 * node has a schema, otherwise the raw text. Returns an empty string when
 * there is nothing to show (the caller then renders the empty-state
 * placeholder or the user's manual entry).
 */
export function previewText(output: NodeRunOutput | null): string {
  if (output === null) return "";
  if (output.structured !== undefined) return structuredText(output);
  return rawText(output);
}

/**
 * The effective output schema of a node's single predecessor — the schema the
 * predecessor uses to turn its raw stdout into structured fields:
 *   - a command-bearing predecessor → its referenced command's `outputSchema`;
 *   - a `parser` predecessor → the node's own `parser` schema.
 * Returns `undefined` when the predecessor declares no schema (or is `null`),
 * so the input column shows raw output only. Pure.
 */
export function predecessorOutputSchema(
  predecessor: WorkflowFlowNode | null,
  commands: ReadonlyArray<Command>,
): OutputSchema | undefined {
  if (predecessor === null) return undefined;
  if (predecessor.data.kind === "parser") {
    const schema = predecessor.data.parser;
    return (schema?.pipeline?.length ?? 0) > 0 ? schema : undefined;
  }
  const commandId = predecessor.data.commandId;
  if (commandId === undefined) return undefined;
  const schema = commands.find((c) => c.id === commandId)?.outputSchema;
  return (schema?.pipeline?.length ?? 0) > 0 ? schema : undefined;
}

/** Stringify an extracted field value for display in a `key = value` row. */
function fieldValueText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Resolve the DISPLAY value of one `data`-node assignment against the node's
 * input (the predecessor's output), for the read-only `key = value` result
 * block. The actual value the engine computes is shown for the sources that
 * are derivable from the input here; sources whose value is only known at run
 * time (exit code, retry count, …) fall back to a `<source>` placeholder.
 *
 *   - `manual`        → the literal the author typed.
 *   - `rawOutput`     → the input's raw text.
 *   - `schemaOutput`  → the whole extracted result (compact JSON), from
 *                       `inputResult`.
 *   - `field`         → the named extracted field, from `inputResult`.
 *   - anything else   → `placeholder(sourceKind)` (run-time-only).
 *
 * `inputRaw` is the current input raw text; `inputResult` is the structured
 * extraction of that text (or null when none). `placeholder` localizes the
 * `<source>` fallback. Pure — fully testable.
 */
export function resolveAssignmentDisplayValue(
  assignment: DataAssignment,
  inputRaw: string,
  inputResult: ExtractedResult | null,
  placeholder: (sourceKind: DataSource["kind"]) => string,
): string {
  const source: DataSource =
    assignment.source ?? { kind: "manual", value: assignment.value };
  switch (source.kind) {
    case "manual":
      return source.value;
    case "rawOutput":
      return inputRaw;
    case "schemaOutput": {
      if (inputResult === null) return placeholder("schemaOutput");
      const value = inputResult.returnValue ?? inputResult.fields;
      return fieldValueText(value);
    }
    case "field": {
      const v = inputResult?.fields?.[source.field];
      return v === undefined ? placeholder("field") : fieldValueText(v);
    }
    default:
      return placeholder(source.kind);
  }
}
