//! Data-flow between nodes: the [`PrevOutcome`] snapshot a node leaves for the
//! next, resolving a `data` node's sources / assignments, the per-variable
//! source resolution for a command-bearing node, and the pure `parser` / `text`
//! node transforms. Everything here is a free function — fully unit-testable
//! without an executor.

use std::collections::BTreeMap;

use crate::core::executor::NodeOutcome;
use crate::core::extractor::{self, ExtractedOutput};
use crate::storage::workflows::{DataAssignmentRecord, DataSourceRecord};

/// Convert a node's extracted output fields into `${name}` variable
/// values for the next node. String values pass through verbatim; every
/// other JSON value (number, bool, array, object, null) is rendered as
/// its compact JSON text so it is still usable as a shell substitution.
/// Returns an empty map when the node produced no extraction (no schema,
/// or extraction failed).
pub(super) fn extracted_to_values(outcome: &NodeOutcome) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(extracted) = outcome.extracted.as_ref() {
        for (name, value) in &extracted.fields {
            let text = match value {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            out.insert(name.clone(), text);
        }
    }
    out
}

/// Resolve the variable values for a command-bearing node, honouring each
/// variable's explicit per-variable [`DataSourceRecord`] when the node
/// declares one in `variable_sources`.
///
/// Resolution order, per variable:
///   1. An explicit source in `variable_sources` wins. It is resolved against
///      the previous node's outcome / data-flow via [`resolve_data_source`] —
///      EXCEPT `AtRun`, which means "the user was prompted; the value arrives
///      through `node_values`", so that variable keeps its `node_values` /
///      data-flow value untouched.
///   2. A variable with no explicit source keeps the engine default: the
///      `node_values` (prompt) value over the upstream `data_flow` field
///      (same as [`merge_variable_values`]).
///
/// The executor still applies each `VariableSpec.default_value` for any name
/// absent from the returned map, so the net priority stays
/// "explicit-source / prompt > data-flow > spec default".
///
/// `loop_item` is the current element of the NEAREST enclosing `loop` node on
/// this path (see [`PathState::loop_items`] in `runner.rs`), read by a
/// `LoopItem` source; `None` when this node is not inside any loop's body (or
/// the enclosing loop has no `items` / the index is out of range).
pub(super) fn resolve_variable_values(
    variable_sources: &BTreeMap<String, DataSourceRecord>,
    node_values: Option<&BTreeMap<String, String>>,
    prev: Option<&PrevOutcome>,
    data_flow: &BTreeMap<String, String>,
    vars: &BTreeMap<String, String>,
    loop_item: Option<&str>,
) -> BTreeMap<String, String> {
    // Base layering (lowest → highest): persistent `data`-node vars, then the
    // predecessor's transient data_flow, then the node's prompt/user values.
    // So a `data`-node variable is available by name to ANY later node, while
    // a same-named predecessor field or prompt value still wins.
    let mut merged = vars.clone();
    for (k, v) in data_flow {
        merged.insert(k.clone(), v.clone());
    }
    if let Some(node_values) = node_values {
        for (k, v) in node_values {
            merged.insert(k.clone(), v.clone());
        }
    }
    for (name, source) in variable_sources {
        match source {
            // The prompt path already populated `merged` from `node_values`;
            // do not clobber it. (If no value was supplied, leaving it absent
            // lets the executor fall back to the spec default / prompt.)
            DataSourceRecord::AtRun => {}
            other => {
                merged.insert(
                    name.clone(),
                    resolve_data_source(other, prev, data_flow, vars, loop_item),
                );
            }
        }
    }
    merged
}

/// Resolve a command-bearing node's working-directory OVERRIDE from its
/// optional `working_dir_source`, honouring the same source vocabulary as
/// [`resolve_variable_values`]:
///   - `None` (no source configured) → `None`: no override, the command runs
///     with its own persisted `working_dir` (unchanged pre-feature behaviour).
///   - `AtRun` → the value the frontend collected via its working-dir prompt,
///     supplied in `node_value` (mirrors `node_values` for variables). Absent
///     or empty means "use the default", so it resolves to `None`.
///   - every other source (`manual`, `dataVar`, or a predecessor-derived one)
///     → resolved via [`resolve_data_source`] exactly like a `data` node
///     assignment. An empty resolution (inapplicable source, missing field,
///     …) degrades to `None` rather than overriding with an empty path.
pub(super) fn resolve_working_dir_override(
    source: Option<&DataSourceRecord>,
    node_value: Option<&String>,
    prev: Option<&PrevOutcome>,
    data_flow: &BTreeMap<String, String>,
    vars: &BTreeMap<String, String>,
    loop_item: Option<&str>,
) -> Option<String> {
    let source = source?;
    let resolved = match source {
        DataSourceRecord::AtRun => node_value.cloned().unwrap_or_default(),
        other => resolve_data_source(other, prev, data_flow, vars, loop_item),
    };
    if resolved.is_empty() {
        None
    } else {
        Some(resolved)
    }
}

/// Expand `${name}` references in `template` against `vars`. A reference to a
/// name not present in `vars` resolves to the EMPTY string — the same lenient
/// rule a `Variable`-subject condition uses for a missing data-flow field, so
/// the engine treats "missing field" uniformly across conditions and data
/// nodes. `$$` is a literal `$`. Non-reference text (including multibyte UTF-8)
/// passes through unchanged.
///
/// This is intentionally a small, self-contained expander rather than a reuse
/// of `parser::substitute`: that one is command-oriented (consults
/// `VariableSpec` defaults and ERRORS on a missing variable), which is the
/// wrong contract for a data node's lenient, spec-less assignment.
pub(super) fn expand_refs(template: &str, vars: &BTreeMap<String, String>) -> String {
    let bytes = template.as_bytes();
    let mut out = String::with_capacity(template.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'$' {
            // Copy this byte's char. Find the next `$` and copy the whole span
            // at once so multibyte sequences are never split.
            let next = template[i..]
                .find('$')
                .map(|off| i + off)
                .unwrap_or(template.len());
            out.push_str(&template[i..next]);
            i = next;
            continue;
        }
        // At a `$`.
        if i + 1 < bytes.len() && bytes[i + 1] == b'$' {
            out.push('$');
            i += 2;
            continue;
        }
        if i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            if let Some(close_off) = template[i + 2..].find('}') {
                let name = &template[i + 2..i + 2 + close_off];
                if let Some(v) = vars.get(name) {
                    out.push_str(v);
                }
                // Missing → empty (push nothing).
                i = i + 2 + close_off + 1;
                continue;
            }
        }
        // A lone `$` (or malformed `${` with no `}`) is kept verbatim.
        out.push('$');
        i += 1;
    }
    out
}

/// Snapshot of the node executed immediately before the current one on the
/// path the runner walked — everything a `data` node may pull a value from.
/// Built after each executed node; `None` before the first one (and after a
/// pure `data`/`start` node, which produce no outcome of their own).
#[derive(Debug, Clone, Default)]
pub(super) struct PrevOutcome {
    /// Bounded, redacted stdout tail (a command-bearing node), if any.
    pub(super) stdout_tail: Option<String>,
    /// Process exit code, if the node ran a command.
    pub(super) exit_code: Option<i32>,
    /// Named output-schema fields the node extracted (rendered as strings).
    pub(super) fields: BTreeMap<String, String>,
    /// `try` node: attempts made (1 = first-try success). `None` otherwise.
    pub(super) retry_count: Option<u32>,
    /// `condition` node: did its test pass. `None` for other kinds.
    pub(super) condition_result: Option<bool>,
    /// `switch` node: the case id taken ("default" when none matched).
    pub(super) matched_case: Option<String>,
    /// `loop` node: completed iterations at the point it exited via `done`.
    pub(super) loop_iterations: Option<u32>,
}

impl PrevOutcome {
    /// Build the command-derived part (stdout / exit / fields) from a
    /// finished node's outcome. Kind-specific extras are layered on by the
    /// caller (`retry_count`, `condition_result`, …).
    pub(super) fn from_outcome(outcome: &NodeOutcome) -> Self {
        PrevOutcome {
            stdout_tail: outcome.stdout_tail.clone(),
            exit_code: outcome.exit_code,
            fields: extracted_to_values(outcome),
            ..Default::default()
        }
    }
}

/// Resolve a single data-node source to its string value, reading from the
/// previous node's outcome when needed. A source that doesn't apply to what
/// actually ran (e.g. `RetryCount` after a plain command, or any non-`Manual`
/// source with no predecessor) resolves to the EMPTY string — the same
/// lenient "missing → empty" rule the rest of the engine uses, so a graph
/// edited into an inapplicable state degrades gracefully instead of aborting.
/// `Manual` is `${ref}`-expanded against the current data-flow (unchanged
/// legacy behaviour). `loop_item` is the current element of the NEAREST
/// enclosing `loop` node on this path (see `PathState::loop_items` in
/// `runner.rs`), read by `LoopItem`; `None` when not inside a loop's body (or
/// the loop has no `items` / the index is out of range for this iteration).
/// Pure — fully unit-testable.
pub(super) fn resolve_data_source(
    source: &DataSourceRecord,
    prev: Option<&PrevOutcome>,
    data_flow: &BTreeMap<String, String>,
    vars: &BTreeMap<String, String>,
    loop_item: Option<&str>,
) -> String {
    match source {
        DataSourceRecord::Manual { value } => expand_refs(value, data_flow),
        DataSourceRecord::RawOutput => prev.and_then(|p| p.stdout_tail.clone()).unwrap_or_default(),
        DataSourceRecord::SchemaOutput => match prev {
            // The full extracted result as one value: a compact JSON object of
            // every extracted field. Empty string when the prev node extracted
            // nothing (no schema), matching the lenient "missing → empty" rule.
            Some(p) if !p.fields.is_empty() => serde_json::to_string(&p.fields).unwrap_or_default(),
            _ => String::new(),
        },
        DataSourceRecord::ExitCode => prev
            .and_then(|p| p.exit_code)
            .map(|c| c.to_string())
            .unwrap_or_default(),
        DataSourceRecord::Field { field } => prev
            .and_then(|p| p.fields.get(field).cloned())
            .unwrap_or_default(),
        DataSourceRecord::RetryCount => prev
            .and_then(|p| p.retry_count)
            .map(|n| n.to_string())
            .unwrap_or_default(),
        DataSourceRecord::ConditionResult => prev
            .and_then(|p| p.condition_result)
            .map(|b| b.to_string())
            .unwrap_or_default(),
        DataSourceRecord::MatchedCase => prev
            .and_then(|p| p.matched_case.clone())
            .unwrap_or_default(),
        DataSourceRecord::LoopIterations => prev
            .and_then(|p| p.loop_iterations)
            .map(|n| n.to_string())
            .unwrap_or_default(),
        // The nearest enclosing loop's current item for THIS iteration.
        // Missing (not inside a loop's body, no `items` configured, or the
        // index is out of range) → empty, the same lenient rule as every
        // other inapplicable source.
        DataSourceRecord::LoopItem => loop_item.map(str::to_string).unwrap_or_default(),
        // A named variable assigned by ANY upstream `data` node, looked up in
        // the persistent `vars` map (which survives the whole run, unlike the
        // transient `data_flow` a command node replaces). Missing → empty.
        DataSourceRecord::DataVar { name } => vars.get(name).cloned().unwrap_or_default(),
        // `AtRun` carries no value of its own here: it means "the user is
        // prompted at run time and the value arrives via node_variable_values".
        // As a `data` assignment source (where there is no prompt step) it has
        // nothing to resolve, so it degrades to empty like any inapplicable
        // source. Variable-source resolution handles it separately (it never
        // calls this for `AtRun`).
        DataSourceRecord::AtRun => String::new(),
    }
}

/// Resolve a `loop` node's `items` list to the element for the given
/// (0-based) iteration index, for exposure to the body via a `LoopItem`
/// source. `None` when `items` is absent or `index` is out of range — the
/// runner then clears any previous `loop_item` entry for this node, so a
/// stale value from an earlier iteration never leaks into a shorter list's
/// tail.
pub(super) fn resolve_loop_item(items: Option<&[String]>, index: u32) -> Option<String> {
    let index = usize::try_from(index).ok()?;
    items?.get(index).cloned()
}

/// Apply a `data` node's assignments to the PERSISTENT `vars` map, in order,
/// pulling each value from its source (see [`resolve_data_source`]). A `data`
/// node does NOT produce a node result — it only records named variables that
/// stay live for the WHOLE run (a later command node replaces `data_flow` with
/// its own fields, but never touches `vars`), so any downstream node can read
/// them by name via a `dataVar` source.
///
/// Resolution reads against a scope = `vars` overlaid with the predecessor's
/// `data_flow`, so `${ref}` / `dataVar` see both earlier assignments in this
/// same node AND the immediate predecessor's fields. `loop_item` is the
/// current element of the NEAREST enclosing `loop` node on this path (see
/// [`resolve_data_source`]). Pure — unit-testable.
pub(super) fn apply_data_assignments(
    assignments: &[DataAssignmentRecord],
    prev: Option<&PrevOutcome>,
    data_flow: &BTreeMap<String, String>,
    vars: &mut BTreeMap<String, String>,
    loop_item: Option<&str>,
) {
    for a in assignments {
        // Scope for `${ref}` / dataVar: persistent vars (incl. earlier
        // assignments in this node) UNDER the predecessor's transient fields.
        let mut scope = vars.clone();
        for (k, v) in data_flow {
            scope.insert(k.clone(), v.clone());
        }
        let value = resolve_data_source(&a.effective_source(), prev, &scope, vars, loop_item);
        vars.insert(a.name.clone(), value);
    }
}

/// Project an [`ExtractedOutput`]'s fields into the `${name}` string map the
/// data-flow carries — same rule as [`extracted_to_values`] but applied to a
/// parser node's standalone extraction (which is not a `NodeOutcome`).
fn extracted_output_to_values(extracted: &ExtractedOutput) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (name, value) in &extracted.fields {
        let text = match value {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        out.insert(name.clone(), text);
    }
    out
}

/// Apply a `parser` node: run the node's output-schema pipeline over the
/// PREVIOUS node's raw stdout (the same `core::extractor` a command's output
/// schema uses), then OVERWRITE the data-flow with the freshly extracted
/// fields so downstream nodes read the parsed values. Returns the new
/// [`PrevOutcome`] the parser produces: its `fields` are the extracted fields
/// and its `stdout_tail` carries the input it parsed, so a node after the
/// parser can still pull `rawOutput` (the unparsed upstream text) if it wants.
///
/// Lenient like the rest of the engine: a parser with no schema, or a parse
/// failure, leaves the data-flow untouched and carries the input through —
/// it never aborts the run (a malformed parse is the author's concern, not a
/// crash). Pure — no executor, fully unit-testable.
pub(super) fn apply_parser_node(
    parser: Option<&crate::storage::commands::OutputSchemaRecord>,
    prev: Option<&PrevOutcome>,
    data_flow: &mut BTreeMap<String, String>,
) -> PrevOutcome {
    let input = prev.and_then(|p| p.stdout_tail.clone()).unwrap_or_default();
    let mut out = PrevOutcome {
        stdout_tail: Some(input.clone()),
        ..Default::default()
    };
    if let Some(schema) = parser {
        if let Ok(extracted) = extractor::extract(schema, &input) {
            let fields = extracted_output_to_values(&extracted);
            // Overwrite the data-flow with the parser's fields, mirroring how a
            // command-bearing node replaces data_flow with its own extraction.
            *data_flow = fields.clone();
            out.fields = fields;
        }
    }
    out
}

/// The reserved `text`-node variable that expands to the previous node's raw
/// output (`${raw_input}`).
const TEXT_RAW_INPUT_VAR: &str = "raw_input";
/// The reserved `text`-node variable that expands to the previous node's
/// extracted output schema as a compact JSON object (`${schema_input}`).
const TEXT_SCHEMA_INPUT_VAR: &str = "schema_input";

/// Apply a `text` node: expand the `${var}` references in `template` against
/// the run's variables — the persistent `data`-node vars (`vars`) overlaid
/// with the predecessor's transient `data_flow`, PLUS two reserved specials
/// for the predecessor's input: `${raw_input}` (its raw stdout, with trailing
/// newlines stripped so it composes inline) and `${schema_input}` (its
/// extracted fields as a compact JSON object). The
/// expanded string becomes this node's output (carried as `stdout_tail`), so a
/// downstream node consumes it via `rawOutput`. A missing reference expands to
/// empty (lenient, like `expand_refs` elsewhere). An absent template yields
/// empty output. Pure — fully unit-testable.
pub(super) fn apply_text_node(
    template: Option<&str>,
    prev: Option<&PrevOutcome>,
    data_flow: &BTreeMap<String, String>,
    vars: &BTreeMap<String, String>,
) -> PrevOutcome {
    // Scope = persistent vars overlaid with the predecessor's transient fields,
    // then the reserved input specials (which win, being the documented names).
    let mut scope = vars.clone();
    for (k, v) in data_flow {
        scope.insert(k.clone(), v.clone());
    }
    // `${raw_input}` is a "drop the previous output into my text" helper, so a
    // command's trailing newline (`df`, `echo`, … almost always end in `\n`)
    // is virtually never wanted INLINE — it would push following text onto a
    // new line. Strip ONLY trailing newlines; leading and internal content is
    // preserved verbatim. (The `rawOutput` data source elsewhere is left
    // byte-exact — this trim is scoped to the text node's inline insertion.)
    let raw_input = prev
        .and_then(|p| p.stdout_tail.clone())
        .map(|s| s.trim_end_matches(['\n', '\r']).to_string())
        .unwrap_or_default();
    scope.insert(TEXT_RAW_INPUT_VAR.to_string(), raw_input);
    let schema_input = match prev {
        Some(p) if !p.fields.is_empty() => serde_json::to_string(&p.fields).unwrap_or_default(),
        _ => String::new(),
    };
    scope.insert(TEXT_SCHEMA_INPUT_VAR.to_string(), schema_input);

    let expanded = expand_refs(template.unwrap_or(""), &scope);
    PrevOutcome {
        stdout_tail: Some(expanded),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_refs_substitutes_present_and_blanks_missing() {
        let mut vars = BTreeMap::new();
        vars.insert("name".into(), "world".into());
        assert_eq!(expand_refs("hi ${name}!", &vars), "hi world!");
        // Missing → empty.
        assert_eq!(expand_refs("[${absent}]", &vars), "[]");
        // `$$` is a literal `$`; a lone `$` survives.
        assert_eq!(expand_refs("cost $$5 ${name}", &vars), "cost $5 world");
        assert_eq!(expand_refs("price $ end", &vars), "price $ end");
    }

    #[test]
    fn expand_refs_preserves_multibyte_text() {
        let vars = BTreeMap::new();
        // Cyrillic + emoji around a (missing) ref must pass through intact.
        assert_eq!(expand_refs("Привет ${x}🚀", &vars), "Привет 🚀");
    }

    fn manual_assign(name: &str, value: &str) -> DataAssignmentRecord {
        DataAssignmentRecord {
            name: name.into(),
            value: value.into(),
            source: None,
        }
    }

    fn sourced_assign(name: &str, source: DataSourceRecord) -> DataAssignmentRecord {
        DataAssignmentRecord {
            name: name.into(),
            value: String::new(),
            source: Some(source),
        }
    }

    #[test]
    fn apply_data_assignments_manual_sets_and_chains() {
        // A legacy (source-less) record behaves as a manual `${ref}` template.
        // `base` comes from the predecessor's data_flow; assignments WRITE to
        // the persistent `vars` map (a data node returns no result of its own).
        let mut df = BTreeMap::new();
        df.insert("base".into(), "abc".into());
        let mut vars = BTreeMap::new();
        let assigns = vec![
            manual_assign("greeting", "hello ${base}"),
            // A later assignment sees an earlier one in the same node.
            manual_assign("loud", "${greeting}!"),
        ];
        apply_data_assignments(&assigns, None, &df, &mut vars, None);
        assert_eq!(vars.get("greeting").map(String::as_str), Some("hello abc"));
        assert_eq!(vars.get("loud").map(String::as_str), Some("hello abc!"));
        // The predecessor's data_flow is left untouched (not consumed/cleared).
        assert_eq!(df.get("base").map(String::as_str), Some("abc"));
        // The data node does NOT write `base` into vars — it only adds its own.
        assert_eq!(vars.get("base"), None);
    }

    #[test]
    fn resolve_data_source_reads_previous_outcome() {
        let prev = PrevOutcome {
            stdout_tail: Some("the output\n".into()),
            exit_code: Some(3),
            fields: BTreeMap::from([("count".to_string(), "42".to_string())]),
            retry_count: Some(2),
            condition_result: Some(true),
            matched_case: Some("prod".into()),
            loop_iterations: Some(5),
        };
        let df = BTreeMap::new();
        let vars = BTreeMap::new();
        let r = |s: DataSourceRecord| resolve_data_source(&s, Some(&prev), &df, &vars, None);
        assert_eq!(r(DataSourceRecord::RawOutput), "the output\n");
        assert_eq!(r(DataSourceRecord::ExitCode), "3");
        assert_eq!(
            r(DataSourceRecord::Field {
                field: "count".into()
            }),
            "42"
        );
        assert_eq!(r(DataSourceRecord::RetryCount), "2");
        assert_eq!(r(DataSourceRecord::ConditionResult), "true");
        assert_eq!(r(DataSourceRecord::MatchedCase), "prod");
        assert_eq!(r(DataSourceRecord::LoopIterations), "5");
    }

    #[test]
    fn resolve_data_source_loop_item_reads_the_passed_value() {
        let df = BTreeMap::new();
        let vars = BTreeMap::new();
        assert_eq!(
            resolve_data_source(&DataSourceRecord::LoopItem, None, &df, &vars, Some("b")),
            "b"
        );
        // No enclosing loop item passed → empty (lenient).
        assert_eq!(
            resolve_data_source(&DataSourceRecord::LoopItem, None, &df, &vars, None),
            ""
        );
    }

    #[test]
    fn resolve_data_source_schema_output_is_json_of_all_fields() {
        let prev = PrevOutcome {
            fields: BTreeMap::from([
                ("count".to_string(), "42".to_string()),
                ("name".to_string(), "build".to_string()),
            ]),
            ..Default::default()
        };
        let df = BTreeMap::new();
        let vars = BTreeMap::new();
        // BTreeMap → deterministic, key-sorted compact JSON object.
        assert_eq!(
            resolve_data_source(&DataSourceRecord::SchemaOutput, Some(&prev), &df, &vars, None),
            r#"{"count":"42","name":"build"}"#
        );
        // No extracted fields (schema-less command) → empty, not "{}".
        let empty = PrevOutcome {
            exit_code: Some(0),
            ..Default::default()
        };
        assert_eq!(
            resolve_data_source(&DataSourceRecord::SchemaOutput, Some(&empty), &df, &vars, None),
            ""
        );
    }

    #[test]
    fn resolve_data_source_inapplicable_is_empty_not_error() {
        // No predecessor, or a source the prev outcome doesn't carry → empty.
        let df = BTreeMap::new();
        let vars = BTreeMap::new();
        assert_eq!(
            resolve_data_source(&DataSourceRecord::ExitCode, None, &df, &vars, None),
            ""
        );
        let prev = PrevOutcome {
            exit_code: Some(0),
            ..Default::default()
        };
        // A plain command has no retry count → empty, not a crash.
        assert_eq!(
            resolve_data_source(&DataSourceRecord::RetryCount, Some(&prev), &df, &vars, None),
            ""
        );
        // A missing field → empty.
        assert_eq!(
            resolve_data_source(
                &DataSourceRecord::Field {
                    field: "nope".into()
                },
                Some(&prev),
                &df,
                &vars,
                None
            ),
            ""
        );
    }

    #[test]
    fn apply_data_assignments_pulls_from_sources() {
        let prev = PrevOutcome {
            exit_code: Some(7),
            stdout_tail: Some("hi".into()),
            ..Default::default()
        };
        let df = BTreeMap::new();
        let mut vars = BTreeMap::new();
        let assigns = vec![
            sourced_assign("code", DataSourceRecord::ExitCode),
            sourced_assign("out", DataSourceRecord::RawOutput),
            manual_assign("greeting", "code=${code}"),
        ];
        apply_data_assignments(&assigns, Some(&prev), &df, &mut vars, None);
        assert_eq!(vars.get("code").map(String::as_str), Some("7"));
        assert_eq!(vars.get("out").map(String::as_str), Some("hi"));
        // Manual source sees an earlier sourced assignment via `${ref}` (the
        // resolution scope includes vars assigned earlier in this same node).
        assert_eq!(vars.get("greeting").map(String::as_str), Some("code=7"));
    }

    #[test]
    fn data_source_record_wire_format_is_tagged_camelcase() {
        let json = serde_json::to_value(DataSourceRecord::RawOutput).unwrap();
        assert_eq!(json["kind"], "rawOutput");
        let json = serde_json::to_value(DataSourceRecord::Field { field: "x".into() }).unwrap();
        assert_eq!(json["kind"], "field");
        assert_eq!(json["field"], "x");
    }

    #[test]
    fn legacy_data_assignment_without_source_is_manual() {
        // A record persisted before `source` existed decodes with `source:
        // None` and its `effective_source` is the manual legacy value.
        let json = serde_json::json!({ "name": "v", "value": "hello" });
        let rec: DataAssignmentRecord = serde_json::from_value(json).unwrap();
        assert_eq!(rec.source, None);
        assert_eq!(
            rec.effective_source(),
            DataSourceRecord::Manual {
                value: "hello".into()
            }
        );
    }

    #[test]
    fn resolve_data_source_data_var_reads_persistent_vars() {
        // `DataVar` reads the persistent `vars` map (what any `data` node set),
        // NOT the transient data_flow or the predecessor's fields.
        let df = BTreeMap::new();
        let vars = BTreeMap::from([("token".to_string(), "abc123".to_string())]);
        assert_eq!(
            resolve_data_source(
                &DataSourceRecord::DataVar {
                    name: "token".into()
                },
                None,
                &df,
                &vars,
                None
            ),
            "abc123"
        );
        // Missing name → empty (lenient).
        assert_eq!(
            resolve_data_source(
                &DataSourceRecord::DataVar {
                    name: "nope".into()
                },
                None,
                &df,
                &vars,
                None
            ),
            ""
        );
    }

    #[test]
    fn resolve_data_source_at_run_is_empty() {
        // `AtRun` carries no value of its own through the data-source resolver.
        let df = BTreeMap::new();
        let vars = BTreeMap::new();
        assert_eq!(
            resolve_data_source(&DataSourceRecord::AtRun, None, &df, &vars, None),
            ""
        );
    }

    #[test]
    fn resolve_variable_values_honours_explicit_sources() {
        let prev = PrevOutcome {
            exit_code: Some(0),
            stdout_tail: Some("server-output".into()),
            fields: BTreeMap::from([("host".to_string(), "example.com".to_string())]),
            ..Default::default()
        };
        // data_flow carries a same-named field an explicit source overrides;
        // the persistent `vars` map carries the upstream `data` node's value
        // that a `dataVar` source reads.
        let df = BTreeMap::from([("url".to_string(), "from-data-flow".to_string())]);
        let vars = BTreeMap::from([("token".to_string(), "from-data-node".to_string())]);
        let node_values = BTreeMap::from([("secret".to_string(), "prompted".to_string())]);
        let sources = BTreeMap::from([
            (
                "url".to_string(),
                DataSourceRecord::RawOutput, // explicit → overrides data-flow
            ),
            (
                "host".to_string(),
                DataSourceRecord::Field {
                    field: "host".into(),
                },
            ),
            (
                "token".to_string(),
                DataSourceRecord::DataVar {
                    name: "token".into(),
                },
            ),
            ("secret".to_string(), DataSourceRecord::AtRun), // keep prompt value
        ]);

        let resolved =
            resolve_variable_values(&sources, Some(&node_values), Some(&prev), &df, &vars, None);
        assert_eq!(
            resolved.get("url").map(String::as_str),
            Some("server-output")
        );
        assert_eq!(
            resolved.get("host").map(String::as_str),
            Some("example.com")
        );
        assert_eq!(
            resolved.get("token").map(String::as_str),
            Some("from-data-node")
        );
        // AtRun keeps the value supplied through node_values (the prompt).
        assert_eq!(resolved.get("secret").map(String::as_str), Some("prompted"));
    }

    #[test]
    fn resolve_variable_values_layers_vars_under_data_flow_under_node_values() {
        // Layering, lowest → highest: persistent vars, predecessor data_flow,
        // then the node's prompt/user values. Same-named keys: higher wins.
        let vars = BTreeMap::from([
            ("only_var".to_string(), "v".to_string()),
            ("shared".to_string(), "from-vars".to_string()),
        ]);
        let df = BTreeMap::from([
            ("only_df".to_string(), "d".to_string()),
            ("shared".to_string(), "from-df".to_string()),
        ]);
        let node_values = BTreeMap::from([("only_node".to_string(), "n".to_string())]);
        let empty_sources = BTreeMap::new();
        let resolved =
            resolve_variable_values(&empty_sources, Some(&node_values), None, &df, &vars, None);
        // A `data`-node var reaches the node by name…
        assert_eq!(resolved.get("only_var").map(String::as_str), Some("v"));
        assert_eq!(resolved.get("only_df").map(String::as_str), Some("d"));
        assert_eq!(resolved.get("only_node").map(String::as_str), Some("n"));
        // …but the predecessor's data_flow wins over a same-named var.
        assert_eq!(resolved.get("shared").map(String::as_str), Some("from-df"));
    }

    #[test]
    fn resolve_variable_values_honours_loop_item_source() {
        let sources = BTreeMap::from([("who".to_string(), DataSourceRecord::LoopItem)]);
        let empty = BTreeMap::new();
        let resolved =
            resolve_variable_values(&sources, None, None, &empty, &empty, Some("banana"));
        assert_eq!(resolved.get("who").map(String::as_str), Some("banana"));
    }

    #[test]
    fn resolve_loop_item_indexes_by_iteration() {
        let items = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        assert_eq!(resolve_loop_item(Some(&items), 0), Some("a".to_string()));
        assert_eq!(resolve_loop_item(Some(&items), 2), Some("c".to_string()));
        // Out of range → None (the runner clears any stale value).
        assert_eq!(resolve_loop_item(Some(&items), 3), None);
        // No items configured → None.
        assert_eq!(resolve_loop_item(None, 0), None);
    }

    #[test]
    fn apply_parser_node_extracts_prev_output_into_data_flow() {
        // A regex parser with one named group, applied to the previous node's
        // raw stdout. The extracted field lands in data_flow and on the new
        // prev outcome; the input is carried through as the new stdout_tail.
        let schema: crate::storage::commands::OutputSchemaRecord =
            serde_json::from_value(serde_json::json!({
                "pipeline": [{
                    "parser": "regex",
                    "pattern": "version (?P<ver>[0-9.]+)",
                    "fields": [{ "name": "ver", "group": "ver" }]
                }],
                "returnField": "ver"
            }))
            .unwrap();
        let prev = PrevOutcome {
            stdout_tail: Some("app version 1.2.3 ready".into()),
            ..Default::default()
        };
        let mut df = BTreeMap::new();
        let out = apply_parser_node(Some(&schema), Some(&prev), &mut df);
        assert_eq!(df.get("ver").map(String::as_str), Some("1.2.3"));
        assert_eq!(out.fields.get("ver").map(String::as_str), Some("1.2.3"));
        // The parser carries the input it parsed as its raw output.
        assert_eq!(out.stdout_tail.as_deref(), Some("app version 1.2.3 ready"));
    }

    #[test]
    fn apply_parser_node_without_schema_is_lenient_passthrough() {
        // No schema → data_flow untouched, input carried through, no crash.
        let prev = PrevOutcome {
            stdout_tail: Some("untouched".into()),
            ..Default::default()
        };
        let mut df = BTreeMap::from([("keep".to_string(), "me".to_string())]);
        let out = apply_parser_node(None, Some(&prev), &mut df);
        assert_eq!(df.get("keep").map(String::as_str), Some("me"));
        assert!(out.fields.is_empty());
        assert_eq!(out.stdout_tail.as_deref(), Some("untouched"));
    }

    #[test]
    fn apply_text_node_expands_vars_and_data_flow() {
        // `${greeting}` from a data-node var, `${name}` from the predecessor's
        // data_flow; the expanded text becomes the node's output.
        let vars = BTreeMap::from([("greeting".to_string(), "Hello".to_string())]);
        let df = BTreeMap::from([("name".to_string(), "world".to_string())]);
        let out = apply_text_node(Some("${greeting}, ${name}!"), None, &df, &vars);
        assert_eq!(out.stdout_tail.as_deref(), Some("Hello, world!"));
    }

    #[test]
    fn apply_text_node_missing_ref_is_empty_and_no_template_is_empty() {
        let empty = BTreeMap::new();
        // A missing reference expands to empty (lenient).
        let out = apply_text_node(Some("a${nope}b"), None, &empty, &empty);
        assert_eq!(out.stdout_tail.as_deref(), Some("ab"));
        // No template → empty output.
        let out = apply_text_node(None, None, &empty, &empty);
        assert_eq!(out.stdout_tail.as_deref(), Some(""));
    }

    #[test]
    fn apply_text_node_expands_input_specials() {
        // `${raw_input}` → the predecessor's stdout; `${schema_input}` → its
        // extracted fields as compact JSON.
        let prev = PrevOutcome {
            stdout_tail: Some("80".into()),
            fields: BTreeMap::from([("port".to_string(), "80".to_string())]),
            ..Default::default()
        };
        let empty = BTreeMap::new();
        let out = apply_text_node(
            Some("raw=${raw_input} schema=${schema_input}"),
            Some(&prev),
            &empty,
            &empty,
        );
        assert_eq!(
            out.stdout_tail.as_deref(),
            Some(r#"raw=80 schema={"port":"80"}"#)
        );
    }

    #[test]
    fn apply_text_node_raw_input_strips_trailing_newlines() {
        // A command's trailing newline (e.g. `df` / `echo`) is stripped so the
        // value composes inline; leading/internal content is preserved.
        let prev = PrevOutcome {
            stdout_tail: Some("12G free\n\n".into()),
            ..Default::default()
        };
        let empty = BTreeMap::new();
        let out = apply_text_node(Some("[${raw_input}]"), Some(&prev), &empty, &empty);
        assert_eq!(out.stdout_tail.as_deref(), Some("[12G free]"));

        // Internal newlines stay; only the trailing ones are trimmed.
        let prev = PrevOutcome {
            stdout_tail: Some("a\nb\n".into()),
            ..Default::default()
        };
        let out = apply_text_node(Some("${raw_input}!"), Some(&prev), &empty, &empty);
        assert_eq!(out.stdout_tail.as_deref(), Some("a\nb!"));
    }

    #[test]
    fn apply_text_node_input_specials_empty_without_predecessor() {
        // No predecessor (or no fields) → the specials expand to empty.
        let empty = BTreeMap::new();
        let out = apply_text_node(
            Some("[${raw_input}][${schema_input}]"),
            None,
            &empty,
            &empty,
        );
        assert_eq!(out.stdout_tail.as_deref(), Some("[][]"));
    }

    #[test]
    fn data_var_wire_format_is_tagged_camelcase() {
        let json = serde_json::to_value(DataSourceRecord::AtRun).unwrap();
        assert_eq!(json["kind"], "atRun");
        let json = serde_json::to_value(DataSourceRecord::DataVar { name: "t".into() }).unwrap();
        assert_eq!(json["kind"], "dataVar");
        assert_eq!(json["name"], "t");
    }
}
