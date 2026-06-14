import type { Command, DataSource, WorkflowNodeKind } from "../types";
import type { WorkflowFlowNode } from "./workflowGraph";

/**
 * One selectable value-source for a `data` node assignment, as offered by the
 * inspector's value dropdown. `source` is the concrete {@link DataSource} the
 * assignment is set to when chosen; `labelKey` is its i18n key (a `field`
 * option additionally carries the field name for the label).
 */
export interface DataSourceOption {
  /** Stable option id for the dropdown (also the persisted discriminator). */
  id: string;
  source: DataSource;
  labelKey: string;
  /** Field name, for `field` options (interpolated into the label). */
  field?: string;
}

/** The universal "type a value yourself" option, offered for every node. */
const MANUAL_OPTION: DataSourceOption = {
  id: "manual",
  source: { kind: "manual", value: "" },
  labelKey: "editor.inspector.data.source.manual",
};

/** The two sources any command-bearing predecessor exposes. */
function commandBaseOptions(): DataSourceOption[] {
  return [
    {
      id: "rawOutput",
      source: { kind: "rawOutput" },
      labelKey: "editor.inspector.data.source.rawOutput",
    },
    {
      id: "exitCode",
      source: { kind: "exitCode" },
      labelKey: "editor.inspector.data.source.exitCode",
    },
  ];
}

/**
 * The distinct output-schema field names a command extracts, across every
 * pipeline step (deduped, order-preserving). Empty when the command has no
 * schema. These become `field` data sources.
 */
export function commandSchemaFieldNames(command: Command): string[] {
  return schemaFieldNames(command.outputSchema);
}

/** Whether a command declares an output schema at all (≥1 pipeline step).
 * The `schemaOutput` source — the WHOLE extracted result — is meaningful for
 * ANY schema, even parsers like `raw` / `keyValue` / `table` that declare no
 * named `fields`; only the per-`field` sources need declared field names. */
export function commandHasOutputSchema(command: Command): boolean {
  return (command.outputSchema?.pipeline?.length ?? 0) > 0;
}

/** Distinct field names declared across an output schema's pipeline steps
 * (deduped, order-preserving). Shared by the command and parser enumerations. */
function schemaFieldNames(
  schema: { pipeline?: ReadonlyArray<{ fields: ReadonlyArray<{ name: string }> }> } | undefined,
): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const step of schema?.pipeline ?? []) {
    for (const f of step.fields) {
      if (f.name !== "" && !seen.has(f.name)) {
        seen.add(f.name);
        names.push(f.name);
      }
    }
  }
  return names;
}

/**
 * The distinct field names a `parser` node extracts, across every pipeline
 * step (deduped, order-preserving). Empty when the node has no parser schema.
 * Mirrors {@link commandSchemaFieldNames} but reads the node's own `parser`
 * schema instead of a referenced command's.
 */
function parserFieldNames(node: WorkflowFlowNode): string[] {
  return schemaFieldNames(node.data.parser);
}

/** Whether a `parser` node declares a schema at all (≥1 pipeline step). */
function parserHasSchema(node: WorkflowFlowNode): boolean {
  return (node.data.parser?.pipeline?.length ?? 0) > 0;
}

/**
 * Build the value-source options a `data` node assignment may pick, given its
 * single resolved predecessor (or `null` when the predecessor is ambiguous —
 * zero or many). `commands` is used to enumerate a command/condition/switch/
 * try predecessor's output-schema fields.
 *
 * Always includes manual entry. For a known command-bearing predecessor it
 * adds raw output, exit code, every schema field, plus the kind-specific
 * extra (`retryCount` / `conditionResult` / `matchedCase`). A `loop`
 * predecessor offers iteration count. When the predecessor is unknown the
 * universal command-base set is offered (still useful, and the runtime
 * resolves the real previous node anyway).
 */
export function dataSourceOptions(
  predecessor: WorkflowFlowNode | null,
  commands: ReadonlyArray<Command>,
): DataSourceOption[] {
  const options: DataSourceOption[] = [MANUAL_OPTION];

  if (predecessor === null) {
    // Ambiguous / no predecessor: still offer the universal command sources.
    options.push(...commandBaseOptions());
    return options;
  }

  const kind: WorkflowNodeKind = predecessor.data.kind;

  // Loop is the only command-LESS predecessor with a source (iteration count).
  if (kind === "loop") {
    options.push({
      id: "loopIterations",
      source: { kind: "loopIterations" },
      labelKey: "editor.inspector.data.source.loopIterations",
    });
    return options;
  }

  // A `parser` node runs no command but produces extracted fields (and carries
  // the input it parsed as raw output). Offer raw output, the whole schema
  // result, and each declared field — same shapes a command's schema exposes.
  if (kind === "parser") {
    options.push({
      id: "rawOutput",
      source: { kind: "rawOutput" },
      labelKey: "editor.inspector.data.source.rawOutput",
    });
    const fields = parserFieldNames(predecessor);
    // The whole extracted result is meaningful whenever the parser has a
    // schema, even with no declared fields (raw / keyValue / table).
    if (parserHasSchema(predecessor)) {
      options.push({
        id: "schemaOutput",
        source: { kind: "schemaOutput" },
        labelKey: "editor.inspector.data.source.schemaOutput",
      });
    }
    for (const field of fields) {
      options.push({
        id: `field:${field}`,
        source: { kind: "field", field },
        labelKey: "editor.inspector.data.source.field",
        field,
      });
    }
    return options;
  }

  // A `text` node runs no command but produces its composed text as output,
  // readable downstream via `rawOutput`.
  if (kind === "text") {
    options.push({
      id: "rawOutput",
      source: { kind: "rawOutput" },
      labelKey: "editor.inspector.data.source.rawOutput",
    });
    return options;
  }

  // start / data / end produce no value of their own → manual only.
  const isCommandBearing =
    kind === "command" ||
    kind === "condition" ||
    kind === "switch" ||
    kind === "try";
  if (!isCommandBearing) {
    return options;
  }

  options.push(...commandBaseOptions());

  // Output-schema sources of the predecessor's referenced command. Offered
  // only when the command actually declares a schema (≥1 field): the whole
  // extracted result as one value, then each field individually.
  const command =
    predecessor.data.commandId === undefined
      ? undefined
      : commands.find((c) => c.id === predecessor.data.commandId);
  if (command !== undefined) {
    const fields = commandSchemaFieldNames(command);
    // The whole extracted result is meaningful whenever the command declares a
    // schema, even when it has no NAMED fields (raw / keyValue / table parsers).
    if (commandHasOutputSchema(command)) {
      options.push({
        id: "schemaOutput",
        source: { kind: "schemaOutput" },
        labelKey: "editor.inspector.data.source.schemaOutput",
      });
    }
    for (const field of fields) {
      options.push({
        id: `field:${field}`,
        source: { kind: "field", field },
        labelKey: "editor.inspector.data.source.field",
        field,
      });
    }
  }

  // Kind-specific extras.
  if (kind === "try") {
    options.push({
      id: "retryCount",
      source: { kind: "retryCount" },
      labelKey: "editor.inspector.data.source.retryCount",
    });
  } else if (kind === "condition") {
    options.push({
      id: "conditionResult",
      source: { kind: "conditionResult" },
      labelKey: "editor.inspector.data.source.conditionResult",
    });
  } else if (kind === "switch") {
    options.push({
      id: "matchedCase",
      source: { kind: "matchedCase" },
      labelKey: "editor.inspector.data.source.matchedCase",
    });
  }

  return options;
}

/** The dropdown option id for a stored {@link DataSource}. Inverse of the
 * `id` assigned in {@link dataSourceOptions}. */
export function dataSourceId(source: DataSource): string {
  return source.kind === "field" ? `field:${source.field}` : source.kind;
}
