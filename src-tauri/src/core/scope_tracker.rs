// Process-tree scope tracking for Process Capture (the "command recorder").
//
// The raw process-birth stream (Windows ETW / Linux cn_proc) is a firehose:
// on a desktop with Docker + an IDE, a few idle seconds produce dozens of
// `exec`s that are nobody's deliberate action (container healthchecks, IDE
// background git, pipeline stages). An image-name blacklist cannot separate
// these from the SAME tools the user does want (`git`, `node`, `sed`), so the
// fix is to scope capture to a PROCESS TREE — only the chosen application and
// its descendants — instead of filtering by name. See
// `docs/plans/process-capture-scoping.md`.
//
// This module is PURE and platform-agnostic: it operates on `(pid, ppid)`
// pairs, holds no OS handle, and is driven entirely by unit tests. The
// platform watcher feeds it `on_spawn` / `on_exit` events and a one-shot
// `seed` snapshot; the membership decision is rule #0 of `CaptureFilter`
// (before self / system-noise / browser-helper / dedup).

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

/// What slice of the process-birth stream the recorder should surface.
///
/// Crosses the IPC boundary as an internally-tagged union (`{ "mode": "...",
/// "roots": [...] }`) so the TS `CaptureScope` type lines up. The wire
/// `CaptureEvent` is unchanged — `pid` / `ppid` already cross the boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
pub enum CaptureScope {
    /// Surface everything that passes the noise filters. Default; preserves
    /// the pre-scoping behaviour.
    All,
    /// Only the given root PIDs and their descendants (by the PPID tree).
    Subtree { roots: HashSet<u32> },
    /// Everything EXCEPT the given roots and their descendants — used to
    /// subtract ProcMix's own / launcher subtree (a privacy obligation).
    ExcludeSubtree { roots: HashSet<u32> },
}

/// Tracks process-tree membership for a [`CaptureScope`] across the lifetime
/// of one capture session. `in_scope` holds the PIDs currently inside the
/// tracked subtree (for `Subtree`) or inside the excluded subtree (for
/// `ExcludeSubtree`); it is grown on spawn and pruned on exit so a reused PID
/// cannot leak membership.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
pub struct ScopeTracker {
    scope: CaptureScope,
    /// PIDs known to be inside the relevant subtree. Always contains the
    /// roots themselves (seeded in [`ScopeTracker::new`]).
    in_scope: HashSet<u32>,
}

#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
impl ScopeTracker {
    /// Build a tracker for `scope`. For the subtree variants the root PIDs
    /// seed `in_scope` so a root's own birth event (and its children) are
    /// recognised immediately.
    pub fn new(scope: CaptureScope) -> Self {
        let in_scope = match &scope {
            CaptureScope::All => HashSet::new(),
            CaptureScope::Subtree { roots } | CaptureScope::ExcludeSubtree { roots } => {
                roots.clone()
            }
        };
        Self { scope, in_scope }
    }

    /// Record a process birth and decide whether — by SCOPE ALONE — it should
    /// be surfaced. (The other noise rules are applied separately by
    /// `CaptureFilter`.) Always updates tree membership, even when returning
    /// `false`, so descendants are classified correctly.
    ///
    /// A process is "inside" the tracked subtree if it IS a root or its
    /// parent is already inside.
    pub fn on_spawn(&mut self, pid: u32, ppid: u32) -> bool {
        match &self.scope {
            CaptureScope::All => true,
            CaptureScope::Subtree { roots } => {
                let inside = roots.contains(&pid) || self.in_scope.contains(&ppid);
                if inside {
                    self.in_scope.insert(pid);
                }
                inside
            }
            CaptureScope::ExcludeSubtree { roots } => {
                let inside = roots.contains(&pid) || self.in_scope.contains(&ppid);
                if inside {
                    self.in_scope.insert(pid);
                    // Inside the EXCLUDED subtree → suppress.
                    false
                } else {
                    true
                }
            }
        }
    }

    /// Record a process exit, pruning it from `in_scope`. This bounds the
    /// PID-reuse window: a freed PID that the OS later reassigns will not be
    /// treated as still inside the subtree. Removing a parent does NOT orphan
    /// its already-tracked children — they remain in `in_scope` under their
    /// own PID, which is correct (they are still descendants of a root).
    pub fn on_exit(&mut self, pid: u32) {
        self.in_scope.remove(&pid);
    }

    /// Seed the tracker with a snapshot of the current process tree so
    /// descendants of a root that started BEFORE recording began are
    /// recognised. `pairs` is `(pid, ppid)` for every live process; the BFS
    /// is a pure function (see [`descendants_of`]) so the platform layer only
    /// has to supply the list (Toolhelp on Windows, `/proc` walk on Linux).
    ///
    /// No-op for [`CaptureScope::All`] (nothing to seed).
    pub fn seed(&mut self, pairs: &[(u32, u32)]) {
        let roots = match &self.scope {
            CaptureScope::All => return,
            CaptureScope::Subtree { roots } | CaptureScope::ExcludeSubtree { roots } => roots,
        };
        let found = descendants_of(roots, pairs);
        self.in_scope.extend(found);
    }

    /// Whether [`ScopeTracker::seed`] would do anything — `false` for
    /// [`CaptureScope::All`]. Lets the platform skip an expensive process-tree
    /// snapshot when no seeding is needed.
    pub fn needs_seeding(&self) -> bool {
        !matches!(self.scope, CaptureScope::All)
    }
}

/// Pure BFS: given root PIDs and a `(pid, ppid)` snapshot of every live
/// process, return the roots plus all their transitive descendants.
///
/// Builds a `parent -> children` adjacency map once, then walks it from each
/// root. A cycle in the (malformed) input cannot loop forever: a `visited`
/// set bounds the walk. Extracted as a free function so it is testable
/// without any tracker state or OS calls.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
pub fn descendants_of(roots: &HashSet<u32>, pairs: &[(u32, u32)]) -> HashSet<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for &(pid, ppid) in pairs {
        children.entry(ppid).or_default().push(pid);
    }

    let mut visited: HashSet<u32> = HashSet::new();
    let mut queue: Vec<u32> = roots.iter().copied().collect();
    while let Some(pid) = queue.pop() {
        if !visited.insert(pid) {
            continue; // already walked (also breaks any cycle)
        }
        if let Some(kids) = children.get(&pid) {
            queue.extend(kids.iter().copied());
        }
    }
    visited
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots(ids: &[u32]) -> HashSet<u32> {
        ids.iter().copied().collect()
    }

    #[test]
    fn all_scope_emits_everything() {
        let mut t = ScopeTracker::new(CaptureScope::All);
        assert!(t.on_spawn(100, 1));
        assert!(t.on_spawn(200, 100));
        assert!(t.on_spawn(999, 4));
    }

    #[test]
    fn subtree_emits_root_and_descendants_only() {
        let mut t = ScopeTracker::new(CaptureScope::Subtree {
            roots: roots(&[100]),
        });
        // The root itself.
        assert!(t.on_spawn(100, 1));
        // A direct child.
        assert!(t.on_spawn(200, 100));
        // A grandchild (parent 200 is in scope).
        assert!(t.on_spawn(300, 200));
        // An unrelated process in a sibling branch is excluded.
        assert!(!t.on_spawn(400, 7));
        // A child of the unrelated process is also excluded.
        assert!(!t.on_spawn(500, 400));
    }

    #[test]
    fn subtree_recognises_a_root_by_its_own_pid_even_if_parent_unknown() {
        // The root's own spawn event may arrive with a ppid we never saw.
        let mut t = ScopeTracker::new(CaptureScope::Subtree {
            roots: roots(&[100]),
        });
        assert!(t.on_spawn(100, 99999));
        assert!(t.on_spawn(101, 100));
    }

    #[test]
    fn exclude_subtree_suppresses_root_and_descendants_keeps_rest() {
        let mut t = ScopeTracker::new(CaptureScope::ExcludeSubtree {
            roots: roots(&[100]),
        });
        // The excluded root and its descendants are suppressed.
        assert!(!t.on_spawn(100, 1));
        assert!(!t.on_spawn(200, 100));
        assert!(!t.on_spawn(300, 200));
        // Everything outside the excluded subtree flows through.
        assert!(t.on_spawn(400, 7));
        assert!(t.on_spawn(500, 400));
    }

    #[test]
    fn exit_prunes_membership_to_bound_pid_reuse() {
        let mut t = ScopeTracker::new(CaptureScope::Subtree {
            roots: roots(&[100]),
        });
        assert!(t.on_spawn(200, 100)); // 200 is now in scope
        t.on_exit(200); // 200 dies; PID may be reused
                        // A NEW process that reuses pid 200 as its PARENT but is unrelated
                        // must NOT be captured, because 200 was pruned.
        assert!(!t.on_spawn(201, 200));
    }

    #[test]
    fn exit_of_parent_does_not_orphan_tracked_children() {
        let mut t = ScopeTracker::new(CaptureScope::Subtree {
            roots: roots(&[100]),
        });
        assert!(t.on_spawn(200, 100)); // child in scope
        assert!(t.on_spawn(300, 200)); // grandchild in scope
        t.on_exit(200); // parent dies
                        // The grandchild (300) is still tracked under its own pid, so ITS
                        // children remain in scope.
        assert!(t.on_spawn(400, 300));
    }

    #[test]
    fn seed_pulls_in_preexisting_descendants() {
        // Tree: 100 -> 200 -> 300, plus unrelated 400 -> 500.
        let snapshot = [(200u32, 100u32), (300, 200), (100, 1), (400, 7), (500, 400)];
        let mut t = ScopeTracker::new(CaptureScope::Subtree {
            roots: roots(&[100]),
        });
        t.seed(&snapshot);
        // Already-running descendants are now recognised without a fresh
        // spawn event...
        assert!(t.on_spawn(301, 300));
        // ...while the unrelated branch stays out.
        assert!(!t.on_spawn(501, 500));
    }

    #[test]
    fn seed_is_noop_for_all_scope() {
        let mut t = ScopeTracker::new(CaptureScope::All);
        t.seed(&[(2, 1), (3, 2)]);
        assert!(t.on_spawn(9, 9)); // still emits everything
    }

    #[test]
    fn descendants_of_collects_transitive_children() {
        let pairs = [(2u32, 1u32), (3, 2), (4, 3), (5, 1), (6, 99)];
        let got = descendants_of(&roots(&[1]), &pairs);
        // 1 -> 2 -> 3 -> 4 and 1 -> 5; 6 is under an unrelated parent.
        assert_eq!(got, roots(&[1, 2, 3, 4, 5]));
    }

    #[test]
    fn descendants_of_handles_cycle_without_hanging() {
        // Malformed input with a cycle 2 -> 3 -> 2.
        let pairs = [(3u32, 2u32), (2, 3), (4, 2)];
        let got = descendants_of(&roots(&[2]), &pairs);
        assert_eq!(got, roots(&[2, 3, 4]));
    }

    #[test]
    fn descendants_of_empty_roots_is_empty() {
        let pairs = [(2u32, 1u32), (3, 2)];
        assert!(descendants_of(&HashSet::new(), &pairs).is_empty());
    }

    // ---- IPC wire format (Stage 2) ----

    #[test]
    fn scope_deserialises_from_tagged_json() {
        let all: CaptureScope = serde_json::from_str(r#"{"mode":"all"}"#).unwrap();
        assert_eq!(all, CaptureScope::All);

        let subtree: CaptureScope =
            serde_json::from_str(r#"{"mode":"subtree","roots":[42,43]}"#).unwrap();
        assert_eq!(
            subtree,
            CaptureScope::Subtree {
                roots: roots(&[42, 43])
            }
        );

        let exclude: CaptureScope =
            serde_json::from_str(r#"{"mode":"excludeSubtree","roots":[7]}"#).unwrap();
        assert_eq!(exclude, CaptureScope::ExcludeSubtree { roots: roots(&[7]) });
    }

    #[test]
    fn needs_seeding_is_false_only_for_all() {
        assert!(!ScopeTracker::new(CaptureScope::All).needs_seeding());
        assert!(ScopeTracker::new(CaptureScope::Subtree { roots: roots(&[1]) }).needs_seeding());
        assert!(
            ScopeTracker::new(CaptureScope::ExcludeSubtree { roots: roots(&[1]) }).needs_seeding()
        );
    }

    #[test]
    fn scope_serialises_with_camelcase_mode_tag() {
        let json =
            serde_json::to_value(CaptureScope::ExcludeSubtree { roots: roots(&[7]) }).unwrap();
        assert_eq!(json["mode"], "excludeSubtree");
        assert_eq!(json["roots"], serde_json::json!([7]));
    }
}
