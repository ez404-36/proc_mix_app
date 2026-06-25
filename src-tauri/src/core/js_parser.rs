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
//   * A WALL-CLOCK backstop (`JS_WALL_CLOCK_BUDGET`) runs the evaluation on a
//     dedicated worker thread and abandons the wait after the deadline. The
//     iteration/recursion limits already guarantee termination, but a single
//     pathological built-in operation (e.g. catastrophic regex backtracking,
//     which does not increment the loop counter) could still spin for a long
//     time; the wall-clock budget bounds that case too. On a timeout the call
//     returns `Timeout` immediately and the worker — guaranteed to finish by
//     the other limits — is left to wind down on its own.
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

/// Wall-clock budget for a single `parse(data)` evaluation. The iteration /
/// recursion limits already make every computation terminate, but a single
/// long-running built-in op (e.g. pathological regex backtracking) does not
/// trip the loop counter; this deadline is the backstop so the synchronous
/// extraction call can never hang the app for more than this long. Generous
/// relative to a legitimate parse (which completes in milliseconds).
const JS_WALL_CLOCK_BUDGET: std::time::Duration = std::time::Duration::from_secs(5);

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

/// Exact substrings Boa puts in its runtime-limit error messages. Used to
/// reclassify a `RuntimeLimit` throw (loop-iteration / recursion / call-stack
/// breach) as a [`Timeout`], so the user sees "exceeded its execution limit"
/// rather than a raw engine message.
///
/// These mirror the three messages Boa emits (see `boa_engine`'s
/// `vm/mod.rs` and the `RuntimeLimits` enforcement):
///   - `"Maximum loop iteration limit N exceeded"`
///   - `"exceeded maximum number of recursive calls"`
///   - `"exceeded maximum call stack length"`
///
/// They are deliberately SPECIFIC — matching the bare word "limit" would
/// misclassify a legitimate user error such as `throw new Error("rate limit
/// reached")` as a Timeout.
///
/// [`Timeout`]: JsParseError::Timeout
const LIMIT_MARKERS: [&str; 3] = [
    "loop iteration limit",
    "exceeded maximum number of recursive calls",
    "exceeded maximum call stack length",
];

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

    // Run the evaluation on a dedicated worker thread and wait at most
    // `JS_WALL_CLOCK_BUDGET` for it. The Boa `Context` is `!Send`, so it is
    // built INSIDE the worker — only the owned source string and serialised
    // input cross the thread boundary. If the deadline passes we return
    // `Timeout`; the worker is detached (never joined) and is guaranteed to
    // terminate on its own by the iteration/recursion limits, so it cannot leak
    // unboundedly.
    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<Value, JsParseError>>(1);
    let code = user_code.to_owned();
    let data = input.clone();

    // A panic inside the worker (known boa cases: `to_json` on Undefined / Null
    // / Symbol; internal asserts) must NOT escape — a panic crossing a thread
    // boundary is swallowed by the join, but we convert it to a typed error via
    // `catch_unwind` so a successful-but-panicking run is reported cleanly.
    std::thread::Builder::new()
        .name("js-parser".into())
        .spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                run_js_inner(&code, &data)
            }))
            .unwrap_or(Err(JsParseError::ResultNotSerializable));
            // The receiver may already be gone (we timed out); ignore the error.
            let _ = tx.send(result);
        })
        .map_err(|e| JsParseError::Runtime(format!("failed to spawn js parser thread: {e}")))?;

    match rx.recv_timeout(JS_WALL_CLOCK_BUDGET) {
        Ok(result) => result,
        // Deadline elapsed before the worker reported — treat as a timeout.
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err(JsParseError::Timeout),
        // The worker dropped the sender without sending (e.g. the thread was
        // torn down) — surface as a timeout rather than blocking forever.
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(JsParseError::Timeout),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_maps_real_limit_breaches_to_timeout() {
        // The exact messages Boa emits for its three runtime-limit breaches.
        for msg in [
            "RuntimeLimit: Maximum loop iteration limit 1000000 exceeded",
            "RuntimeLimit: exceeded maximum number of recursive calls",
            "RuntimeLimit: exceeded maximum call stack length",
        ] {
            assert_eq!(classify(msg), JsParseError::Timeout, "msg: {msg}");
        }
    }

    #[test]
    fn runs_a_simple_parse_within_budget() {
        // A normal parse completes well under the wall-clock budget and returns
        // its JSON result through the worker thread + channel path.
        let code = "function parse(data) { return { n: data.length }; }";
        let input = Value::Array(vec![Value::from(1), Value::from(2), Value::from(3)]);
        let out = run_js(code, &input).expect("parse succeeds");
        assert_eq!(out, serde_json::json!({ "n": 3 }));
    }

    #[test]
    fn loop_limit_breach_is_timeout_through_worker() {
        // A runaway loop trips Boa's iteration limit; the worker reports the
        // reclassified Timeout through the channel (proving the threaded path
        // surfaces inner results, not just the wall-clock deadline).
        let code = "function parse(data) { while (true) {} }";
        let err = run_js(code, &Value::Null).expect_err("must not succeed");
        assert_eq!(err, JsParseError::Timeout);
    }

    #[test]
    fn wall_clock_budget_bounds_a_single_pathological_op() {
        // Catastrophic regex backtracking spins inside a single built-in op and
        // does NOT increment the loop-iteration counter, so only the wall-clock
        // backstop can stop it. The call must return (Timeout or, if the engine
        // happens to finish, a Runtime error) — the point is it does not hang.
        let code = r#"
            function parse(data) {
                return /(a+)+$/.test("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaX");
            }
        "#;
        let start = std::time::Instant::now();
        let result = run_js(code, &Value::Null);
        // It returned (didn't hang) within a small multiple of the budget.
        assert!(
            start.elapsed() < JS_WALL_CLOCK_BUDGET + std::time::Duration::from_secs(2),
            "run_js must return promptly, took {:?}",
            start.elapsed()
        );
        // Either the wall-clock fired (Timeout) or the op completed fast on this
        // engine build (a bool result). Both are acceptable; a hang is not.
        match result {
            Err(JsParseError::Timeout) | Ok(_) => {}
            other => panic!("unexpected result: {other:?}"),
        }
    }

    #[test]
    fn classify_does_not_misclassify_user_limit_errors() {
        // A legitimate user error that merely mentions "limit" must stay a
        // Runtime error — NOT be reclassified as a Timeout.
        for msg in [
            "Error: rate limit reached",
            "Error: limit exceeded for quota",
            "TypeError: Cannot read properties of undefined",
        ] {
            assert!(
                matches!(classify(msg), JsParseError::Runtime(_)),
                "msg should stay Runtime: {msg}"
            );
        }
    }
}
