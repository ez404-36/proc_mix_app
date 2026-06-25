//! Graph parsing and validation: the typed [`NodeKind`] / [`Branch`]
//! discriminators, locating the single start node, and selecting the outgoing
//! edge(s) for a branch (single-exit and the `parallel` multi-exit fork).

use std::collections::HashMap;

use crate::storage::workflows::{WorkflowEdgeRecord, WorkflowNodeRecord};

use super::WorkflowError;

/// Branch discriminator on an edge. Mirrors the TS `WorkflowEdgeBranch`
/// union and the `branch` string stored on `WorkflowEdgeRecord`.
///
/// `Case` carries the user-authored case id and renders as `case:<id>`, so
/// `Branch` is NOT `Copy` (it owns a `String`); it is passed by reference to
/// [`edge_for_branch`] and cloned only when an event needs to own the label.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Branch {
    Out,
    Then,
    Else,
    /// A `switch` case selected by its predicate. Edge label: `case:<id>`.
    Case(String),
    /// A `switch`'s fallback when no case matched. Edge label: `default`.
    Default,
    /// A `loop`'s iteration entry — enters the body sub-graph. Edge: `body`.
    Body,
    /// A `loop`'s completion exit, taken when iteration stops. Edge: `done`.
    Done,
    /// A `try`'s success exit (command finished exit 0). Edge: `ok`.
    Ok,
    /// A `try`'s failure exit, taken once retries are exhausted. Edge: `catch`.
    Catch,
    /// A `parallel` fork exit, one per branch in declaration order. Edge
    /// label: `branch:<n>` (`branch:0`, `branch:1`, …), modeled on `Case`.
    /// Constructed by [`edges_for_branch_multi`] when the fork traversal
    /// resolves a `parallel` node's outgoing edges.
    BranchN(u32),
}

impl Branch {
    /// The exact string this branch is stored as on `WorkflowEdgeRecord.branch`
    /// (and emitted on `BranchTaken.branch`). Mirrors the TS
    /// `WorkflowEdgeBranch` rendering: `case:<id>` for a switch case, the bare
    /// lowercase name otherwise.
    pub(super) fn to_branch_string(&self) -> String {
        match self {
            Branch::Out => "out".to_string(),
            Branch::Then => "then".to_string(),
            Branch::Else => "else".to_string(),
            Branch::Case(id) => format!("case:{id}"),
            Branch::Default => "default".to_string(),
            Branch::Body => "body".to_string(),
            Branch::Done => "done".to_string(),
            Branch::Ok => "ok".to_string(),
            Branch::Catch => "catch".to_string(),
            Branch::BranchN(n) => format!("branch:{n}"),
        }
    }
}

/// Node kind, parsed from the `kind` string on `WorkflowNodeRecord`. The
/// storage layer keeps `kind` a plain string; the runner owns the typed
/// interpretation (see `storage::workflows` module docs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum NodeKind {
    Start,
    Command,
    Condition,
    Switch,
    Loop,
    Try,
    Data,
    Parser,
    Text,
    Parallel,
    Join,
    End,
}

impl NodeKind {
    pub(super) fn parse(s: &str) -> Option<Self> {
        match s {
            "start" => Some(NodeKind::Start),
            "command" => Some(NodeKind::Command),
            "condition" => Some(NodeKind::Condition),
            "switch" => Some(NodeKind::Switch),
            "loop" => Some(NodeKind::Loop),
            "try" => Some(NodeKind::Try),
            "data" => Some(NodeKind::Data),
            "parser" => Some(NodeKind::Parser),
            "text" => Some(NodeKind::Text),
            "parallel" => Some(NodeKind::Parallel),
            "join" => Some(NodeKind::Join),
            "end" => Some(NodeKind::End),
            _ => None,
        }
    }
}

/// Locate the single start node, returning its index in `nodes`.
pub(super) fn find_start(nodes: &[WorkflowNodeRecord]) -> Result<usize, WorkflowError> {
    let mut found: Option<usize> = None;
    for (i, n) in nodes.iter().enumerate() {
        let kind = NodeKind::parse(&n.kind)
            .ok_or_else(|| WorkflowError::UnknownNodeKind(n.id.clone(), n.kind.clone()))?;
        if kind == NodeKind::Start {
            if found.is_some() {
                return Err(WorkflowError::MultipleStarts);
            }
            found = Some(i);
        }
    }
    found.ok_or(WorkflowError::NoStart)
}

/// Find the edge leaving `node_id` on the given branch, validating that
/// its target exists and that the branch is unambiguous. Returns
/// `(edge_id, target_node_id)`.
///
/// A node must have AT MOST ONE outgoing edge per branch: the traversal is
/// strictly sequential, so two `out` edges (or two `then` edges) from the
/// same node have no defined meaning. The MVP silently took the first match
/// by storage order, making a hand-edited / buggy graph route
/// nondeterministically. We now reject a second match on the same
/// `(source, branch)` with `AmbiguousBranch` so the fault is surfaced
/// instead of hidden.
pub(super) fn edge_for_branch(
    edges: &[WorkflowEdgeRecord],
    node_index: &HashMap<String, usize>,
    node_id: &str,
    branch: &Branch,
) -> Result<Option<(String, String)>, WorkflowError> {
    let branch_str = branch.to_branch_string();
    let mut found: Option<(String, String)> = None;
    for e in edges {
        if e.source == node_id && e.branch == branch_str {
            if !node_index.contains_key(&e.target) {
                return Err(WorkflowError::DanglingEdge(e.id.clone(), e.target.clone()));
            }
            if found.is_some() {
                return Err(WorkflowError::AmbiguousBranch(
                    node_id.to_string(),
                    branch_str,
                ));
            }
            found = Some((e.id.clone(), e.target.clone()));
        }
    }
    Ok(found)
}

/// Collect every `branch:<n>` exit of a `parallel` (fork) node, ordered by the
/// branch index `n`. Returns `(branch_index, edge_id, target_node_id)` tuples.
///
/// This is the fork-only counterpart to [`edge_for_branch`]: a `parallel` node
/// legitimately has MANY outgoing edges (one per branch), so the
/// `AmbiguousBranch` "one edge per branch" rule that protects every other node
/// kind does not apply here. Each branch index must still be unique (two
/// `branch:0` edges from the same fork are ambiguous), and every target must
/// exist. The result is sorted by index so branch declaration order is
/// deterministic regardless of storage order — fork branches run, capture, and
/// (for `join_node_id == None`) terminate in a reproducible sequence.
pub(super) fn edges_for_branch_multi(
    edges: &[WorkflowEdgeRecord],
    node_index: &HashMap<String, usize>,
    node_id: &str,
) -> Result<Vec<(u32, String, String)>, WorkflowError> {
    let mut found: Vec<(u32, String, String)> = Vec::new();
    let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
    for e in edges {
        if e.source != node_id {
            continue;
        }
        // Only `branch:<n>` exits participate in the fork; any other label on a
        // parallel node is ignored here (the editor never wires one).
        let Some(rest) = e.branch.strip_prefix("branch:") else {
            continue;
        };
        let Ok(n) = rest.parse::<u32>() else {
            continue;
        };
        if !node_index.contains_key(&e.target) {
            return Err(WorkflowError::DanglingEdge(e.id.clone(), e.target.clone()));
        }
        if !seen.insert(n) {
            // A duplicate branch index is the same fault `edge_for_branch`
            // rejects for single-exit branches: two edges with no defined order.
            // Render the label via `Branch::BranchN` so the wire string has a
            // single source of truth (mirrors `case:<id>` / `then` / …).
            return Err(WorkflowError::AmbiguousBranch(
                node_id.to_string(),
                Branch::BranchN(n).to_branch_string(),
            ));
        }
        found.push((n, e.id.clone(), e.target.clone()));
    }
    found.sort_by_key(|(n, _, _)| *n);
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::workflows::{NodePosition, WorkflowNodeRecord};

    fn node(id: &str, kind: &str, command_id: Option<&str>) -> WorkflowNodeRecord {
        WorkflowNodeRecord {
            id: id.into(),
            kind: kind.into(),
            command_id: command_id.map(Into::into),
            label: None,
            condition: None,
            cases: Vec::new(),
            loop_config: None,
            retry: None,
            data: Vec::new(),
            variable_sources: std::collections::BTreeMap::new(),
            parser: None,
            text: None,
            join_node_id: None,
            position: NodePosition { x: 0.0, y: 0.0 },
        }
    }

    fn edge(id: &str, source: &str, target: &str, branch: &str) -> WorkflowEdgeRecord {
        WorkflowEdgeRecord {
            id: id.into(),
            source: source.into(),
            target: target.into(),
            branch: branch.into(),
        }
    }

    #[test]
    fn find_start_requires_exactly_one() {
        let none: Vec<WorkflowNodeRecord> = vec![node("a", "command", Some("c"))];
        assert_eq!(find_start(&none), Err(WorkflowError::NoStart));

        let two = vec![node("s1", "start", None), node("s2", "start", None)];
        assert_eq!(find_start(&two), Err(WorkflowError::MultipleStarts));

        let one = vec![node("s", "start", None), node("c", "command", Some("x"))];
        assert_eq!(find_start(&one), Ok(0));
    }

    #[test]
    fn find_start_rejects_unknown_kind() {
        let bad = vec![node("s", "frobnicate", None)];
        assert_eq!(
            find_start(&bad),
            Err(WorkflowError::UnknownNodeKind(
                "s".into(),
                "frobnicate".into()
            ))
        );
    }

    #[test]
    fn edge_for_branch_detects_dangling_target() {
        let edges = vec![edge("e1", "a", "ghost", "out")];
        let index: HashMap<String, usize> = [("a".to_string(), 0)].into_iter().collect();
        let res = edge_for_branch(&edges, &index, "a", &Branch::Out);
        assert_eq!(
            res,
            Err(WorkflowError::DanglingEdge("e1".into(), "ghost".into()))
        );
    }

    #[test]
    fn edge_for_branch_returns_none_when_absent() {
        let edges = vec![edge("e1", "a", "b", "then")];
        let index: HashMap<String, usize> = [("a".to_string(), 0), ("b".to_string(), 1)]
            .into_iter()
            .collect();
        let res = edge_for_branch(&edges, &index, "a", &Branch::Else).unwrap();
        assert!(res.is_none());
    }

    #[test]
    fn edge_for_branch_matches_source_and_branch() {
        let edges = vec![
            edge("e_then", "cond", "ok", "then"),
            edge("e_else", "cond", "fail", "else"),
        ];
        let index: HashMap<String, usize> = [
            ("cond".to_string(), 0),
            ("ok".to_string(), 1),
            ("fail".to_string(), 2),
        ]
        .into_iter()
        .collect();
        let (eid, target) = edge_for_branch(&edges, &index, "cond", &Branch::Else)
            .unwrap()
            .unwrap();
        assert_eq!(eid, "e_else");
        assert_eq!(target, "fail");
    }

    #[test]
    fn edge_for_branch_rejects_two_edges_on_same_branch() {
        // Two `out` edges from the same node is ambiguous: a strictly
        // sequential traversal has no defined way to pick one. The MVP took
        // the first by storage order (nondeterministic). It must now error.
        let edges = vec![edge("e1", "a", "b", "out"), edge("e2", "a", "c", "out")];
        let index: HashMap<String, usize> = [
            ("a".to_string(), 0),
            ("b".to_string(), 1),
            ("c".to_string(), 2),
        ]
        .into_iter()
        .collect();
        let res = edge_for_branch(&edges, &index, "a", &Branch::Out);
        assert_eq!(
            res,
            Err(WorkflowError::AmbiguousBranch("a".into(), "out".into()))
        );
    }

    // ---- parallel fork: edges_for_branch_multi --------------------------

    #[test]
    fn edges_for_branch_multi_returns_branches_sorted_by_index() {
        // Edges stored OUT of index order must come back sorted branch:0,1,2 so
        // declaration order (and thus capture / termination order) is stable.
        let edges = vec![
            edge("e2", "fork", "t2", "branch:2"),
            edge("e0", "fork", "t0", "branch:0"),
            edge("e1", "fork", "t1", "branch:1"),
        ];
        let index: HashMap<String, usize> = [
            ("fork".to_string(), 0),
            ("t0".to_string(), 1),
            ("t1".to_string(), 2),
            ("t2".to_string(), 3),
        ]
        .into_iter()
        .collect();
        let got = edges_for_branch_multi(&edges, &index, "fork").unwrap();
        assert_eq!(
            got,
            vec![
                (0, "e0".to_string(), "t0".to_string()),
                (1, "e1".to_string(), "t1".to_string()),
                (2, "e2".to_string(), "t2".to_string()),
            ]
        );
    }

    #[test]
    fn edges_for_branch_multi_ignores_non_branch_labels() {
        // A stray non-`branch:<n>` label on a parallel node is not a fork exit.
        let edges = vec![
            edge("e0", "fork", "t0", "branch:0"),
            edge("eout", "fork", "other", "out"),
        ];
        let index: HashMap<String, usize> = [
            ("fork".to_string(), 0),
            ("t0".to_string(), 1),
            ("other".to_string(), 2),
        ]
        .into_iter()
        .collect();
        let got = edges_for_branch_multi(&edges, &index, "fork").unwrap();
        assert_eq!(got, vec![(0, "e0".to_string(), "t0".to_string())]);
    }

    #[test]
    fn edges_for_branch_multi_empty_when_no_branches() {
        let edges = vec![edge("eout", "fork", "t", "out")];
        let index: HashMap<String, usize> = [("fork".to_string(), 0), ("t".to_string(), 1)]
            .into_iter()
            .collect();
        let got = edges_for_branch_multi(&edges, &index, "fork").unwrap();
        assert!(got.is_empty());
    }

    #[test]
    fn edges_for_branch_multi_rejects_duplicate_index() {
        // Two `branch:0` edges from the same fork is ambiguous, like two `out`
        // edges from a sequential node.
        let edges = vec![
            edge("e0", "fork", "t0", "branch:0"),
            edge("e0b", "fork", "t1", "branch:0"),
        ];
        let index: HashMap<String, usize> = [
            ("fork".to_string(), 0),
            ("t0".to_string(), 1),
            ("t1".to_string(), 2),
        ]
        .into_iter()
        .collect();
        let res = edges_for_branch_multi(&edges, &index, "fork");
        assert_eq!(
            res,
            Err(WorkflowError::AmbiguousBranch(
                "fork".into(),
                "branch:0".into()
            ))
        );
    }

    #[test]
    fn edges_for_branch_multi_rejects_dangling_target() {
        let edges = vec![edge("e0", "fork", "ghost", "branch:0")];
        let index: HashMap<String, usize> = [("fork".to_string(), 0)].into_iter().collect();
        let res = edges_for_branch_multi(&edges, &index, "fork");
        assert_eq!(
            res,
            Err(WorkflowError::DanglingEdge("e0".into(), "ghost".into()))
        );
    }

    #[test]
    fn edge_for_branch_dangling_target_beats_ambiguity_check() {
        // A dangling target on the FIRST matching edge is reported as a
        // dangling edge, not masked by a later ambiguity — the dangling
        // check runs per-edge before the duplicate check.
        let edges = vec![edge("e1", "a", "ghost", "out")];
        let index: HashMap<String, usize> = [("a".to_string(), 0)].into_iter().collect();
        let res = edge_for_branch(&edges, &index, "a", &Branch::Out);
        assert_eq!(
            res,
            Err(WorkflowError::DanglingEdge("e1".into(), "ghost".into()))
        );
    }

    #[test]
    fn branch_renders_case_with_id_and_named_branches() {
        assert_eq!(Branch::Out.to_branch_string(), "out");
        assert_eq!(Branch::Then.to_branch_string(), "then");
        assert_eq!(Branch::Else.to_branch_string(), "else");
        assert_eq!(Branch::Default.to_branch_string(), "default");
        assert_eq!(Branch::Case("ok".into()).to_branch_string(), "case:ok");
    }

    #[test]
    fn branch_renders_parallel_fork_exits() {
        assert_eq!(Branch::BranchN(0).to_branch_string(), "branch:0");
        assert_eq!(Branch::BranchN(1).to_branch_string(), "branch:1");
        assert_eq!(Branch::BranchN(42).to_branch_string(), "branch:42");
    }

    #[test]
    fn node_kind_parses_parallel_and_join() {
        assert_eq!(NodeKind::parse("parallel"), Some(NodeKind::Parallel));
        assert_eq!(NodeKind::parse("join"), Some(NodeKind::Join));
    }

    #[test]
    fn loop_branch_strings_render() {
        assert_eq!(Branch::Body.to_branch_string(), "body");
        assert_eq!(Branch::Done.to_branch_string(), "done");
    }

    #[test]
    fn parser_node_kind_parses() {
        assert_eq!(NodeKind::parse("parser"), Some(NodeKind::Parser));
    }

    #[test]
    fn text_node_kind_parses() {
        assert_eq!(NodeKind::parse("text"), Some(NodeKind::Text));
    }
}
