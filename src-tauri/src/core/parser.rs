// Command parsing and variable substitution.
//
// This module implements a small, deterministic substitution layer
// applied to every command's `script`, `args`, `working_dir`, and `env`
// VALUES (not keys) before the executor builds a `Command`. It is the
// single source of truth for ProcMix's `${name}` / `${name:default}`
// syntax — the JS side validates names (CommandForm) and collects
// values (VariablePrompt) but never performs the substitution itself.
//
// # Grammar
//
//   reference  := "${" name [":" inline_default] "}"
//   name       := [A-Za-z_][A-Za-z0-9_]*
//   inline_default := any character except "}", including empty
//   escape     := "$$"   → literal "$"
//
// Resolution order for `${name}` (no inline default):
//   1. `values` map (caller-supplied at run time).
//   2. The matching VariableSpec's `default_value`.
//   3. Error: `ParseError::MissingVariable(name)`.
//
// `${name:default}` resolves to `values[name]` if present, otherwise
// the inline default — the VariableSpec's default is NOT consulted
// because the inline form is intentionally self-contained.
//
// # SECURITY note — no automatic shell quoting
//
// Substitution is purely textual. The parser does NOT quote, escape,
// or sanitise values; that is the shell's job and the user's
// responsibility. A template like
//
//   sh -c 'echo ${msg}'
//
// is INSECURE when `msg` carries shell metacharacters (`; rm -rf /`,
// `$(reboot)`, etc.) — the shell receives the raw substituted text
// and will happily execute embedded commands. Templates that mean
// "treat the value as a single string" MUST quote it in the template
// body:
//
//   sh -c 'echo "${msg}"'
//
// Even then, an inner double-quote in the value can still break out.
// For untrusted input, prefer passing the value as a separate `arg`
// or as an `env` variable and referencing it with `"$VAR"` inside the
// script.

use serde::Serialize;
use std::collections::BTreeMap;
use thiserror::Error;

use crate::storage::commands::VariableSpec;

/// Resolved (substituted) form of a command template, ready to feed
/// into `Command::new(...)`. The executor consumes this directly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedScript {
    pub script: String,
    pub args: Vec<String>,
    pub working_dir: Option<String>,
    pub env: BTreeMap<String, String>,
}

/// Errors produced by [`resolve`]. Serialised with `#[serde(tag = "code")]`
/// so the JS bridge can dispatch on a stable enum discriminator instead
/// of pattern-matching on the human-readable message. `rename_all =
/// "camelCase"` turns the variant names into camelCase tags.
#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum ParseError {
    #[error("missing variable: {name}")]
    MissingVariable { name: String },
    #[error("malformed reference at byte {at}")]
    MalformedReference { at: usize },
}

/// Input bundle for [`resolve`]. Holds borrowed slices so the caller
/// doesn't have to clone every command field just to substitute.
pub struct CommandTemplate<'a> {
    pub script: &'a str,
    pub args: &'a [String],
    pub working_dir: Option<&'a str>,
    pub env: &'a BTreeMap<String, String>,
    pub variables: &'a [VariableSpec],
}

/// Resolve every `${...}` reference in the template.
///
/// `values` is the per-run map (UI prompt + caller-supplied). Falls
/// back to each spec's `default_value`, then errors out.
///
/// Env KEYS are never substituted — only values. Substituting in a
/// key would let a runtime value silently rename a variable the shell
/// sees, which is rarely what a user wants and is impossible to spot
/// in the persisted command.
pub fn resolve(
    template: &CommandTemplate<'_>,
    values: &BTreeMap<String, String>,
) -> Result<ResolvedScript, ParseError> {
    let script = substitute(template.script, values, template.variables)?;
    let mut args = Vec::with_capacity(template.args.len());
    for a in template.args {
        args.push(substitute(a, values, template.variables)?);
    }
    let working_dir = match template.working_dir {
        Some(s) => Some(substitute(s, values, template.variables)?),
        None => None,
    };
    let mut env = BTreeMap::new();
    for (k, v) in template.env {
        let resolved = substitute(v, values, template.variables)?;
        // Keys are copied verbatim — see the module comment.
        env.insert(k.clone(), resolved);
    }
    Ok(ResolvedScript {
        script,
        args,
        working_dir,
        env,
    })
}

/// Substitute every `${...}` and `$$` in `input`. Returns the resolved
/// string or the first parse error.
///
/// Iteration uses byte indices, but copies non-special spans by `str`
/// slice — never by `b as char` — so multibyte UTF-8 in the template
/// (e.g. Cyrillic, emoji, accented Latin) passes through unchanged.
/// `$`, `{`, `}`, `:`, and the identifier alphabet are all ASCII, so
/// detecting them via single-byte comparison is unambiguous regardless
/// of surrounding multibyte content.
fn substitute(
    input: &str,
    values: &BTreeMap<String, String>,
    variables: &[VariableSpec],
) -> Result<String, ParseError> {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    // `span_start` marks the first un-flushed byte; we copy the slice
    // [span_start..i) into `out` whenever we encounter a special
    // sequence we need to handle, then resume from after it.
    let mut span_start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if b != b'$' {
            // Advance through this byte. UTF-8 continuation bytes are
            // never equal to `$` (0x24, ASCII), so this branch covers
            // both ASCII text and the interior of multibyte sequences.
            i += 1;
            continue;
        }
        // Reached a `$`. Flush any pending literal span before deciding
        // how to handle the sequence.
        out.push_str(&input[span_start..i]);

        if i + 1 < bytes.len() {
            let n = bytes[i + 1];
            if n == b'$' {
                // `$$` → literal `$`.
                out.push('$');
                i += 2;
                span_start = i;
                continue;
            }
            if n == b'{' {
                // `${ ...`. Find the closing `}`.
                let start = i;
                let name_start = i + 2;
                let name_end = scan_name(bytes, name_start);
                if name_end == name_start {
                    return Err(ParseError::MalformedReference { at: start });
                }
                // Names are pure ASCII by construction (scan_name only
                // accepts `[A-Za-z0-9_]`), so direct slicing yields a
                // valid &str.
                let name = &input[name_start..name_end];
                if name_end >= bytes.len() {
                    return Err(ParseError::MalformedReference { at: start });
                }
                if bytes[name_end] == b'}' {
                    let resolved = lookup(name, values, variables)?;
                    out.push_str(&resolved);
                    i = name_end + 1;
                    span_start = i;
                    continue;
                }
                if bytes[name_end] == b':' {
                    let inline_start = name_end + 1;
                    let mut k = inline_start;
                    while k < bytes.len() && bytes[k] != b'}' {
                        k += 1;
                    }
                    if k >= bytes.len() {
                        return Err(ParseError::MalformedReference { at: start });
                    }
                    // Inline default body is a UTF-8 substring of the
                    // input — safe to slice as `&str` directly.
                    let resolved = match values.get(name) {
                        Some(v) => v.clone(),
                        None => input[inline_start..k].to_string(),
                    };
                    out.push_str(&resolved);
                    i = k + 1;
                    span_start = i;
                    continue;
                }
                return Err(ParseError::MalformedReference { at: start });
            }
        }
        // Lone `$` (end of input, or followed by neither `$` nor `{`).
        // Treat as literal so `echo $PATH` round-trips cleanly.
        out.push('$');
        i += 1;
        span_start = i;
    }
    // Flush the final literal span.
    if span_start < bytes.len() {
        out.push_str(&input[span_start..]);
    }
    Ok(out)
}

/// Return the byte index just past the last valid identifier char,
/// starting at `start`. If `start` already points at a non-identifier
/// byte, returns `start` (the caller treats this as "empty name").
fn scan_name(bytes: &[u8], start: usize) -> usize {
    let mut i = start;
    if i >= bytes.len() {
        return i;
    }
    let first = bytes[i];
    let is_name_start = first.is_ascii_alphabetic() || first == b'_';
    if !is_name_start {
        return i;
    }
    i += 1;
    while i < bytes.len() {
        let c = bytes[i];
        if c.is_ascii_alphanumeric() || c == b'_' {
            i += 1;
        } else {
            break;
        }
    }
    i
}

/// Resolve a bare `${name}` reference. Caller-supplied values win,
/// then the spec's default, then error.
fn lookup(
    name: &str,
    values: &BTreeMap<String, String>,
    variables: &[VariableSpec],
) -> Result<String, ParseError> {
    if let Some(v) = values.get(name) {
        return Ok(v.clone());
    }
    for spec in variables {
        if spec.name == name {
            if let Some(d) = &spec.default_value {
                return Ok(d.clone());
            }
            return Err(ParseError::MissingVariable {
                name: name.to_string(),
            });
        }
    }
    Err(ParseError::MissingVariable {
        name: name.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str, default: Option<&str>, sensitive: bool) -> VariableSpec {
        VariableSpec {
            name: name.to_string(),
            default_value: default.map(|s| s.to_string()),
            prompt_at_runtime: false,
            description: None,
            sensitive,
        }
    }

    fn template<'a>(
        script: &'a str,
        args: &'a [String],
        working_dir: Option<&'a str>,
        env: &'a BTreeMap<String, String>,
        variables: &'a [VariableSpec],
    ) -> CommandTemplate<'a> {
        CommandTemplate {
            script,
            args,
            working_dir,
            env,
            variables,
        }
    }

    fn empty_env() -> BTreeMap<String, String> {
        BTreeMap::new()
    }

    #[test]
    fn simple_substitution_from_values() {
        let mut values = BTreeMap::new();
        values.insert("name".into(), "world".into());
        let env = empty_env();
        let t = template("hello ${name}", &[], None, &env, &[]);
        let r = resolve(&t, &values).unwrap();
        assert_eq!(r.script, "hello world");
    }

    #[test]
    fn multiple_refs_in_one_string() {
        let mut values = BTreeMap::new();
        values.insert("a".into(), "1".into());
        values.insert("b".into(), "2".into());
        let env = empty_env();
        let t = template("${a}-${b}-${a}", &[], None, &env, &[]);
        let r = resolve(&t, &values).unwrap();
        assert_eq!(r.script, "1-2-1");
    }

    #[test]
    fn default_value_from_spec_when_no_value_supplied() {
        let env = empty_env();
        let specs = [spec("name", Some("default-name"), false)];
        let t = template("hi ${name}", &[], None, &env, &specs);
        let r = resolve(&t, &BTreeMap::new()).unwrap();
        assert_eq!(r.script, "hi default-name");
    }

    #[test]
    fn inline_default_used_when_no_value_supplied() {
        let env = empty_env();
        let t = template("greet ${who:friend}", &[], None, &env, &[]);
        let r = resolve(&t, &BTreeMap::new()).unwrap();
        assert_eq!(r.script, "greet friend");
    }

    #[test]
    fn caller_value_wins_over_inline_default() {
        let mut values = BTreeMap::new();
        values.insert("who".into(), "alice".into());
        let env = empty_env();
        let t = template("greet ${who:friend}", &[], None, &env, &[]);
        let r = resolve(&t, &values).unwrap();
        assert_eq!(r.script, "greet alice");
    }

    #[test]
    fn empty_inline_default_resolves_to_empty_string() {
        let env = empty_env();
        let t = template("[${who:}]", &[], None, &env, &[]);
        let r = resolve(&t, &BTreeMap::new()).unwrap();
        assert_eq!(r.script, "[]");
    }

    #[test]
    fn missing_variable_error_includes_name() {
        let env = empty_env();
        let t = template("hi ${who}", &[], None, &env, &[]);
        let err = resolve(&t, &BTreeMap::new()).unwrap_err();
        match err {
            ParseError::MissingVariable { name } => assert_eq!(name, "who"),
            other => panic!("expected MissingVariable, got {other:?}"),
        }
    }

    #[test]
    fn dollar_dollar_escape_produces_literal_dollar() {
        let env = empty_env();
        let t = template("price: $$10", &[], None, &env, &[]);
        let r = resolve(&t, &BTreeMap::new()).unwrap();
        assert_eq!(r.script, "price: $10");
    }

    #[test]
    fn malformed_unclosed_reference_is_an_error() {
        let env = empty_env();
        let t = template("hi ${unclosed", &[], None, &env, &[]);
        let err = resolve(&t, &BTreeMap::new()).unwrap_err();
        assert!(matches!(err, ParseError::MalformedReference { .. }));
    }

    #[test]
    fn malformed_empty_name_is_an_error() {
        // `${}` — the name production matches zero characters → malformed.
        let env = empty_env();
        let t = template("${}", &[], None, &env, &[]);
        let err = resolve(&t, &BTreeMap::new()).unwrap_err();
        assert!(matches!(err, ParseError::MalformedReference { .. }));
    }

    #[test]
    fn malformed_name_starting_with_digit_is_an_error() {
        // Identifier must start with letter or `_`. Catching this at
        // parse-time prevents silent surprises ("why didn't $1 work?").
        let env = empty_env();
        let t = template("${1foo}", &[], None, &env, &[]);
        let err = resolve(&t, &BTreeMap::new()).unwrap_err();
        assert!(matches!(err, ParseError::MalformedReference { .. }));
    }

    #[test]
    fn substitution_applies_to_args() {
        let mut values = BTreeMap::new();
        values.insert("flag".into(), "--verbose".into());
        let env = empty_env();
        let args = vec!["${flag}".to_string(), "file".to_string()];
        let t = template("noop", &args, None, &env, &[]);
        let r = resolve(&t, &values).unwrap();
        assert_eq!(r.args, vec!["--verbose".to_string(), "file".to_string()]);
    }

    #[test]
    fn substitution_applies_to_working_dir() {
        let mut values = BTreeMap::new();
        values.insert("base".into(), "/home/me".into());
        let env = empty_env();
        let t = template("noop", &[], Some("${base}/work"), &env, &[]);
        let r = resolve(&t, &values).unwrap();
        assert_eq!(r.working_dir.as_deref(), Some("/home/me/work"));
    }

    #[test]
    fn substitution_applies_to_env_values_only_not_keys() {
        // `${`-style sequences in env KEYS must round-trip verbatim;
        // substitution only happens on VALUES.
        let mut env = BTreeMap::new();
        env.insert("LITERAL_${key}".into(), "${val}".into());
        let mut values = BTreeMap::new();
        values.insert("val".into(), "resolved".into());
        let t = template("noop", &[], None, &env, &[]);
        let r = resolve(&t, &values).unwrap();
        // Key copied unchanged.
        let value = r.env.get("LITERAL_${key}").expect("key copied verbatim");
        assert_eq!(value, "resolved");
        // And the never-substituted key didn't sneak in.
        assert!(!r.env.contains_key("LITERAL_resolved"));
    }

    /// `${var}` should resolve via the spec's default. If the parser
    /// accidentally consulted `values` only — ignoring specs — this
    /// test would fail because `values` is empty.
    #[test]
    fn spec_default_used_when_values_empty_and_no_inline_default() {
        let env = empty_env();
        let specs = [spec("greeting", Some("hello"), false)];
        let t = template("${greeting}, world", &[], None, &env, &specs);
        let r = resolve(&t, &BTreeMap::new()).unwrap();
        assert_eq!(r.script, "hello, world");
    }

    /// Lone `$` (not followed by `$` or `{`) is treated as a literal
    /// character — mirrors typical user expectation for shell templates
    /// containing things like `echo $PATH` without braces.
    #[test]
    fn lone_dollar_is_treated_as_literal() {
        let env = empty_env();
        let t = template("echo $PATH", &[], None, &env, &[]);
        let r = resolve(&t, &BTreeMap::new()).unwrap();
        assert_eq!(r.script, "echo $PATH");
    }

    /// Multibyte UTF-8 in the surrounding template body must pass
    /// through verbatim. An earlier draft of `substitute` copied input
    /// one byte at a time as `char`, which corrupted any non-ASCII
    /// character; this regression test locks the str-slice approach
    /// down.
    #[test]
    fn substitution_preserves_multibyte_utf8_around_references() {
        let mut values = BTreeMap::new();
        values.insert("who".into(), "мир".into());
        let env = empty_env();
        let t = template("Привет, ${who}! 🚀", &[], None, &env, &[]);
        let r = resolve(&t, &values).unwrap();
        assert_eq!(r.script, "Привет, мир! 🚀");
    }

    // ---------- Wire-format regression tests ----------

    /// `ParseError::MissingVariable` must serialise with a stable
    /// camelCase shape: `{"code": "missingVariable", "name": "x"}`.
    /// The JS bridge dispatches on the `code` discriminator, so any
    /// rename or shape change here is a breaking IPC contract bug.
    #[test]
    fn wire_format_missing_variable_uses_camelcase_tag() {
        let e = ParseError::MissingVariable { name: "x".into() };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["code"], "missingVariable");
        assert_eq!(json["name"], "x");
        // Negative: snake_case / kebab-case variants must NOT leak.
        assert!(json.get("missing_variable").is_none());
        assert!(json.get("missing-variable").is_none());
    }

    /// Likewise for `MalformedReference`. The `at` field stays in
    /// camelCase (single word, so it already is camelCase).
    #[test]
    fn wire_format_malformed_reference_uses_camelcase_tag() {
        let e = ParseError::MalformedReference { at: 7 };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["code"], "malformedReference");
        assert_eq!(json["at"], 7);
        assert!(json.get("malformed_reference").is_none());
    }
}
