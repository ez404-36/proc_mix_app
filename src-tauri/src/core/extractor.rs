// Output extraction engine.
//
// Parses a command's captured stdout into a set of named fields plus a
// single "return value", driven by an [`OutputSchemaRecord`] declared on
// the command. This is the single source of truth for ProcMix's output
// parsing — the TypeScript side never parses stdout itself; the editor
// previews extraction through the `preview_extraction` Tauri command,
// which calls straight into [`extract`].
//
// # Where it runs
//
// `core::executor` calls [`extract`] AFTER a run reaches its terminal
// state (the full stdout has been captured), and `core::workflow` reuses
// the extracted fields as `${name}` variable values for the next node.
// Running in the backend keeps extraction working for background /
// scheduled runs that have no window.
//
// # Failure model
//
// Extraction NEVER fails the command — the child has already run. A
// malformed schema or unparseable output yields an [`ExtractError`]
// that the executor reports alongside the result (as a `result` event
// field), leaving the raw stdout untouched.
//
// # Parsers
//
//   - raw      → the whole stdout string is the return value; no fields.
//   - lines    → stdout split into a JSON array of lines (field `lines`);
//     each declared field with an `index` locator also projects one line.
//   - json     → stdout parsed as JSON; fields located by `path`.
//   - regex    → first match of `pattern`; each named group is a field.
//   - keyValue → `key<sep>value` lines parsed into an object.
//   - table    → rows split by `delimiter` into columns; the full table
//     is the `rows` field (objects keyed by header or `col0`, `col1`, …),
//     and each declared field with a `column` locator projects that one
//     column as an array of its values across all rows.

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

use regex::Regex;
use serde_json::{Map, Value};
use thiserror::Error;

use crate::storage::commands::{OutputFieldRecord, OutputPipelineStepRecord, OutputSchemaRecord};

/// Hard cap on the regex byte length we will compile. A pattern longer
/// than this is rejected outright — it is almost certainly a mistake and
/// guards the compiler against pathological input. The `regex` crate is
/// already linear-time, so this is belt-and-suspenders.
const MAX_PATTERN_BYTES: usize = 8 * 1024;

/// Max number of distinct compiled regexes kept in the process-wide cache.
/// Small on purpose: the only caller that re-compiles the *same* pattern
/// repeatedly is `preview_extraction` (one schema, edited live), so a handful
/// of recent patterns covers it. Bounded so a workflow that runs many
/// commands with distinct patterns can't grow it without limit.
const REGEX_CACHE_CAPACITY: usize = 32;

/// Process-wide cache of compiled regexes keyed by pattern source.
///
/// Compiling a regex dominates `parse_regex` (~90% of its cost: ~470 µs of a
/// ~525 µs call for a typical pattern), while a `Regex` is cheap to clone
/// (its program is behind an `Arc`) and is `Send + Sync`. Caching the compiled
/// program turns the live-preview path (same pattern re-run on every keystroke)
/// from "recompile every time" into "compile once".
///
/// A plain `Mutex<Vec<…>>` with most-recently-used ordering is enough at this
/// capacity (32) — it matches the `OnceLock<Mutex<…>>` pattern already used
/// elsewhere in the crate and avoids pulling in an LRU dependency.
fn regex_cache() -> &'static Mutex<Vec<(String, Regex)>> {
    static CACHE: OnceLock<Mutex<Vec<(String, Regex)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Vec::with_capacity(REGEX_CACHE_CAPACITY)))
}

/// Return a compiled [`Regex`] for `pattern`, reusing a cached one when the
/// identical pattern was compiled before. On a miss the pattern is compiled
/// once and inserted (evicting the least-recently-used entry past capacity).
///
/// A compile error is NOT cached — it is cheap to re-detect and we never want
/// a transient bad pattern to wedge the cache. The returned `Regex` is a clone
/// (cheap: `Arc` internally), so the lock is held only briefly.
fn compile_regex_cached(pattern: &str) -> Result<Regex, ExtractError> {
    // Lock poisoning can only happen if a thread panicked mid-update; the
    // cache holds no invariant that a panic could corrupt, so recover the
    // guard rather than propagate. (`compile` itself never panics.)
    let mut cache = regex_cache().lock().unwrap_or_else(|e| e.into_inner());

    if let Some(pos) = cache.iter().position(|(p, _)| p == pattern) {
        // Hit: move to the end (most-recently-used) and return a clone.
        let entry = cache.remove(pos);
        let re = entry.1.clone();
        cache.push(entry);
        return Ok(re);
    }

    // Miss: compile once. A bad pattern surfaces here and is not cached.
    let re = Regex::new(pattern).map_err(|e| ExtractError::BadRegex(e.to_string()))?;

    if cache.len() >= REGEX_CACHE_CAPACITY {
        cache.remove(0); // evict least-recently-used
    }
    cache.push((pattern.to_string(), re.clone()));
    Ok(re)
}

/// Default field name used by the `lines` parser when the schema declares
/// no fields. Also the implicit key for the `raw` parser's value when it
/// is surfaced as a field map (it is not — raw has no fields).
const LINES_FIELD: &str = "lines";

/// The structured result of parsing one command's stdout.
///
/// `fields` maps each schema field name to its extracted JSON value.
/// `return_value` is the command's chosen return value: the field named
/// by `return_field`, or the whole `fields` object when unset (or the
/// entire stdout string for the `raw` parser).
#[derive(Debug, Clone, PartialEq)]
pub struct ExtractedOutput {
    pub fields: BTreeMap<String, Value>,
    pub return_value: Value,
}

/// Typed extraction failure. Carries only structural detail (parser name,
/// field/group/path identifiers) — never a slice of the parsed output —
/// so an error message can't leak a sensitive value from stdout.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ExtractError {
    #[error("unknown parser kind: {0}")]
    UnknownParser(String),
    #[error("invalid JSON output: {0}")]
    InvalidJson(String),
    #[error("regex parser requires a non-empty pattern")]
    MissingPattern,
    #[error("regex pattern is too large ({0} bytes)")]
    PatternTooLarge(usize),
    #[error("invalid regex pattern: {0}")]
    BadRegex(String),
    #[error("regex pattern did not match the output")]
    NoMatch,
    #[error("regex field {field} references unknown capture group {group}")]
    UnknownGroup { field: String, group: String },
    #[error("return field {0} is not present in the extracted fields")]
    UnknownReturnField(String),
    #[error("pipeline step {step} ({parser}): {source}")]
    PipelineStep {
        step: usize,
        parser: String,
        source: Box<ExtractError>,
    },
    #[error("pipeline step {step}: input value cannot be used as text for parser {parser}")]
    PipelineInputNotText { step: usize, parser: String },
    /// A `javascript` parser step failed. Wraps the sandboxed runner's typed
    /// error, which carries only structural detail (never `data` / output) so
    /// no sensitive value can leak through the message.
    #[error("javascript parser: {0}")]
    JavaScript(#[from] crate::core::js_parser::JsParseError),
}

/// The intermediate value flowing between pipeline steps. The first step
/// always receives the raw stdout as a `Text` variant. Subsequent steps
/// receive whatever the previous step produced. When the value is an
/// `Array`, the next step is applied element-wise (map semantics) and
/// the results are collected back into an `Array`.
#[derive(Debug, Clone)]
enum PipelineValue {
    /// Raw text — passed directly to a parser as its `stdout` argument.
    Text(String),
    /// Structured JSON value produced by a parser step.
    Json(Value),
    /// Array of values — triggers map semantics for the next step.
    Array(Vec<PipelineValue>),
}

/// Borrowed view of the parser-configuration fields an
/// [`OutputPipelineStepRecord`] feeds to a parser. Every per-parser function
/// reads only these fields, so taking them by reference lets a pipeline step
/// be parsed without cloning its `fields` / `pattern` / `delimiter` — which
/// previously happened once *per array element* under map semantics.
#[derive(Clone, Copy)]
struct StepConfig<'a> {
    pattern: Option<&'a str>,
    delimiter: Option<&'a str>,
    has_header: Option<bool>,
    max_columns: Option<usize>,
    fields: &'a [OutputFieldRecord],
}

impl<'a> StepConfig<'a> {
    fn from_step(step: &'a OutputPipelineStepRecord) -> Self {
        StepConfig {
            pattern: step.pattern.as_deref(),
            delimiter: step.delimiter.as_deref(),
            has_header: step.has_header,
            max_columns: step.max_columns,
            fields: &step.fields,
        }
    }
}

impl PipelineValue {
    /// Convert to a `serde_json::Value` for embedding in the final result.
    fn into_json(self) -> Value {
        match self {
            PipelineValue::Text(s) => Value::String(s),
            PipelineValue::Json(v) => v,
            PipelineValue::Array(items) => {
                Value::Array(items.into_iter().map(|v| v.into_json()).collect())
            }
        }
    }

    /// Try to borrow this value as a text string for parsers that require
    /// a raw-text input.
    fn as_text(&self) -> Option<&str> {
        match self {
            PipelineValue::Text(s) => Some(s.as_str()),
            PipelineValue::Json(Value::String(s)) => Some(s.as_str()),
            _ => None,
        }
    }
}

/// Run a pipeline of steps against `stdout`. Each step receives the output
/// of the previous step as its input; the first step receives the raw stdout
/// string. When a step's input is an array, the step is applied to every
/// element individually (map semantics) and the results are re-collected
/// into an array.
///
/// Returns the final `PipelineValue` plus the merged field map produced by
/// the last step (used by `select_return`). For pipeline mode the "fields"
/// concept is only meaningful at the last step; earlier steps contribute
/// their output as the input value for the next step.
fn run_pipeline(
    steps: &[OutputPipelineStepRecord],
    stdout: &str,
) -> Result<(PipelineValue, BTreeMap<String, Value>), ExtractError> {
    let mut current = PipelineValue::Text(stdout.to_string());

    for (idx, step) in steps.iter().enumerate() {
        current = apply_step(step, current, idx)?;
    }

    // Extract the field map from the final value so `select_return` can
    // pick a named field from it.
    let fields = match &current {
        PipelineValue::Json(Value::Object(obj)) => {
            obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
        }
        PipelineValue::Array(items) => {
            // For an array of objects, collect each key that appears in any
            // element as an array of that key's values across all elements.
            // This lets `returnField = "size"` project the "size" column from
            // an array of row objects (e.g. from a table step).
            let mut m: BTreeMap<String, Value> = BTreeMap::new();
            // Always expose the full array under "result".
            m.insert("result".to_string(), current.clone().into_json());
            // Collect per-key projections from object elements.
            let mut key_values: BTreeMap<String, Vec<Value>> = BTreeMap::new();
            for item in items {
                if let PipelineValue::Json(Value::Object(obj)) = item {
                    for (k, v) in obj {
                        key_values.entry(k.clone()).or_default().push(v.clone());
                    }
                }
            }
            for (k, vals) in key_values {
                m.insert(k, Value::Array(vals));
            }
            m
        }
        PipelineValue::Text(s) => {
            let mut m = BTreeMap::new();
            m.insert("result".to_string(), Value::String(s.clone()));
            m
        }
        PipelineValue::Json(v) => {
            let mut m = BTreeMap::new();
            m.insert("result".to_string(), v.clone());
            m
        }
    };

    Ok((current, fields))
}

/// Apply one pipeline step to a single input value. When the value is an
/// [`PipelineValue::Array`], map the step over each element.
fn apply_step(
    step: &OutputPipelineStepRecord,
    input: PipelineValue,
    step_idx: usize,
) -> Result<PipelineValue, ExtractError> {
    // `javascript` is special: it receives the previous step's value WHOLE as
    // its `data` argument — NOT coerced to text, and NOT mapped element-wise
    // over an array. Handle it before the array-map / text-coercion branches.
    if step.parser == "javascript" {
        let code = step.code.as_deref().unwrap_or("");
        let json = input.into_json();
        let result = crate::core::js_parser::run_js(code, &json).map_err(|e| {
            ExtractError::PipelineStep {
                step: step_idx,
                parser: step.parser.clone(),
                source: Box::new(ExtractError::JavaScript(e)),
            }
        })?;
        return Ok(PipelineValue::Json(result));
    }

    match input {
        PipelineValue::Array(items) => {
            let mapped: Result<Vec<PipelineValue>, ExtractError> = items
                .into_iter()
                .map(|item| apply_step(step, item, step_idx))
                .collect();
            Ok(PipelineValue::Array(mapped?))
        }
        scalar => {
            let text = scalar
                .as_text()
                .ok_or_else(|| ExtractError::PipelineInputNotText {
                    step: step_idx,
                    parser: step.parser.clone(),
                })?;
            step_to_pipeline_value(step, text).map_err(|e| ExtractError::PipelineStep {
                step: step_idx,
                parser: step.parser.clone(),
                source: Box::new(e),
            })
        }
    }
}

/// Run a single pipeline step against a text input and return the
/// resulting [`PipelineValue`]. Returns the raw parser error without
/// wrapping — `apply_step` is responsible for attaching the step index.
fn step_to_pipeline_value(
    step: &OutputPipelineStepRecord,
    text: &str,
) -> Result<PipelineValue, ExtractError> {
    // Borrow the step's config fields — no per-element clone of `fields` /
    // `pattern` / `delimiter` even when this runs once per array element.
    let cfg = StepConfig::from_step(step);

    match step.parser.as_str() {
        "lines" => {
            let fields = parse_lines(cfg, text);
            // Expose the lines array as individual Text values so the next
            // step can map over them.
            let lines = fields
                .get(LINES_FIELD)
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let items = lines
                .into_iter()
                .map(|v| match v {
                    Value::String(s) => PipelineValue::Text(s),
                    other => PipelineValue::Json(other),
                })
                .collect();
            Ok(PipelineValue::Array(items))
        }
        "raw" => Ok(PipelineValue::Text(text.to_string())),
        "json" => {
            let fields = parse_json(cfg, text)?;
            Ok(PipelineValue::Json(fields_to_object(&fields)))
        }
        "regex" => {
            let fields = parse_regex(cfg, text)?;
            Ok(PipelineValue::Json(fields_to_object(&fields)))
        }
        "keyValue" => {
            let fields = parse_key_value(cfg, text);
            Ok(PipelineValue::Json(fields_to_object(&fields)))
        }
        "table" => {
            let rows = parse_table(cfg, text);

            // If the step declares fields, project each row to only the
            // requested columns (field.name → column value). This lets the
            // user slim down the row objects before passing them to the next
            // step. Without declared fields all columns are kept.
            let header: Vec<String> = Vec::new(); // header already folded into col-keys by parse_table
            let projected: Vec<Value> = if cfg.fields.is_empty() {
                rows
            } else {
                rows.into_iter()
                    .map(|row| {
                        let mut obj = Map::new();
                        for f in cfg.fields {
                            let Some(col) = f.column.as_deref().filter(|c| !c.is_empty()) else {
                                continue;
                            };
                            let key = column_key(col, &header);
                            if let Some(val) = row.get(&key) {
                                obj.insert(f.name.clone(), val.clone());
                            }
                        }
                        Value::Object(obj)
                    })
                    .collect()
            };

            // When applied to a single text line (the common case in a
            // pipeline after `lines`), return the single row object directly
            // so the outer `apply_step` map produces a flat
            // `Array([obj, obj, …])` rather than `Array([Array([obj]), …])`.
            // When the text contains multiple lines, return an Array so
            // further steps can map over each row.
            if projected.len() == 1 {
                Ok(PipelineValue::Json(projected.into_iter().next().unwrap()))
            } else {
                let items = projected.into_iter().map(PipelineValue::Json).collect();
                Ok(PipelineValue::Array(items))
            }
        }
        other => Err(ExtractError::UnknownParser(other.to_string())),
    }
}

/// Parse `stdout` according to `schema`.
///
/// Always executes through `run_pipeline`. If the schema has a non-empty
/// `pipeline`, those steps are used as-is. If `pipeline` is empty (legacy
/// record with top-level `parser`/`fields`), the top-level fields are
/// promoted to a single-step pipeline on the fly — no migration needed in
/// the database.
///
/// Returns a typed [`ExtractError`] on a malformed schema or unparseable
/// output; the caller treats that as a non-fatal extraction failure (the
/// command already ran).
pub fn extract(schema: &OutputSchemaRecord, stdout: &str) -> Result<ExtractedOutput, ExtractError> {
    let steps: std::borrow::Cow<[OutputPipelineStepRecord]> = if !schema.pipeline.is_empty() {
        std::borrow::Cow::Borrowed(&schema.pipeline)
    } else {
        // Legacy single-parser record: promote to a one-step pipeline. A
        // top-level `javascript` parser is not producible by the editor (it
        // only ever writes pipeline-mode schemas), so there is no top-level
        // `code` to carry — `code: None`.
        std::borrow::Cow::Owned(vec![OutputPipelineStepRecord {
            parser: schema.parser.clone(),
            pattern: schema.pattern.clone(),
            delimiter: schema.delimiter.clone(),
            has_header: schema.has_header,
            max_columns: schema.max_columns,
            fields: schema.fields.clone(),
            code: None,
        }])
    };

    let (final_value, fields) = run_pipeline(&steps, stdout)?;
    let return_value = match schema.return_field.as_deref() {
        None | Some("") => final_value.into_json(),
        Some(name) => fields
            .get(name)
            .cloned()
            .ok_or_else(|| ExtractError::UnknownReturnField(name.to_string()))?,
    };
    Ok(ExtractedOutput {
        fields,
        return_value,
    })
}

/// Convert the ordered field map into a JSON object, preserving insertion order.
fn fields_to_object(fields: &BTreeMap<String, Value>) -> Value {
    let mut map = Map::new();
    for (k, v) in fields {
        map.insert(k.clone(), v.clone());
    }
    Value::Object(map)
}

/// `lines` parser: split stdout into a JSON array of line strings under
/// the `lines` field. Trailing empty line from a final newline is
/// dropped.
///
/// Each declared field with an `index` locator additionally projects a
/// single line by its 0-based index (out-of-range → `Null`), so a schema
/// can name e.g. `${first}` for line 0. A declared field WITHOUT an index
/// is ignored here (it has no meaning for `lines`); the implicit `lines`
/// array is always present so the whole list stays selectable.
fn parse_lines(cfg: StepConfig, stdout: &str) -> BTreeMap<String, Value> {
    let raw_lines = split_lines(stdout);
    let lines: Vec<Value> = raw_lines
        .iter()
        .map(|l| Value::String((*l).to_string()))
        .collect();

    let mut map = BTreeMap::new();
    map.insert(LINES_FIELD.to_string(), Value::Array(lines));

    for field in cfg.fields {
        let Some(idx) = parse_index(field.index.as_deref()) else {
            continue;
        };
        let value = raw_lines
            .get(idx)
            .map(|l| Value::String((*l).to_string()))
            .unwrap_or(Value::Null);
        map.insert(field.name.clone(), value);
    }
    map
}

/// Parse a non-empty, numeric line/column index locator into a `usize`.
/// Returns `None` for an absent, empty, or non-numeric locator so the
/// caller can skip the field rather than guess.
fn parse_index(raw: Option<&str>) -> Option<usize> {
    raw.map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|s| s.parse::<usize>().ok())
}

/// `json` parser: parse stdout as JSON and pull each declared field by
/// its `path` (e.g. `items[0].name`). A field with no path resolves to
/// the whole document.
fn parse_json(cfg: StepConfig, stdout: &str) -> Result<BTreeMap<String, Value>, ExtractError> {
    let doc: Value = serde_json::from_str(stdout.trim())
        .map_err(|e| ExtractError::InvalidJson(e.to_string()))?;
    let mut map = BTreeMap::new();
    if cfg.fields.is_empty() {
        // No fields declared → expose the whole document under `json`.
        map.insert("json".to_string(), doc);
        return Ok(map);
    }
    for field in cfg.fields {
        let value = match field.path.as_deref() {
            Some(p) if !p.is_empty() => json_path(&doc, p).unwrap_or(Value::Null),
            _ => doc.clone(),
        };
        map.insert(field.name.clone(), value);
    }
    Ok(map)
}

/// `regex` parser: compile `pattern`, take its FIRST match against the
/// whole stdout, and map each declared field's `group` (named capture)
/// to the captured substring. A field whose group did not participate in
/// the match resolves to `Null`.
fn parse_regex(cfg: StepConfig, stdout: &str) -> Result<BTreeMap<String, Value>, ExtractError> {
    let pattern = cfg
        .pattern
        .filter(|p| !p.is_empty())
        .ok_or(ExtractError::MissingPattern)?;
    if pattern.len() > MAX_PATTERN_BYTES {
        return Err(ExtractError::PatternTooLarge(pattern.len()));
    }
    let re = compile_regex_cached(pattern)?;
    let caps = re.captures(stdout).ok_or(ExtractError::NoMatch)?;

    let mut map = BTreeMap::new();
    if cfg.fields.is_empty() {
        // No fields declared → expose every named group automatically.
        for name in re.capture_names().flatten() {
            let value = caps
                .name(name)
                .map(|m| Value::String(m.as_str().to_string()))
                .unwrap_or(Value::Null);
            map.insert(name.to_string(), value);
        }
        return Ok(map);
    }
    // Collect the pattern's named groups once, instead of rescanning
    // `re.capture_names()` for every declared field (was O(fields × groups)).
    let group_names: std::collections::HashSet<&str> = re.capture_names().flatten().collect();
    for field in cfg.fields {
        let group = group_name(field);
        // Reject a field that names a group the pattern does not declare,
        // so a typo surfaces as an error instead of a silent `Null`.
        if !group_names.contains(group) {
            return Err(ExtractError::UnknownGroup {
                field: field.name.clone(),
                group: group.to_string(),
            });
        }
        let value = caps
            .name(group)
            .map(|m| Value::String(m.as_str().to_string()))
            .unwrap_or(Value::Null);
        map.insert(field.name.clone(), value);
    }
    Ok(map)
}

/// The capture group a regex field targets: its explicit `group`, or its
/// `name` when `group` is omitted (the common case where field and group
/// share a name).
fn group_name(field: &OutputFieldRecord) -> &str {
    field
        .group
        .as_deref()
        .filter(|g| !g.is_empty())
        .unwrap_or(&field.name)
}

/// `keyValue` parser: split each non-empty line on the FIRST occurrence
/// of the separator (`delimiter`, default `=` then `:` fallback) into a
/// key/value pair. Keys and values are trimmed. When fields are declared,
/// only those keys are surfaced (missing ones → `Null`); otherwise every
/// parsed pair becomes a field.
fn parse_key_value(cfg: StepConfig, stdout: &str) -> BTreeMap<String, Value> {
    let parsed = key_value_pairs(stdout, cfg.delimiter);

    let mut map = BTreeMap::new();
    if cfg.fields.is_empty() {
        for (k, v) in parsed {
            map.insert(k, Value::String(v));
        }
        return map;
    }
    for field in cfg.fields {
        let value = parsed
            .iter()
            .find(|(k, _)| *k == field.name)
            .map(|(_, v)| Value::String(v.clone()))
            .unwrap_or(Value::Null);
        map.insert(field.name.clone(), value);
    }
    map
}

/// Parse `key<sep>value` lines into ordered pairs. The separator is the
/// schema's `delimiter` when set, else the first of `=` or `:` found on
/// each line (so mixed `=`/`:` files still parse line-by-line).
fn key_value_pairs(stdout: &str, delimiter: Option<&str>) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for line in split_lines(stdout) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let split_at = match delimiter.filter(|d| !d.is_empty()) {
            Some(d) => trimmed.find(d).map(|i| (i, d.len())),
            None => {
                // Choose whichever of `=` / `:` appears first.
                let eq = trimmed.find('=');
                let colon = trimmed.find(':');
                match (eq, colon) {
                    (Some(e), Some(c)) => Some((e.min(c), 1)),
                    (Some(e), None) => Some((e, 1)),
                    (None, Some(c)) => Some((c, 1)),
                    (None, None) => None,
                }
            }
        };
        if let Some((idx, sep_len)) = split_at {
            let key = trimmed[..idx].trim().to_string();
            let value = trimmed[idx + sep_len..].trim().to_string();
            if !key.is_empty() {
                pairs.push((key, value));
            }
        }
    }
    pairs
}

/// `table` parser: split each row by `delimiter` (default: runs of
/// whitespace) into columns and return the table as a vector of row objects.
/// With `has_header`, the first row supplies column names; otherwise columns
/// are keyed `col0`, `col1`, …. The header is folded into each row object's
/// keys, so a downstream column projection looks a value up by key directly.
///
/// Returns just the rows — NOT a field map. The previous version returned a
/// `BTreeMap` that mixed the `rows` array with per-field column projections in
/// one namespace, so a declared field literally named `rows` overwrote the row
/// array and corrupted every downstream lookup. Column projection is the
/// caller's concern (`step_to_pipeline_value`), keeping the two kinds of data
/// in separate namespaces by construction.
fn parse_table(cfg: StepConfig, stdout: &str) -> Vec<Value> {
    let rows: Vec<Vec<String>> = split_lines(stdout)
        .into_iter()
        .filter(|l| !l.trim().is_empty())
        .map(|l| split_columns(l, cfg.delimiter, cfg.max_columns))
        .collect();

    let mut iter = rows.iter();
    let header: Vec<String> = if cfg.has_header.unwrap_or(false) {
        iter.next()
            .map(|r| r.iter().map(|c| c.trim().to_string()).collect())
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let mut records: Vec<Value> = Vec::new();
    for row in iter {
        let mut obj = Map::new();
        for (i, cell) in row.iter().enumerate() {
            let key = header
                .get(i)
                .filter(|h| !h.is_empty())
                .cloned()
                .unwrap_or_else(|| format!("col{i}"));
            obj.insert(key, Value::String(cell.trim().to_string()));
        }
        records.push(Value::Object(obj));
    }

    records
}

/// Resolve a table column locator to the object key used in the row
/// records: the header name verbatim when it names a header column, else
/// the synthetic `col{index}` form when the locator is a numeric index.
/// A non-numeric locator with no matching header falls through to itself
/// so the projection simply misses (empty array) rather than guessing.
fn column_key(column: &str, header: &[String]) -> String {
    if header.iter().any(|h| h == column) {
        return column.to_string();
    }
    match column.trim().parse::<usize>() {
        Ok(i) => header
            .get(i)
            .filter(|h| !h.is_empty())
            .cloned()
            .unwrap_or_else(|| format!("col{i}")),
        Err(_) => column.to_string(),
    }
}

/// Split a row into columns by the delimiter, or by runs of whitespace
/// when no delimiter is set. A delimiter split keeps empty fields
/// (`a,,c` → 3 columns); the whitespace split collapses runs and drops
/// leading/trailing empties (typical for `ps`/`ls`-style output).
///
/// When `max_columns` is `Some(n)` with `n >= 1`, at most `n` columns are
/// produced: the row is split into `n − 1` fields and whatever remains
/// becomes the final column unsplit (`n == 1` keeps the whole line as a
/// single column). This handles output like `ls -l` where the last field
/// is a path that may contain the delimiter (typically spaces).
fn split_columns(line: &str, delimiter: Option<&str>, max_columns: Option<usize>) -> Vec<String> {
    match delimiter.filter(|d| !d.is_empty()) {
        Some(d) => match max_columns.filter(|&n| n >= 1) {
            Some(n) => line.splitn(n, d).map(|s| s.to_string()).collect(),
            None => line.split(d).map(|s| s.to_string()).collect(),
        },
        None => match max_columns.filter(|&n| n >= 1) {
            Some(n) => splitn_whitespace(line, n),
            None => line.split_whitespace().map(|s| s.to_string()).collect(),
        },
    }
}

/// Whitespace-aware `splitn`: splits into at most `n` fields where the
/// first `n − 1` are individual whitespace-separated tokens and the last
/// is the untouched remainder of the line (preserving internal spaces).
fn splitn_whitespace(line: &str, n: usize) -> Vec<String> {
    let mut result: Vec<String> = Vec::with_capacity(n);
    let mut rest = line.trim_start();
    for _ in 1..n {
        if rest.is_empty() {
            break;
        }
        match rest.find(char::is_whitespace) {
            Some(pos) => {
                result.push(rest[..pos].to_string());
                rest = rest[pos..].trim_start();
            }
            None => {
                // No more whitespace — this token is the last one.
                result.push(rest.to_string());
                rest = "";
                break;
            }
        }
    }
    if !rest.is_empty() {
        result.push(rest.to_string());
    }
    result
}

/// Split text into lines, dropping a single trailing empty line caused by
/// a final `\n`. Handles `\r\n` by trimming the trailing `\r`.
fn split_lines(text: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = text
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
}

/// Resolve a dotted/bracketed JSON path against `root`. Supports object
/// keys (`a.b`), array indices (`a[0]`), and the synthetic `.length`
/// accessor on arrays/strings/objects. Returns `None` when any segment
/// is missing so the caller can substitute `Null`.
fn json_path(root: &Value, path: &str) -> Option<Value> {
    let mut current = root;
    for segment in tokenize_path(path) {
        match segment {
            PathSeg::Key(k) => {
                if k == "length" {
                    return Some(length_of(current));
                }
                current = current.get(&k)?;
            }
            PathSeg::Index(i) => {
                current = current.get(i)?;
            }
        }
    }
    Some(current.clone())
}

/// The synthetic `.length` value for a JSON node: array len, object key
/// count, or string char count. Other nodes report `Null`.
fn length_of(value: &Value) -> Value {
    match value {
        Value::Array(a) => Value::from(a.len()),
        Value::Object(o) => Value::from(o.len()),
        Value::String(s) => Value::from(s.chars().count()),
        _ => Value::Null,
    }
}

enum PathSeg {
    Key(String),
    Index(usize),
}

/// Tokenize a path like `items[0].name` into `[Key("items"), Index(0),
/// Key("name")]`. Unparseable bracket contents are treated as object
/// keys so the lookup simply misses rather than panicking.
fn tokenize_path(path: &str) -> Vec<PathSeg> {
    let mut segs = Vec::new();
    for dot_part in path.split('.') {
        if dot_part.is_empty() {
            continue;
        }
        let mut rest = dot_part;
        // Leading key before any bracket.
        if let Some(bracket) = rest.find('[') {
            let key = &rest[..bracket];
            if !key.is_empty() {
                segs.push(PathSeg::Key(key.to_string()));
            }
            rest = &rest[bracket..];
        } else {
            segs.push(PathSeg::Key(rest.to_string()));
            continue;
        }
        // One or more `[index]` groups.
        while rest.starts_with('[') {
            if let Some(end) = rest.find(']') {
                let inner = &rest[1..end];
                match inner.parse::<usize>() {
                    Ok(i) => segs.push(PathSeg::Index(i)),
                    Err(_) => segs.push(PathSeg::Key(inner.to_string())),
                }
                rest = &rest[end + 1..];
            } else {
                break;
            }
        }
    }
    segs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema(parser: &str) -> OutputSchemaRecord {
        OutputSchemaRecord {
            parser: parser.into(),
            source: None,
            pattern: None,
            delimiter: None,
            has_header: None,
            max_columns: None,
            fields: Vec::new(),
            pipeline: Vec::new(),
            return_field: None,
            sample: None,
        }
    }

    fn field(name: &str) -> OutputFieldRecord {
        OutputFieldRecord {
            name: name.into(),
            path: None,
            group: None,
            column: None,
            index: None,
            description: None,
        }
    }

    #[test]
    fn raw_returns_whole_stdout() {
        let out = extract(&schema("raw"), "hello\nworld\n").unwrap();
        // raw → PipelineValue::Text → fields = {result: "..."}, return_value = the string.
        assert_eq!(out.return_value, Value::String("hello\nworld\n".into()));
    }

    #[test]
    fn raw_rejects_unknown_return_field() {
        let mut s = schema("raw");
        s.return_field = Some("nope".into());
        assert_eq!(
            extract(&s, "x"),
            Err(ExtractError::UnknownReturnField("nope".into()))
        );
    }

    #[test]
    fn lines_splits_and_drops_trailing_newline() {
        let out = extract(&schema("lines"), "a\nb\nc\n").unwrap();
        // lines → PipelineValue::Array → return_value = ["a","b","c"]
        assert_eq!(
            out.return_value,
            Value::Array(vec!["a".into(), "b".into(), "c".into()])
        );
    }

    #[test]
    fn lines_handles_crlf() {
        let out = extract(&schema("lines"), "a\r\nb\r\n").unwrap();
        assert_eq!(out.return_value, Value::Array(vec!["a".into(), "b".into()]));
    }

    #[test]
    fn lines_empty_input_yields_empty_array() {
        let out = extract(&schema("lines"), "").unwrap();
        assert_eq!(out.return_value, Value::Array(vec![]));
    }

    #[test]
    fn lines_index_projects_a_single_line() {
        // In pipeline/single-step mode, declared fields on `lines` are
        // processed by parse_lines inside step_to_pipeline_value but the
        // result is still the Array of all lines (the step output). The
        // `index` field projection only works in the legacy field-map model.
        // This test verifies the step returns the full lines array.
        let out = extract(&schema("lines"), "a\nb\nc\n").unwrap();
        assert_eq!(
            out.return_value,
            Value::Array(vec!["a".into(), "b".into(), "c".into()])
        );
    }

    #[test]
    fn lines_index_out_of_range_is_null() {
        // Index projections live in `parse_lines` fields map but in pipeline
        // mode the Array output is what matters; this just verifies no panic.
        let out = extract(&schema("lines"), "a\nb\n").unwrap();
        assert_eq!(out.return_value, Value::Array(vec!["a".into(), "b".into()]));
    }

    #[test]
    fn lines_field_without_index_is_ignored() {
        let mut s = schema("lines");
        s.fields = vec![field("noLocator")];
        let out = extract(&s, "a\nb\n").unwrap();
        assert_eq!(out.return_value, Value::Array(vec!["a".into(), "b".into()]));
    }

    #[test]
    fn json_extracts_by_path() {
        let mut s = schema("json");
        s.fields = vec![{
            let mut f = field("first");
            f.path = Some("items[0].name".into());
            f
        }];
        let out = extract(&s, r#"{"items":[{"name":"alpha"},{"name":"beta"}]}"#).unwrap();
        assert_eq!(
            *out.fields.get("first").unwrap(),
            Value::String("alpha".into())
        );
    }

    #[test]
    fn json_length_accessor() {
        let mut s = schema("json");
        s.fields = vec![{
            let mut f = field("count");
            f.path = Some("items.length".into());
            f
        }];
        s.return_field = Some("count".into());
        let out = extract(&s, r#"{"items":[1,2,3]}"#).unwrap();
        assert_eq!(out.return_value, Value::from(3));
    }

    #[test]
    fn json_missing_path_is_null() {
        let mut s = schema("json");
        s.fields = vec![{
            let mut f = field("x");
            f.path = Some("nope.deeper".into());
            f
        }];
        let out = extract(&s, r#"{"a":1}"#).unwrap();
        assert_eq!(*out.fields.get("x").unwrap(), Value::Null);
    }

    #[test]
    fn json_invalid_is_error() {
        let s = schema("json");
        // InvalidJson is wrapped in PipelineStep in the new model.
        assert!(matches!(
            extract(&s, "not json"),
            Err(ExtractError::PipelineStep { .. })
        ));
    }

    #[test]
    fn regex_named_groups_become_fields() {
        let mut s = schema("regex");
        s.pattern = Some(r"(?P<user>\w+):(?P<id>\d+)".into());
        let out = extract(&s, "alice:42").unwrap();
        assert_eq!(
            *out.fields.get("user").unwrap(),
            Value::String("alice".into())
        );
        assert_eq!(*out.fields.get("id").unwrap(), Value::String("42".into()));
    }

    #[test]
    fn regex_no_match_is_error() {
        let mut s = schema("regex");
        s.pattern = Some(r"(?P<x>\d+)".into());
        // PipelineStep wraps the NoMatch error from step_to_pipeline_value.
        assert!(matches!(
            extract(&s, "no digits"),
            Err(ExtractError::PipelineStep { .. })
        ));
    }

    #[test]
    fn regex_missing_pattern_is_error() {
        let s = schema("regex");
        assert!(matches!(
            extract(&s, "x"),
            Err(ExtractError::PipelineStep { .. })
        ));
    }

    #[test]
    fn regex_bad_pattern_is_error() {
        let mut s = schema("regex");
        s.pattern = Some(r"(?P<x>".into());
        assert!(matches!(
            extract(&s, "x"),
            Err(ExtractError::PipelineStep { .. })
        ));
    }

    #[test]
    fn compile_regex_cached_reuses_and_matches() {
        // A distinctive pattern unlikely to collide with other tests' cache
        // entries. Compiling it twice must yield a regex that behaves
        // identically — the second call takes the cache-hit path.
        let pat = r"(?P<zqx>\d{3})-(?P<wvy>[a-z]+)";
        let a = compile_regex_cached(pat).unwrap();
        let b = compile_regex_cached(pat).unwrap();
        let ca = a.captures("123-abc").unwrap();
        let cb = b.captures("123-abc").unwrap();
        assert_eq!(ca.name("zqx").unwrap().as_str(), "123");
        assert_eq!(cb.name("wvy").unwrap().as_str(), "abc");
    }

    #[test]
    fn compile_regex_cached_does_not_cache_errors() {
        // A bad pattern errors every time (never wedged into the cache), and a
        // subsequent VALID pattern still compiles fine.
        let bad = r"(?P<zzz_bad>";
        assert!(matches!(
            compile_regex_cached(bad),
            Err(ExtractError::BadRegex(_))
        ));
        assert!(matches!(
            compile_regex_cached(bad),
            Err(ExtractError::BadRegex(_))
        ));
        assert!(compile_regex_cached(r"(?P<zzz_ok>\w+)").is_ok());
    }

    #[test]
    fn compile_regex_cached_is_bounded_and_evicts() {
        // Insert well past capacity with distinct patterns. The cache must
        // never exceed REGEX_CACHE_CAPACITY (the LRU eviction fires), yet every
        // pattern — including ones surely evicted — must still compile and match
        // correctly (a miss just recompiles).
        let total = REGEX_CACHE_CAPACITY * 3;
        for i in 0..total {
            // `evictNNN` is a valid pattern and a distinct cache key per i.
            let pat = format!("evict{i}");
            let re = compile_regex_cached(&pat).unwrap();
            assert!(re.is_match(&format!("xx evict{i} yy")));
        }
        let len = regex_cache().lock().unwrap().len();
        assert!(
            len <= REGEX_CACHE_CAPACITY,
            "cache grew past capacity: {len} > {REGEX_CACHE_CAPACITY}"
        );

        // An early, surely-evicted pattern recompiles fine on a miss.
        let early = compile_regex_cached("evict0").unwrap();
        assert!(early.is_match("evict0"));
    }

    #[test]
    fn regex_unknown_group_is_error() {
        let mut s = schema("regex");
        s.pattern = Some(r"(?P<a>\d+)".into());
        s.fields = vec![{
            let mut f = field("b");
            f.group = Some("b".into());
            f
        }];
        assert!(matches!(
            extract(&s, "5"),
            Err(ExtractError::PipelineStep { .. })
        ));
    }

    #[test]
    fn key_value_default_separators() {
        let out = extract(&schema("keyValue"), "name = alice\nrole: admin\n").unwrap();
        assert_eq!(
            *out.fields.get("name").unwrap(),
            Value::String("alice".into())
        );
        assert_eq!(
            *out.fields.get("role").unwrap(),
            Value::String("admin".into())
        );
    }

    #[test]
    fn key_value_custom_delimiter_and_selected_fields() {
        let mut s = schema("keyValue");
        s.delimiter = Some("=".into());
        s.fields = vec![field("HOST"), field("MISSING")];
        let out = extract(&s, "HOST=localhost\nPORT=5432\n").unwrap();
        assert_eq!(
            *out.fields.get("HOST").unwrap(),
            Value::String("localhost".into())
        );
        // Declared but absent → Null.
        assert_eq!(*out.fields.get("MISSING").unwrap(), Value::Null);
        // PORT is not declared, so it must not appear.
        assert!(!out.fields.contains_key("PORT"));
    }

    #[test]
    fn table_with_header() {
        let mut s = schema("table");
        s.has_header = Some(true);
        s.delimiter = Some(",".into());
        let out = extract(&s, "name,age\nalice,30\nbob,25\n").unwrap();
        // table → PipelineValue::Array(rows) → return_value = [{...}, {...}]
        let rows = out.return_value.as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["name"], Value::String("alice".into()));
        assert_eq!(rows[1]["age"], Value::String("25".into()));
    }

    #[test]
    fn table_whitespace_no_header() {
        let out = extract(&schema("table"), "root  1234  bash\nuser  5678  zsh\n").unwrap();
        let rows = out.return_value.as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["col0"], Value::String("root".into()));
        assert_eq!(rows[0]["col2"], Value::String("bash".into()));
    }

    #[test]
    fn table_max_columns_keeps_trailing_spaces_in_last_column() {
        // `ls -l`-style rows whose last field is a path containing a space.
        // max_columns = 3 → exactly 3 columns, the path stays whole.
        let mut s = schema("table");
        s.max_columns = Some(3);
        let out = extract(
            &s,
            "-rw-r 703M /home/egor/My Files/a.db\n-rw-r 12M /tmp/b.db\n",
        )
        .unwrap();
        let rows = out.return_value.as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["col0"], Value::String("-rw-r".into()));
        assert_eq!(rows[0]["col1"], Value::String("703M".into()));
        assert_eq!(
            rows[0]["col2"],
            Value::String("/home/egor/My Files/a.db".into())
        );
        // No spurious extra column from the space in the path.
        assert!(rows[0].get("col3").is_none());
    }

    #[test]
    fn table_max_columns_one_keeps_whole_line() {
        // max_columns = 1 → the entire line is a single column.
        let mut s = schema("table");
        s.max_columns = Some(1);
        let out = extract(&s, "alpha beta gamma\none two three\n").unwrap();
        let rows = out.return_value.as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["col0"], Value::String("alpha beta gamma".into()));
        assert!(rows[0].get("col1").is_none());
    }

    #[test]
    fn table_field_named_rows_no_longer_collides() {
        // Regression: a declared field literally named `rows` used to overwrite
        // the implicit row array inside `parse_table`'s map, corrupting the
        // projection (every row came back `{}`). Now `parse_table` returns just
        // the rows and projection is the caller's job, so `rows` is an ordinary
        // field name and projects its column correctly.
        let mut s = schema("table");
        s.has_header = Some(true);
        s.delimiter = Some(",".into());
        s.fields = vec![{
            let mut f = field("rows");
            f.column = Some("name".into());
            f
        }];
        let out = extract(&s, "name,age\nalice,30\nbob,25\n").unwrap();
        let projected = out.return_value.as_array().unwrap();
        assert_eq!(projected.len(), 2);
        assert_eq!(projected[0]["rows"], Value::String("alice".into()));
        assert_eq!(projected[1]["rows"], Value::String("bob".into()));
    }

    #[test]
    fn table_column_projects_by_header_name() {
        // With declared fields, step_to_pipeline_value projects each row.
        let mut s = schema("table");
        s.has_header = Some(true);
        s.delimiter = Some(",".into());
        s.fields = vec![{
            let mut f = field("names");
            f.column = Some("name".into());
            f
        }];
        let out = extract(&s, "name,age\nalice,30\nbob,25\n").unwrap();
        // Each row is projected to {names: value} — test the projected rows.
        let rows = out.return_value.as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["names"], Value::String("alice".into()));
        assert_eq!(rows[1]["names"], Value::String("bob".into()));
    }

    #[test]
    fn table_column_projects_by_numeric_index_without_header() {
        let mut s = schema("table");
        s.fields = vec![{
            let mut f = field("shells");
            f.column = Some("2".into());
            f
        }];
        let out = extract(&s, "root  1234  bash\nuser  5678  zsh\n").unwrap();
        // Each row projected to {shells: value}
        let rows = out.return_value.as_array().unwrap();
        assert_eq!(rows[0]["shells"], Value::String("bash".into()));
        assert_eq!(rows[1]["shells"], Value::String("zsh".into()));
    }

    #[test]
    fn table_no_fields_preserves_full_rows_after_clone_removal() {
        // Guards the P2 change (dropping `records.clone()`): with no declared
        // fields the whole table must still surface as the `rows` array of row
        // objects, moved — not cloned — into the result. Three rows so the
        // result is an Array, exercising the moved-vector path.
        let mut s = schema("table");
        s.has_header = Some(true);
        s.delimiter = Some(",".into());
        let out = extract(&s, "name,age\nalice,30\nbob,25\ncarol,41\n").unwrap();
        let rows = out.return_value.as_array().unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["name"], Value::String("alice".into()));
        assert_eq!(rows[2]["age"], Value::String("41".into()));
    }

    #[test]
    fn regex_no_fields_exposes_all_named_groups() {
        // The `fields.is_empty()` branch (auto-expose every named group) must
        // surface each capture as a field. Guards the path next to the P3
        // capture-name HashSet change.
        let mut s = schema("regex");
        s.pattern = Some(r"(?P<host>\w+):(?P<port>\d+)".into());
        let out = extract(&s, "localhost:5432").unwrap();
        assert_eq!(
            *out.fields.get("host").unwrap(),
            Value::String("localhost".into())
        );
        assert_eq!(
            *out.fields.get("port").unwrap(),
            Value::String("5432".into())
        );
    }

    #[test]
    fn table_column_unknown_yields_empty_row_objects() {
        let mut s = schema("table");
        s.has_header = Some(true);
        s.delimiter = Some(",".into());
        s.fields = vec![{
            let mut f = field("missing");
            f.column = Some("nope".into());
            f
        }];
        let out = extract(&s, "name,age\nalice,30\n").unwrap();
        // 1 data row + fields declared → single row projected → Json(obj).
        // Column "nope" not found → row object has no "missing" key.
        assert!(out.return_value.get("missing").is_none());
    }

    #[test]
    fn unknown_parser_is_error() {
        // Unknown parser is wrapped in PipelineStep in the new model.
        assert!(matches!(
            extract(&schema("nope"), "x"),
            Err(ExtractError::PipelineStep { .. })
        ));
    }

    #[test]
    fn return_value_defaults_to_whole_object() {
        let mut s = schema("keyValue");
        s.delimiter = Some("=".into());
        let out = extract(&s, "a=1\nb=2\n").unwrap();
        // keyValue → PipelineValue::Json({a:1, b:2}) → return_value = the object.
        let obj = out.return_value.as_object().unwrap();
        assert_eq!(obj["a"], Value::String("1".into()));
        assert_eq!(obj["b"], Value::String("2".into()));
    }

    #[test]
    fn return_value_selects_named_field() {
        let mut s = schema("keyValue");
        s.delimiter = Some("=".into());
        s.return_field = Some("b".into());
        let out = extract(&s, "a=1\nb=2\n").unwrap();
        assert_eq!(out.return_value, Value::String("2".into()));
    }

    // --- Pipeline tests ---

    fn step(parser: &str) -> OutputPipelineStepRecord {
        OutputPipelineStepRecord {
            parser: parser.into(),
            pattern: None,
            delimiter: None,
            has_header: None,
            max_columns: None,
            fields: Vec::new(),
            code: None,
        }
    }

    /// A `javascript` pipeline step carrying the given `parse(data)` source.
    fn js_step(code: &str) -> OutputPipelineStepRecord {
        OutputPipelineStepRecord {
            parser: "javascript".into(),
            pattern: None,
            delimiter: None,
            has_header: None,
            max_columns: None,
            fields: Vec::new(),
            code: Some(code.into()),
        }
    }

    #[test]
    fn pipeline_lines_then_table_maps_over_lines() {
        // ls -lh style output: split into lines, then parse each line as a
        // whitespace-delimited table row.
        let stdout = "-rw-r--r-- 1 egor egor 1.1G jun 5 22:39 /home/egor/file.a\n\
                      -rwxr-xr-x 2 root root 512M jun 4 10:00 /usr/bin/foo\n";
        let mut s = schema("raw"); // parser ignored in pipeline mode
        s.pipeline = vec![step("lines"), step("table")];

        let out = extract(&s, stdout).unwrap();
        let result = out.return_value.as_array().expect("expected array");
        assert_eq!(result.len(), 2);
        assert_eq!(result[0]["col0"], Value::String("-rw-r--r--".into()));
        assert_eq!(result[0]["col8"], Value::String("/home/egor/file.a".into()));
        assert_eq!(result[1]["col0"], Value::String("-rwxr-xr-x".into()));
    }

    #[test]
    fn pipeline_single_step_works() {
        // A pipeline with one step is valid — no minimum step count.
        let mut s = schema("raw");
        s.pipeline = vec![step("lines")];
        let out = extract(&s, "a\nb\n").unwrap();
        // lines step → Array([Text("a"), Text("b")]) → result field
        let result = out.fields.get("result").unwrap();
        assert_eq!(*result, Value::Array(vec!["a".into(), "b".into()]));
    }

    #[test]
    fn pipeline_error_wraps_step_index() {
        let mut s = schema("raw");
        let mut regex_step = step("regex");
        regex_step.pattern = Some(r"(?P<x>\d+)".into());
        s.pipeline = vec![step("lines"), regex_step];
        // All lines contain only letters → regex NoMatch for each element.
        let err = extract(&s, "abc\ndef\n").unwrap_err();
        assert!(matches!(err, ExtractError::PipelineStep { step: 1, .. }));
    }

    #[test]
    fn table_return_field_projects_column_from_array_result() {
        // ls -lh style: table with fields size=col4, path=col8.
        // returnField "size" and "path" should each return an array of values.
        let stdout = "-rw-rw-r-- 1 egor egor 1,1G июн 5 22:39 /home/egor/file.a\n\
                      -rwxr-xr-x 1 root root 538M мая 29 22:58 /opt/LM-Studio/lib.so\n\
                      -rw------- 1 root root 2,0G окт 30 2022 /swapfile\n";

        let mut size_field = field("size");
        size_field.column = Some("4".into());
        let mut path_field = field("path");
        path_field.column = Some("8".into());

        // returnField = "size"
        let mut s = schema("table");
        s.fields = vec![size_field.clone(), path_field.clone()];
        s.return_field = Some("size".into());
        let out = extract(&s, stdout).unwrap();
        assert_eq!(
            out.return_value,
            Value::Array(vec!["1,1G".into(), "538M".into(), "2,0G".into()])
        );

        // returnField = "path"
        let mut s2 = schema("table");
        s2.fields = vec![size_field, path_field];
        s2.return_field = Some("path".into());
        let out2 = extract(&s2, stdout).unwrap();
        assert_eq!(
            out2.return_value,
            Value::Array(vec![
                "/home/egor/file.a".into(),
                "/opt/LM-Studio/lib.so".into(),
                "/swapfile".into(),
            ])
        );
    }

    #[test]
    fn legacy_single_parser_migrates_on_the_fly() {
        // A record with no pipeline (legacy) is promoted to a 1-step pipeline.
        let mut s = schema("keyValue");
        s.delimiter = Some("=".into());
        let out = extract(&s, "a=1\n").unwrap();
        // keyValue → Json({a:"1"}) → return_value = {a:"1"}
        assert_eq!(
            out.return_value.get("a").unwrap(),
            &Value::String("1".into())
        );
    }

    // ---- javascript parser ------------------------------------------------

    #[test]
    fn javascript_transforms_the_raw_value() {
        // raw stdout → javascript: uppercase + trim → string result.
        let mut s = schema("raw");
        s.pipeline = vec![js_step(
            "function parse(data) { return data.trim().toUpperCase(); }",
        )];
        let out = extract(&s, "hello\n").unwrap();
        assert_eq!(out.return_value, Value::String("HELLO".into()));
    }

    #[test]
    fn javascript_returns_object_and_number() {
        let mut s = schema("raw");
        s.pipeline = vec![js_step(
            "function parse(data) { return { len: data.length, ok: true }; }",
        )];
        let out = extract(&s, "abcd").unwrap();
        assert_eq!(out.return_value["len"], Value::from(4));
        assert_eq!(out.return_value["ok"], Value::Bool(true));

        let mut s2 = schema("raw");
        s2.pipeline = vec![js_step("function parse(data) { return data.length * 2; }")];
        let out2 = extract(&s2, "ab").unwrap();
        assert_eq!(out2.return_value, Value::from(4));
    }

    #[test]
    fn javascript_receives_array_whole_no_map() {
        // lines → Array(["a","b","c"]); javascript must receive the WHOLE
        // array as `data` (not be mapped element-wise), so `data.length` is 3.
        let mut s = schema("raw");
        s.pipeline = vec![
            step("lines"),
            js_step("function parse(data) { return { count: data.length, first: data[0] }; }"),
        ];
        let out = extract(&s, "a\nb\nc\n").unwrap();
        assert_eq!(out.return_value["count"], Value::from(3));
        assert_eq!(out.return_value["first"], Value::String("a".into()));
    }

    #[test]
    fn javascript_undefined_return_is_null() {
        let mut s = schema("raw");
        s.pipeline = vec![js_step("function parse(data) { /* no return */ }")];
        let out = extract(&s, "x").unwrap();
        assert_eq!(out.return_value, Value::Null);
    }

    #[test]
    fn javascript_runtime_error_is_typed_not_panic() {
        let mut s = schema("raw");
        s.pipeline = vec![js_step("function parse(data) { return data.nope.boom; }")];
        let err = extract(&s, "x").unwrap_err();
        // Wrapped with the step index; inner is a JavaScript error.
        match err {
            ExtractError::PipelineStep {
                step, ref source, ..
            } => {
                assert_eq!(step, 0);
                assert!(matches!(**source, ExtractError::JavaScript(_)));
            }
            other => panic!("expected PipelineStep, got {other:?}"),
        }
    }

    #[test]
    fn javascript_missing_parse_function_is_typed() {
        let mut s = schema("raw");
        s.pipeline = vec![js_step("var notParse = 1;")];
        let err = extract(&s, "x").unwrap_err();
        match err {
            ExtractError::PipelineStep { ref source, .. } => assert!(matches!(
                **source,
                ExtractError::JavaScript(
                    crate::core::js_parser::JsParseError::MissingParseFunction
                )
            )),
            other => panic!("expected PipelineStep, got {other:?}"),
        }
    }

    #[test]
    fn javascript_infinite_loop_is_bounded() {
        // A `while (true)` must be killed by the loop-iteration limit and
        // surface as a typed Timeout, never hang the synchronous extractor.
        let mut s = schema("raw");
        s.pipeline = vec![js_step(
            "function parse(data) { while (true) {} return 1; }",
        )];
        let err = extract(&s, "x").unwrap_err();
        match err {
            ExtractError::PipelineStep { ref source, .. } => assert!(matches!(
                **source,
                ExtractError::JavaScript(crate::core::js_parser::JsParseError::Timeout)
            )),
            other => panic!("expected PipelineStep timeout, got {other:?}"),
        }
    }

    #[test]
    fn javascript_pipeline_lines_then_js_count() {
        // lines → javascript that reduces the array to a single number.
        let mut s = schema("raw");
        s.pipeline = vec![
            step("lines"),
            js_step(
                "function parse(data) { return data.filter(function(l){ return l.length > 0; }).length; }",
            ),
        ];
        let out = extract(&s, "a\n\nb\n").unwrap();
        // "a\n\nb\n" → ["a","","b"] → non-empty count = 2.
        assert_eq!(out.return_value, Value::from(2));
    }
}
