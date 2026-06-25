//! Branch / condition evaluation: building the pure [`EvalContext`] from a
//! finished node's outcome, and choosing the branch a `condition` / `switch` /
//! `loop` node takes. All free functions — no executor, fully unit-testable.

use crate::core::executor::NodeOutcome;
use crate::core::workflow_condition::{self, EvalContext};
use crate::storage::workflows::{LoopConfigRecord, SwitchCaseRecord};

use super::dataflow::extracted_to_values;
use super::graph::Branch;
use super::WorkflowError;

/// Build the pure [`EvalContext`] a condition is evaluated against from a
/// finished node's outcome: its exit code, its extracted output fields (the
/// same projection data-flow uses, so `Variable`-subject conditions see the
/// same names a downstream `${name}` would), and its bounded stdout tail.
/// Keeping this a free function lets it be unit-tested without an executor.
pub(super) fn build_eval_context(outcome: &NodeOutcome) -> EvalContext {
    EvalContext {
        exit_code: outcome.exit_code,
        variables: extracted_to_values(outcome),
        stdout: outcome.stdout_tail.clone(),
    }
}

/// Choose the branch a `condition` node takes. When the node carries an
/// explicit `predicate`, it is evaluated against the test command's outcome:
/// true → `then`, false → `else`. When it is `None`, the node falls back to
/// the MVP exit-code rule (exit 0 → `then`, non-zero → `else`). A malformed
/// predicate (bad regex) surfaces as `ConditionEval`, not a silent `else`.
/// Pure — no executor, fully unit-testable.
pub(super) fn select_condition_branch(
    node_id: &str,
    predicate: Option<&workflow_condition::Condition>,
    ctx: &EvalContext,
) -> Result<Branch, WorkflowError> {
    let took_then = match predicate {
        Some(cond) => workflow_condition::evaluate(cond, ctx)
            .map_err(|e| WorkflowError::ConditionEval(node_id.to_string(), e.to_string()))?,
        None => ctx.exit_code == Some(0),
    };
    Ok(if took_then {
        Branch::Then
    } else {
        Branch::Else
    })
}

/// Choose the branch a `switch` node takes from its cases and the test
/// command's outcome: the FIRST case whose predicate evaluates true (in
/// declaration order) yields `Branch::Case(id)`; if none match, `Branch::
/// Default`. A malformed predicate (bad regex) is surfaced as a
/// `ConditionEval` error rather than silently skipped, so the author learns
/// the case never fires. Pure — no executor, fully unit-testable.
pub(super) fn select_switch_branch(
    node_id: &str,
    cases: &[SwitchCaseRecord],
    ctx: &EvalContext,
) -> Result<Branch, WorkflowError> {
    for case in cases {
        let matched = workflow_condition::evaluate(&case.condition, ctx)
            .map_err(|e| WorkflowError::ConditionEval(node_id.to_string(), e.to_string()))?;
        if matched {
            return Ok(Branch::Case(case.id.clone()));
        }
    }
    Ok(Branch::Default)
}

/// Decide whether a `loop` node continues (→ `Branch::Body`) or stops
/// (→ `Branch::Done`), given its config, the number of iterations ALREADY
/// completed, and the data-flow context the `while` predicate evaluates
/// against. Pure — no executor, fully unit-testable.
///
/// Rules, in order:
///  1. **Hard cap first.** If `completed >= max_iterations`, return `LoopLimit`
///     — the safety bound is checked BEFORE the mode logic so a runaway
///     `while` loop (or a `count` larger than the cap) can never spin past it.
///  2. **Exactly one mode.** Exactly one of `count` / `while` must be set;
///     neither or both is a `LoopMisconfigured` authoring error.
///  3. **count mode:** continue while `completed < count`.
///  4. **while mode:** continue while the predicate holds (a bad regex
///     surfaces as `ConditionEval`, not a silent stop).
pub(super) fn loop_should_continue(
    node_id: &str,
    cfg: &LoopConfigRecord,
    completed: u32,
    ctx: &EvalContext,
) -> Result<Branch, WorkflowError> {
    if completed >= cfg.max_iterations {
        return Err(WorkflowError::LoopLimit(
            node_id.to_string(),
            cfg.max_iterations,
        ));
    }
    match (cfg.count, cfg.while_condition.as_ref()) {
        (Some(count), None) => {
            if completed < count {
                Ok(Branch::Body)
            } else {
                Ok(Branch::Done)
            }
        }
        (None, Some(cond)) => {
            let keep_going = workflow_condition::evaluate(cond, ctx)
                .map_err(|e| WorkflowError::ConditionEval(node_id.to_string(), e.to_string()))?;
            if keep_going {
                Ok(Branch::Body)
            } else {
                Ok(Branch::Done)
            }
        }
        // Neither or both set → an authoring error, not a guess.
        _ => Err(WorkflowError::LoopMisconfigured(node_id.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::executor::TerminalStatus;
    use crate::core::workflow_condition::{Condition, Op, Subject};

    fn case(id: &str, subject: Subject, op: Op, value: &str) -> SwitchCaseRecord {
        SwitchCaseRecord {
            id: id.into(),
            condition: Condition {
                subject,
                op,
                value: value.into(),
            },
        }
    }

    fn ctx_exit(code: Option<i32>) -> EvalContext {
        EvalContext {
            exit_code: code,
            ..Default::default()
        }
    }

    #[test]
    fn switch_takes_first_matching_case_in_order() {
        // Two cases both match exit code 0; the FIRST in declaration order wins.
        let cases = vec![
            case("zero", Subject::ExitCode, Op::Eq, "0"),
            case("also", Subject::ExitCode, Op::Lt, "10"),
        ];
        let branch = select_switch_branch("sw", &cases, &ctx_exit(Some(0))).unwrap();
        assert_eq!(branch, Branch::Case("zero".into()));
    }

    #[test]
    fn switch_falls_through_to_default_when_no_case_matches() {
        let cases = vec![case("zero", Subject::ExitCode, Op::Eq, "0")];
        let branch = select_switch_branch("sw", &cases, &ctx_exit(Some(7))).unwrap();
        assert_eq!(branch, Branch::Default);
    }

    #[test]
    fn switch_with_no_cases_is_default() {
        let branch = select_switch_branch("sw", &[], &ctx_exit(Some(0))).unwrap();
        assert_eq!(branch, Branch::Default);
    }

    #[test]
    fn switch_surfaces_bad_regex_as_condition_eval_error() {
        // An unmatched-paren regex must abort with a typed `ConditionEval`,
        // not be silently treated as "no match".
        let cases = vec![case("re", Subject::Stdout, Op::Regex, "(")];
        let ctx = EvalContext {
            stdout: Some("anything".into()),
            ..Default::default()
        };
        let err = select_switch_branch("sw", &cases, &ctx).unwrap_err();
        match err {
            WorkflowError::ConditionEval(node, _) => assert_eq!(node, "sw"),
            other => panic!("expected ConditionEval, got {other:?}"),
        }
    }

    #[test]
    fn build_eval_context_maps_exit_and_stdout_tail() {
        // A finished node's exit code and stdout tail flow into the context the
        // switch evaluates against. Build a minimal NodeOutcome directly.
        let outcome = NodeOutcome {
            status: TerminalStatus::Finished,
            exit_code: Some(3),
            extracted: None,
            duration_ms: 1,
            output: None,
            stdout_tail: Some("2 passed, 1 failed\n".into()),
        };
        let ctx = build_eval_context(&outcome);
        assert_eq!(ctx.exit_code, Some(3));
        assert_eq!(ctx.stdout.as_deref(), Some("2 passed, 1 failed\n"));
        assert!(ctx.variables.is_empty());
    }

    // ---- §4 loop decisions -------------------------------------------------

    fn loop_count(count: u32, max: u32) -> LoopConfigRecord {
        LoopConfigRecord {
            count: Some(count),
            while_condition: None,
            max_iterations: max,
        }
    }

    fn loop_while(cond: Condition, max: u32) -> LoopConfigRecord {
        LoopConfigRecord {
            count: None,
            while_condition: Some(cond),
            max_iterations: max,
        }
    }

    #[test]
    fn loop_count_enters_body_until_count_reached() {
        let cfg = loop_count(3, 1000);
        let ctx = EvalContext::default();
        // completed 0,1,2 → body; 3 → done.
        assert_eq!(loop_should_continue("lp", &cfg, 0, &ctx), Ok(Branch::Body));
        assert_eq!(loop_should_continue("lp", &cfg, 2, &ctx), Ok(Branch::Body));
        assert_eq!(loop_should_continue("lp", &cfg, 3, &ctx), Ok(Branch::Done));
    }

    #[test]
    fn loop_while_enters_body_while_predicate_holds() {
        // Continue while variable `go` == "1".
        let cond = Condition {
            subject: Subject::Variable { name: "go".into() },
            op: Op::Eq,
            value: "1".into(),
        };
        let cfg = loop_while(cond, 1000);

        let mut yes = EvalContext::default();
        yes.variables.insert("go".into(), "1".into());
        assert_eq!(loop_should_continue("lp", &cfg, 0, &yes), Ok(Branch::Body));

        let mut no = EvalContext::default();
        no.variables.insert("go".into(), "0".into());
        assert_eq!(loop_should_continue("lp", &cfg, 5, &no), Ok(Branch::Done));
    }

    #[test]
    fn loop_limit_fires_before_mode_logic_even_for_while_true() {
        // A `while` that never becomes false must still be stopped by the hard
        // cap — and as a typed `LoopLimit`, not a silent `Done`.
        let cond = Condition {
            subject: Subject::Variable { name: "go".into() },
            op: Op::Eq,
            value: "1".into(),
        };
        let cfg = loop_while(cond, 10);
        let mut ctx = EvalContext::default();
        ctx.variables.insert("go".into(), "1".into());
        assert_eq!(
            loop_should_continue("lp", &cfg, 10, &ctx),
            Err(WorkflowError::LoopLimit("lp".into(), 10))
        );
    }

    #[test]
    fn loop_count_above_max_is_capped_by_loop_limit() {
        // A `count` larger than `max_iterations` cannot spin past the cap.
        let cfg = loop_count(100, 5);
        let ctx = EvalContext::default();
        assert_eq!(loop_should_continue("lp", &cfg, 4, &ctx), Ok(Branch::Body));
        assert_eq!(
            loop_should_continue("lp", &cfg, 5, &ctx),
            Err(WorkflowError::LoopLimit("lp".into(), 5))
        );
    }

    #[test]
    fn loop_misconfigured_when_neither_or_both_modes_set() {
        let ctx = EvalContext::default();
        let neither = LoopConfigRecord {
            count: None,
            while_condition: None,
            max_iterations: 10,
        };
        assert_eq!(
            loop_should_continue("lp", &neither, 0, &ctx),
            Err(WorkflowError::LoopMisconfigured("lp".into()))
        );
        let both = LoopConfigRecord {
            count: Some(3),
            while_condition: Some(Condition {
                subject: Subject::ExitCode,
                op: Op::Eq,
                value: "0".into(),
            }),
            max_iterations: 10,
        };
        assert_eq!(
            loop_should_continue("lp", &both, 0, &ctx),
            Err(WorkflowError::LoopMisconfigured("lp".into()))
        );
    }

    // ---- §6 condition predicate -------------------------------------------

    #[test]
    fn condition_without_predicate_falls_back_to_exit_code() {
        // No predicate → MVP rule: exit 0 → then, non-zero → else.
        assert_eq!(
            select_condition_branch("c", None, &ctx_exit(Some(0))),
            Ok(Branch::Then)
        );
        assert_eq!(
            select_condition_branch("c", None, &ctx_exit(Some(1))),
            Ok(Branch::Else)
        );
    }

    #[test]
    fn condition_with_predicate_evaluates_it_over_exit_code() {
        // A stdout `contains` predicate overrides the exit-code default: even
        // with exit 0, a non-matching stdout takes `else`.
        let pred = Condition {
            subject: Subject::Stdout,
            op: Op::Contains,
            value: "OK".into(),
        };
        let mut hit = EvalContext {
            exit_code: Some(0),
            ..Default::default()
        };
        hit.stdout = Some("all OK here".into());
        assert_eq!(
            select_condition_branch("c", Some(&pred), &hit),
            Ok(Branch::Then)
        );

        let miss = EvalContext {
            exit_code: Some(0),
            stdout: Some("nope".into()),
            ..Default::default()
        };
        assert_eq!(
            select_condition_branch("c", Some(&pred), &miss),
            Ok(Branch::Else)
        );
    }

    #[test]
    fn condition_bad_regex_predicate_is_condition_eval_error() {
        let pred = Condition {
            subject: Subject::Stdout,
            op: Op::Regex,
            value: "(".into(),
        };
        let ctx = EvalContext {
            stdout: Some("x".into()),
            ..Default::default()
        };
        let err = select_condition_branch("cnode", Some(&pred), &ctx).unwrap_err();
        match err {
            WorkflowError::ConditionEval(node, _) => assert_eq!(node, "cnode"),
            other => panic!("expected ConditionEval, got {other:?}"),
        }
    }
}
