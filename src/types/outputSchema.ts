// Output schema — describes how a command's stdout is parsed into a set
// of named fields, plus which field is the command's "return value".
//
// The schema lives on `Command` (see `command.ts`) and is reused both for
// direct runs (the OutputPanel "Result" tab) and for workflow data-flow
// (extracted fields become `${name}` variable values for the next node).
//
// The AUTHORITATIVE parsing implementation is the Rust `core::extractor`
// module — the TypeScript side never parses stdout itself. The editor
// previews extraction via the `preview_extraction` Tauri command. These
// types mirror the Rust `OutputSchemaRecord` / `OutputFieldRecord` /
// `ExtractedOutput` shapes exactly (camelCase on the wire).

/**
 * Which parser turns raw stdout into structured fields.
 *   - "raw"      → no parsing; the whole stdout string is the return value.
 *   - "lines"    → split into a list of lines (field `lines`); a declared
 *     field with an `index` locator also projects a single line.
 *   - "json"     → parse stdout as JSON; fields extracted by `path`.
 *   - "regex"    → match a pattern; each named capture group is a field.
 *   - "keyValue" → parse `key: value` / `key=value` lines into an object.
 *   - "table"    → split rows by `delimiter` into columns; the full table
 *     is the `rows` field (objects keyed by header or `col0`, `col1`, …),
 *     and a declared field with a `column` locator projects that column
 *     as an array of its values across all rows.
 */
export type OutputParserKind =
  | "raw"
  | "lines"
  | "json"
  | "regex"
  | "keyValue"
  | "table";

/**
 * A single field extracted from stdout. The meaning of the locator
 * depends on the parser:
 *   - json   → `path` (e.g. `items[0].name`).
 *   - regex  → `group` (the named capture group).
 *   - table  → `column` (header name, or numeric index as a string) →
 *     the field is the array of that column's values across all rows.
 *   - lines  → `index` (0-based line number as a string) → the field is
 *     that single line.
 * `keyValue` and `raw` ignore the locator (their field set is implied by
 * the parser).
 */
export interface OutputField {
  /** Field name → becomes the `${name}` variable for the next node. */
  name: string;
  /** JSON path locator (json parser). */
  path?: string;
  /** Named capture group (regex parser). */
  group?: string;
  /** Column name or numeric index (table parser). */
  column?: string;
  /** Line index, 0-based, as a string (lines parser). */
  index?: string;
  description?: string;
}

/**
 * A single step in a parser pipeline. Each step receives the output of
 * the previous step (or the raw stdout for the first step) and produces
 * a new value. When the input is an array, the step is applied to every
 * element and the result is an array of outputs (map semantics).
 */
export interface OutputPipelineStep {
  parser: OutputParserKind;
  /** Regex pattern (regex parser). Named groups define the fields. */
  pattern?: string;
  /**
   * Field/row delimiter (table parser) or key/value separator
   * (keyValue parser).
   */
  delimiter?: string;
  /** Whether the first table row is a header (table parser). */
  hasHeader?: boolean;
  /** Declared fields. May be empty. */
  fields: OutputField[];
}

/**
 * Declarative description of a command's stdout shape.
 *
 * Always stored as a `pipeline` of one or more steps. The first step
 * always receives the raw stdout string; each subsequent step receives
 * the output of the previous one. When a step's input is an array, the
 * step is applied to every element (map semantics).
 *
 * Legacy records persisted before the pipeline model used top-level
 * `parser` / `fields` / etc. — the Rust extractor migrates those on the
 * fly by wrapping them into a single-step pipeline.
 */
export interface OutputSchema {
  /**
   * Ordered list of parser steps. Always contains at least one step.
   * Replaces the legacy top-level `parser`/`fields` fields.
   */
  pipeline: OutputPipelineStep[];
  /**
   * Which stream to parse. MVP only supports `"stdout"`; the field is
   * reserved so a future stderr/combined source is an additive change.
   */
  source?: "stdout";
  /**
   * Name of the field used as the command's return value. Empty/absent
   * → the whole result of the last pipeline step.
   */
  returnField?: string;
  /**
   * A saved sample of stdout used to preview extraction in the editor.
   * Editor-only metadata: the backend extractor ignores it.
   */
  sample?: string;
}
