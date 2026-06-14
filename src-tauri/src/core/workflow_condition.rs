// Pure condition evaluation for advanced workflow nodes (v0.7.0).
//
// A `Condition` is a single predicate the workflow runner evaluates against a
// node's outcome to choose a branch (`condition` then/else, `switch` cases,
// `loop` while-guard). This module is DELIBERATELY pure: it never touches the
// executor, the Tauri app handle, the database, or the filesystem. It takes a
// plain `EvalContext` (exit code + variables + an optional stdout tail) and
// returns a bool. That keeps it fully unit-testable in isolation — exactly like
// the graph helpers (`find_start`, `edge_for_branch`) in `core::workflow`.
//
// The runner (`core::workflow`) builds the `EvalContext` from a `NodeOutcome`:
//   - `exit_code`  ← `NodeOutcome::exit_code`
//   - `variables`  ← `NodeOutcome::extracted.fields` rendered as strings
//                    (same projection the data-flow carry already uses)
//   - `stdout`     ← `NodeOutcome::stdout_tail` (bounded; see executor types)
//
// SECURITY: the runner is responsible for never logging a `sensitive` value
// that lands in `variables`/`stdout`. This module only returns a bool; it never
// echoes the compared value back in its (typed) error, so an evaluation failure
// cannot leak a secret. The only free-form string a `ConditionError` carries is
// the user-authored regex pattern and the variable NAME — never a runtime value.

use std::collections::BTreeMap;

use regex::Regex;
use serde::{Deserialize, Serialize};

/// What a condition compares against. Mirrors the TS `ConditionSubject` union
/// (camelCase on the wire).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Subject {
    /// The node command's process exit code (`None` when the run was killed by
    /// a signal / cancel — see `NodeOutcome::exit_code`).
    #[serde(rename = "exitCode")]
    ExitCode,
    /// A named variable from the node's extracted output fields (data-flow).
    #[serde(rename = "variable")]
    Variable { name: String },
    /// The node command's (bounded, redacted) stdout tail.
    #[serde(rename = "stdout")]
    Stdout,
}

/// The comparison operator. Mirrors the TS `ConditionOp` union.
///
/// `Eq`/`Ne` compare the subject's STRING rendering to `value` (for
/// `ExitCode`, that is the decimal exit code, or the literal `none` when the
/// process produced no code). `Gt`/`Lt` compare numerically and are only
/// meaningful when both sides parse as integers — a non-numeric subject makes
/// the comparison `false` rather than an error, so a malformed value never
/// aborts a run. `Contains`/`Regex` operate on the subject's string form.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Op {
    Eq,
    Ne,
    Contains,
    Regex,
    Gt,
    Lt,
}

/// A single predicate evaluated against an [`EvalContext`]. Mirrors the TS
/// `WorkflowCondition` interface (camelCase on the wire).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    pub subject: Subject,
    pub op: Op,
    /// The right-hand operand the subject is compared against. For `Regex`
    /// this is the pattern source.
    #[serde(default)]
    pub value: String,
}

/// Inputs a [`Condition`] is evaluated against. Built by the runner from a
/// finished node's [`NodeOutcome`]; carries no executor/IPC types so the
/// evaluator stays pure.
///
/// [`NodeOutcome`]: crate::core::executor::NodeOutcome
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EvalContext {
    /// Exit code of the node's command, or `None` for a signal/cancel.
    pub exit_code: Option<i32>,
    /// Data-flow variables (extracted output fields rendered as strings).
    pub variables: BTreeMap<String, String>,
    /// Bounded, already-redacted stdout tail, or `None` when the node produced
    /// no stdout (or was not a command node).
    pub stdout: Option<String>,
}

/// Typed evaluation failure. The only failure mode is an invalid user-authored
/// regex pattern; everything else evaluates to a definite bool. Carries the
/// pattern source (user input, not a runtime value) so the UI can show which
/// regex was malformed — never a compared value, so it cannot leak a secret.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConditionError {
    #[error("invalid regex pattern `{0}`: {1}")]
    BadRegex(String, String),
}

impl EvalContext {
    /// Render the subject as the string the string-operators compare against.
    /// `ExitCode` → decimal (or `none`); `Variable` → the value (empty string
    /// when absent — a missing data-flow field is treated as empty, never an
    /// error); `Stdout` → the tail (empty when absent).
    fn subject_string(&self, subject: &Subject) -> String {
        match subject {
            Subject::ExitCode => match self.exit_code {
                Some(code) => code.to_string(),
                None => "none".to_string(),
            },
            Subject::Variable { name } => self.variables.get(name).cloned().unwrap_or_default(),
            Subject::Stdout => self.stdout.clone().unwrap_or_default(),
        }
    }
}

/// Evaluate a condition against a context. Pure and side-effect-free.
///
/// The only error is a malformed regex (`Op::Regex`); every other operator
/// returns a definite bool. A numeric operator (`Gt`/`Lt`) against a
/// non-numeric subject or value yields `false` (a sloppy graph never aborts a
/// run on a type mismatch — it simply doesn't take that branch).
pub fn evaluate(cond: &Condition, ctx: &EvalContext) -> Result<bool, ConditionError> {
    let lhs = ctx.subject_string(&cond.subject);
    match cond.op {
        Op::Eq => Ok(lhs == cond.value),
        Op::Ne => Ok(lhs != cond.value),
        Op::Contains => Ok(lhs.contains(&cond.value)),
        Op::Regex => {
            let re = Regex::new(&cond.value)
                .map_err(|e| ConditionError::BadRegex(cond.value.clone(), e.to_string()))?;
            Ok(re.is_match(&lhs))
        }
        Op::Gt => Ok(numeric_cmp(&lhs, &cond.value, |a, b| a > b)),
        Op::Lt => Ok(numeric_cmp(&lhs, &cond.value, |a, b| a < b)),
    }
}

/// Compare two operands numerically, returning `false` when EITHER side fails
/// to parse as an `i64`. Keeps a non-numeric comparison total (no error) so a
/// misconfigured graph degrades to "branch not taken" rather than aborting.
fn numeric_cmp(lhs: &str, rhs: &str, cmp: impl Fn(i64, i64) -> bool) -> bool {
    match (lhs.trim().parse::<i64>(), rhs.trim().parse::<i64>()) {
        (Ok(a), Ok(b)) => cmp(a, b),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx_exit(code: Option<i32>) -> EvalContext {
        EvalContext {
            exit_code: code,
            ..Default::default()
        }
    }

    fn cond(subject: Subject, op: Op, value: &str) -> Condition {
        Condition {
            subject,
            op,
            value: value.to_string(),
        }
    }

    #[test]
    fn exit_code_eq_and_ne() {
        let c = ctx_exit(Some(0));
        assert_eq!(
            evaluate(&cond(Subject::ExitCode, Op::Eq, "0"), &c),
            Ok(true)
        );
        assert_eq!(
            evaluate(&cond(Subject::ExitCode, Op::Ne, "0"), &c),
            Ok(false)
        );
        let c = ctx_exit(Some(2));
        assert_eq!(
            evaluate(&cond(Subject::ExitCode, Op::Eq, "0"), &c),
            Ok(false)
        );
    }

    #[test]
    fn exit_code_none_renders_as_none_string() {
        // A signal/cancel produces no code; it stringifies to `none` so an
        // `== none` predicate can target it explicitly and `== 0` is false.
        let c = ctx_exit(None);
        assert_eq!(
            evaluate(&cond(Subject::ExitCode, Op::Eq, "none"), &c),
            Ok(true)
        );
        assert_eq!(
            evaluate(&cond(Subject::ExitCode, Op::Eq, "0"), &c),
            Ok(false)
        );
    }

    #[test]
    fn variable_contains_and_missing_is_empty() {
        let mut vars = BTreeMap::new();
        vars.insert("branch".to_string(), "feature/login".to_string());
        let c = EvalContext {
            variables: vars,
            ..Default::default()
        };
        assert_eq!(
            evaluate(
                &cond(
                    Subject::Variable {
                        name: "branch".into()
                    },
                    Op::Contains,
                    "feature/"
                ),
                &c
            ),
            Ok(true)
        );
        // A missing variable is treated as the empty string, not an error.
        assert_eq!(
            evaluate(
                &cond(
                    Subject::Variable {
                        name: "absent".into()
                    },
                    Op::Eq,
                    ""
                ),
                &c
            ),
            Ok(true)
        );
    }

    #[test]
    fn stdout_regex_match_and_absent() {
        let c = EvalContext {
            stdout: Some("3 tests passed, 0 failed\n".to_string()),
            ..Default::default()
        };
        assert_eq!(
            evaluate(&cond(Subject::Stdout, Op::Regex, r"\d+ failed"), &c),
            Ok(true)
        );
        // Absent stdout → empty string → no match (not an error).
        let empty = EvalContext::default();
        assert_eq!(
            evaluate(&cond(Subject::Stdout, Op::Regex, r"\d+ failed"), &empty),
            Ok(false)
        );
    }

    #[test]
    fn bad_regex_is_typed_error_carrying_pattern_not_value() {
        let c = EvalContext {
            stdout: Some("secret-token-abc".to_string()),
            ..Default::default()
        };
        let err = evaluate(&cond(Subject::Stdout, Op::Regex, "("), &c).unwrap_err();
        match &err {
            ConditionError::BadRegex(pattern, _) => {
                assert_eq!(pattern, "(");
                // The compared stdout value must never appear in the error.
                assert!(!format!("{err}").contains("secret-token-abc"));
            }
        }
    }

    #[test]
    fn numeric_gt_lt_and_non_numeric_is_false() {
        let c = ctx_exit(Some(137));
        assert_eq!(
            evaluate(&cond(Subject::ExitCode, Op::Gt, "128"), &c),
            Ok(true)
        );
        assert_eq!(
            evaluate(&cond(Subject::ExitCode, Op::Lt, "128"), &c),
            Ok(false)
        );
        // Non-numeric subject vs numeric value → false, not an error.
        let mut vars = BTreeMap::new();
        vars.insert("v".to_string(), "abc".to_string());
        let c = EvalContext {
            variables: vars,
            ..Default::default()
        };
        assert_eq!(
            evaluate(
                &cond(Subject::Variable { name: "v".into() }, Op::Gt, "1"),
                &c
            ),
            Ok(false)
        );
    }

    #[test]
    fn wire_format_is_camelcase_and_tagged() {
        let cond = Condition {
            subject: Subject::Variable {
                name: "count".into(),
            },
            op: Op::Gt,
            value: "5".into(),
        };
        let json = serde_json::to_value(&cond).unwrap();
        assert_eq!(json["subject"]["kind"], "variable");
        assert_eq!(json["subject"]["name"], "count");
        assert_eq!(json["op"], "gt");
        assert_eq!(json["value"], "5");

        // Round-trips back to the same struct.
        let back: Condition = serde_json::from_value(json).unwrap();
        assert_eq!(back, cond);
    }

    #[test]
    fn wire_format_exit_code_and_stdout_subjects() {
        let exit = serde_json::to_value(Subject::ExitCode).unwrap();
        assert_eq!(exit["kind"], "exitCode");
        let stdout = serde_json::to_value(Subject::Stdout).unwrap();
        assert_eq!(stdout["kind"], "stdout");
    }

    #[test]
    fn value_defaults_to_empty_when_absent_on_wire() {
        // A condition serialised without `value` (e.g. an `== ""` check)
        // deserialises with an empty string, not a parse error.
        let json = serde_json::json!({
            "subject": { "kind": "stdout" },
            "op": "contains",
        });
        let cond: Condition = serde_json::from_value(json).unwrap();
        assert_eq!(cond.value, "");
    }
}
