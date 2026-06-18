//! Baseline micro-benchmarks for the output-extraction hot path.
//!
//! Covers `core::extractor::extract` for every single-step parser kind
//! (raw / lines / json / regex / keyValue / table, plus the table
//! `max_columns` variant), a representative multi-step pipeline, and the
//! sandboxed `core::js_parser::run_js` engine (which spins up a fresh Boa
//! `Context` per call — the cost we most want to track for regressions).
//!
//! Run with `cargo bench`. These are dev-only and never linked into the app.
//! The goal is a stable BASELINE: compare future runs against the numbers
//! Criterion stores under `target/criterion/` to catch regressions.

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use procmix_lib::core::extractor::extract;
use procmix_lib::core::js_parser::run_js;
use procmix_lib::storage::commands::{
    OutputFieldRecord, OutputPipelineStepRecord, OutputSchemaRecord,
};
use serde_json::json;

/// A field locator with everything optional cleared — set the one locator
/// the parser under test consumes via the closure.
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

/// A single-step schema for `parser`, with no fields and no pipeline.
/// Mutate the returned value to set parser-specific config.
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

/// A pipeline step for `parser` (used to build multi-step schemas).
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

/// Build a `ps`/`ls`-style whitespace table of `rows` lines, the last column
/// being a path that contains a space (so `max_columns` matters).
fn table_sample(rows: usize) -> String {
    let mut s = String::new();
    for i in 0..rows {
        s.push_str(&format!(
            "-rw-r--r-- 1 egor egor {i}M июн 16 23:00 /home/egor/My Files/file{i}.db\n"
        ));
    }
    s
}

/// A `key=value` block of `n` pairs.
fn key_value_sample(n: usize) -> String {
    let mut s = String::new();
    for i in 0..n {
        s.push_str(&format!("key{i}=value{i}\n"));
    }
    s
}

/// A newline-delimited list of `n` lines.
fn lines_sample(n: usize) -> String {
    let mut s = String::new();
    for i in 0..n {
        s.push_str(&format!("line number {i}\n"));
    }
    s
}

fn bench_parsers(c: &mut Criterion) {
    let mut group = c.benchmark_group("extract/parsers");

    // --- raw: identity passthrough (cheapest baseline). ---
    let raw_in = lines_sample(200);
    let raw_schema = schema("raw");
    group.bench_function("raw", |b| {
        b.iter(|| extract(black_box(&raw_schema), black_box(&raw_in)))
    });

    // --- lines: split into an array of strings. ---
    let lines_in = lines_sample(200);
    let lines_schema = schema("lines");
    group.bench_function("lines", |b| {
        b.iter(|| extract(black_box(&lines_schema), black_box(&lines_in)))
    });

    // --- json: parse + project one path. ---
    let json_in = json!({
        "items": (0..100).map(|i| json!({ "id": i, "name": format!("n{i}") })).collect::<Vec<_>>(),
        "count": 100,
    })
    .to_string();
    let mut json_schema = schema("json");
    json_schema.source = Some("stdout".into());
    json_schema.fields = vec![{
        let mut f = field("count");
        f.path = Some("count".into());
        f
    }];
    group.bench_function("json", |b| {
        b.iter(|| extract(black_box(&json_schema), black_box(&json_in)))
    });

    // --- regex: named-group capture over many lines. ---
    let regex_in = (0..200)
        .map(|i| format!("user{i} 10.0.0.{}\n", i % 256))
        .collect::<String>();
    let mut regex_schema = schema("regex");
    regex_schema.pattern = Some(r"(?P<user>\w+)\s+(?P<ip>\d+\.\d+\.\d+\.\d+)".into());
    regex_schema.fields = vec![
        {
            let mut f = field("user");
            f.group = Some("user".into());
            f
        },
        {
            let mut f = field("ip");
            f.group = Some("ip".into());
            f
        },
    ];
    group.bench_function("regex", |b| {
        b.iter(|| extract(black_box(&regex_schema), black_box(&regex_in)))
    });

    // --- keyValue: 100 pairs with the default separator. ---
    let kv_in = key_value_sample(100);
    let mut kv_schema = schema("keyValue");
    kv_schema.delimiter = Some("=".into());
    group.bench_function("keyValue", |b| {
        b.iter(|| extract(black_box(&kv_schema), black_box(&kv_in)))
    });

    // --- table: whitespace split, no column limit. ---
    let table_in = table_sample(100);
    let table_schema = schema("table");
    group.bench_function("table", |b| {
        b.iter(|| extract(black_box(&table_schema), black_box(&table_in)))
    });

    // --- table + max_columns: splitn keeps the spaced path whole. ---
    let mut table_capped = schema("table");
    table_capped.max_columns = Some(9);
    group.bench_function("table_max_columns", |b| {
        b.iter(|| extract(black_box(&table_capped), black_box(&table_in)))
    });

    group.finish();
}

fn bench_pipeline(c: &mut Criterion) {
    // lines → table → (per-row map): a representative multi-step pipeline.
    let input = table_sample(100);
    let mut s = schema("raw");
    s.pipeline = vec![step("lines"), {
        let mut t = step("table");
        t.max_columns = Some(9);
        t
    }];

    c.bench_function("extract/pipeline/lines_then_table", |b| {
        b.iter(|| extract(black_box(&s), black_box(&input)))
    });
}

fn bench_js_parser(c: &mut Criterion) {
    let mut group = c.benchmark_group("js_parser/run_js");

    // Trivial transform on a string — measures fixed per-call Context cost.
    let code_trim = "function parse(data) { return data.trim().toUpperCase(); }";
    let str_input = json!("  hello world  ");
    group.bench_function("string_transform", |b| {
        b.iter(|| run_js(black_box(code_trim), black_box(&str_input)))
    });

    // Array reduce over inputs of growing size — shows how cost scales with
    // the data crossing the JSON boundary (from_json → parse → to_json).
    let code_sum = "function parse(data) { return data.reduce((a, b) => a + b, 0); }";
    for n in [10usize, 100, 1000] {
        let arr = json!((0..n).collect::<Vec<_>>());
        group.bench_with_input(BenchmarkId::new("array_reduce", n), &arr, |b, arr| {
            b.iter(|| run_js(black_box(code_sum), black_box(arr)))
        });
    }

    // Object → object mapping (typical table-row reshape in a JS step).
    let code_map =
        "function parse(data) { return data.map(r => ({ id: r.id, up: r.name.toUpperCase() })); }";
    let obj_input = json!((0..100)
        .map(|i| json!({ "id": i, "name": format!("n{i}") }))
        .collect::<Vec<_>>());
    group.bench_function("object_map_100", |b| {
        b.iter(|| run_js(black_box(code_map), black_box(&obj_input)))
    });

    group.finish();
}

criterion_group!(benches, bench_parsers, bench_pipeline, bench_js_parser);
criterion_main!(benches);
