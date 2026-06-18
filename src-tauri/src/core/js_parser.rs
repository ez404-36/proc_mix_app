// Sandboxed JavaScript runner for the `javascript` output parser.
//
// A command's output schema may contain a `javascript` pipeline step whose
// `code` is a user-written `function parse(data) { … }`. This module runs that
// function in an embedded Boa engine and returns its result as JSON. It is
// invoked from `core::extractor` — the single source of truth for output
// parsing — so it works for headless / scheduled runs with no window.
//
// # Security model
//
// The user's JS code can touch NOTHING but its `data` argument and the
// ECMAScript standard library. This is guaranteed *by construction*:
//
//   * A fresh `Context::default()` exposes only the built-in objects
//     (`Object`, `Array`, `String`, `Number`, `Math`, `JSON`, `Date`,
//     `RegExp`, `Map`, `Set`, …). It has NO `fetch`, `console`, `require`,
//     `process`, `fs`, `URL`, `setTimeout`, `XMLHttpRequest`, `WebSocket`, …
//   * Host capabilities live in the SEPARATE `boa_runtime` crate, which is
//     deliberately NOT a dependency. We register zero `NativeFunction`s and
//     zero global properties, so there is no exit point into the system.
//   * The only data crossing into the sandbox is the previous pipeline step's
//     value, bound as the `data` argument. No command env, secret, path, or
//     sample reaches the context.
//   * The context is one-shot: a new `Context` per call, no shared state.
//
// # Resource bounds
//
//   * Source size is capped (`JS_MAX_CODE_BYTES`) before compilation so a
//     pathologically large script is rejected outright.
//   * Boa's loop-iteration limit (`JS_LOOP_ITERATION_LIMIT`) and recursion
//     limit (`JS_RECURSION_LIMIT`) bound runaway loops/recursion — a
//     `while (true) {}` throws a runtime-limit error rather than hanging.
//     Together they make every unbounded computation terminate, so the
//     synchronous call on the extraction hot path can never block forever.
//
// # Failure model
//
// Every failure (oversize source, compile error, runtime error, exceeding a
// limit, non-serialisable result) is a typed [`JsParseError`]. Error messages
// carry ONLY structural detail — never a slice of `data` or the script output
// — mirroring the "never log stdout" rule used elsewhere in extraction.

use boa_engine::{js_string, Context, JsValue, Source};
use serde_json::Value;
use thiserror::Error;

/// Hard cap on the JS source length we will compile. A larger script is
/// almost certainly a mistake; rejecting it guards the parser/compiler
/// against pathological input (mirrors `extractor::MAX_PATTERN_BYTES`).
const JS_MAX_CODE_BYTES: usize = 64 * 1024;

/// Max loop iterations any single `parse(data)` call may run before Boa
/// throws a runtime-limit error. Bounds `while (true)` / huge `for` loops so
/// the synchronous call always terminates well under a second. A `parse`
/// that transforms one command's output never legitimately loops more than
/// this — it is a guard against a runaway, not a work budget.
const JS_LOOP_ITERATION_LIMIT: u64 = 1_000_000;

/// Max function-call recursion depth before Boa throws. Bounds unbounded
/// recursion (the other way to spin forever without a loop).
const JS_RECURSION_LIMIT: usize = 400;

/// Typed failure of a `javascript` parser step. Carries only structural
/// detail (never `data` or output contents) so an error can't leak a
/// sensitive value the previous step produced.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum JsParseError {
    #[error("javascript parser source is too large ({0} bytes)")]
    CodeTooLarge(usize),
    #[error("javascript parser compile error: {0}")]
    Compile(String),
    #[error("javascript parser runtime error: {0}")]
    Runtime(String),
    #[error("javascript parser exceeded its execution limit")]
    Timeout,
    #[error("javascript parser must define `function parse(data)`")]
    MissingParseFunction,
    #[error("javascript parser result is not serialisable to JSON")]
    ResultNotSerializable,
}

/// Substring Boa puts in a runtime-limit error message. Used to reclassify a
/// generic runtime error (loop / recursion limit exceeded) as a [`Timeout`],
/// so the user sees "exceeded its execution limit" rather than a raw message.
///
/// [`Timeout`]: JsParseError::Timeout
const LIMIT_MARKERS: [&str; 3] = ["limit", "Limit", "maximum call stack"];

/// Run a user `function parse(data) { … }` against `input` in a fresh,
/// fully-sandboxed Boa context and return its result as JSON.
///
/// `user_code` must define a global `parse` function; it is then called with
/// `data` bound to `input`. The return value is converted back to JSON
/// (`undefined` / no return → `null`). All failures are typed and never echo
/// `input` or the script output.
pub fn run_js(user_code: &str, input: &Value) -> Result<Value, JsParseError> {
    if user_code.len() > JS_MAX_CODE_BYTES {
        return Err(JsParseError::CodeTooLarge(user_code.len()));
    }

    // The entire execution is wrapped in `catch_unwind` so that a boa panic
    // (known cases: `to_json` on Undefined / Null / Symbol; internal asserts)
    // becomes a typed error instead of aborting the process. A panic in a
    // Tauri command handler is process-fatal, so we must intercept it.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        run_js_inner(user_code, input)
    }));
    match result {
        Ok(inner) => inner,
        Err(_) => Err(JsParseError::ResultNotSerializable),
    }
}

/// Inner implementation of [`run_js`], called inside `catch_unwind`.
fn run_js_inner(user_code: &str, input: &Value) -> Result<Value, JsParseError> {
    // Fresh, isolated context: ECMAScript builtins only, no host bindings.
    let mut context = Context::default();
    {
        let limits = context.runtime_limits_mut();
        limits.set_loop_iteration_limit(JS_LOOP_ITERATION_LIMIT);
        limits.set_recursion_limit(JS_RECURSION_LIMIT);
    }

    // Compile + run the user source, which defines `parse`. A parse/compile
    // failure (syntax error) surfaces here as `Compile`; a runtime throw at
    // top level is reclassified by `classify` (limit breach → Timeout).
    if let Err(e) = context.eval(Source::from_bytes(user_code)) {
        let message = e.to_string();
        return Err(match classify(&message) {
            JsParseError::Timeout => JsParseError::Timeout,
            _ => JsParseError::Compile(message),
        });
    }

    // Resolve the global `parse` function the source was expected to define.
    let parse = resolve_parse(&mut context)?;

    // Bind `data` and invoke `parse(data)`.
    let data = JsValue::from_json(input, &mut context)
        .map_err(|e| JsParseError::Runtime(e.to_string()))?;

    let callable = parse
        .as_callable()
        .ok_or(JsParseError::MissingParseFunction)?
        .clone();

    let returned = callable
        .call(&JsValue::undefined(), &[data], &mut context)
        .map_err(|e| classify(&e.to_string()))?;

    // `undefined` and `null` map to JSON null. Boa's `to_json` panics on
    // `Undefined` and may also panic on `Null`, so handle both explicitly.
    if returned.is_undefined() || returned.is_null() {
        return Ok(Value::Null);
    }

    returned
        .to_json(&mut context)
        .map_err(|_| JsParseError::ResultNotSerializable)
}

/// Resolve the global `parse` function value, erroring if it is absent /
/// not callable.
fn resolve_parse(context: &mut Context) -> Result<JsValue, JsParseError> {
    let global = context.global_object();
    let parse = global
        .get(js_string!("parse"), context)
        .map_err(|e| JsParseError::Runtime(e.to_string()))?;
    if parse.as_callable().is_none() {
        return Err(JsParseError::MissingParseFunction);
    }
    Ok(parse)
}

/// Reclassify a runtime error string: a loop / recursion / stack-limit
/// breach becomes [`JsParseError::Timeout`]; anything else stays a generic
/// runtime error. The message comes from `JsError::to_string` — the engine's
/// structural text (e.g. "TypeError: ...") — and never includes `data`, which
/// only ever exists inside the `parse` call.
fn classify(message: &str) -> JsParseError {
    if LIMIT_MARKERS.iter().any(|m| message.contains(m)) {
        JsParseError::Timeout
    } else {
        JsParseError::Runtime(message.to_string())
    }
}
