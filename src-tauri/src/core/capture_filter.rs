// Noise filtering for Process Capture (the background "command recorder").
//
// The raw process-birth stream (Windows ETW / Linux cn_proc) is extremely
// noisy: the OS constantly spawns service hosts, container plumbing, IDE
// background tasks, and ProcMix itself spawns children. Surfacing all of
// that would bury the handful of starts the user actually cares about (the
// CLI a GUI app launched when they clicked a button).
//
// This module is PURE and platform-agnostic: it operates on `(pid, ppid)`
// plus the image-path / command-line strings, holds no OS handles, and is
// driven entirely by unit tests. The platform callback owns a
// [`CaptureFilter`] and calls [`CaptureFilter::should_emit`] for each record
// before emitting a `CaptureEvent`, and [`CaptureFilter::on_exit`] when a
// process dies (to prune tree state).
//
// Rejection rules, in order of precedence:
//   0. Scope — the chosen capture scope (all / a chosen app's subtree /
//      everything-except-a-subtree), tracked by `ScopeTracker`. Cheapest
//      "firehose" cut, applied first.
//   1. Self-exclusion — never surface ProcMix's own process or the shells
//      it spawns to run commands, or capture would echo its own activity.
//   2. System-noise blacklist — drop high-frequency OS plumbing by image
//      basename (case-insensitive).
//   3. Browser/Electron helper children (Chromium `--type=` + IPC handle).
//   4. Shell-wrapper collapse — suppress the inner command of a `sh -c
//      <cmd>` we already surfaced, and the per-stage `exec`s of a pipeline,
//      by PPID (Linux splits `sh -c "A | B"` into the shell PLUS an exec for
//      every stage). A tree rule, never an image blacklist.
//   5. Deduplication — suppress an (image, command-line) pair already seen
//      recently, bounded so the set cannot grow without limit.

use std::collections::{HashSet, VecDeque};

use super::scope_tracker::{CaptureScope, ScopeTracker};

/// Image basenames (lowercased) that are pure OS/runtime plumbing. These
/// are spawned constantly and never represent a user action worth turning
/// into a command, so they are dropped before reaching the UI.
///
/// Intentionally conservative: only well-known, high-frequency system
/// hosts. Anything not on this list still flows through — a missed-noise
/// row is a minor annoyance, whereas over-filtering could hide a real
/// command the user wanted to capture.
///
/// Platform-split because the noisy hosts differ entirely by OS: Windows ETW
/// reports `*.exe` service hosts, while the Linux cn_proc backend sees
/// session/desktop plumbing. The set is empty on any other OS (no capture
/// backend there).
#[cfg(windows)]
const SYSTEM_NOISE: &[&str] = &[
    "svchost.exe",
    "conhost.exe",
    "dllhost.exe",
    "runtimebroker.exe",
    "backgroundtaskhost.exe",
    "searchprotocolhost.exe",
    "searchfilterhost.exe",
    "wmiprvse.exe",
    "taskhostw.exe",
    "sihost.exe",
    "ctfmon.exe",
    "smartscreen.exe",
    "audiodg.exe",
    "fontdrvhost.exe",
    "csrss.exe",
    "wininit.exe",
    "services.exe",
    "lsass.exe",
];

/// Linux desktop/session plumbing that the proc connector reports on nearly
/// every interaction. Deliberately conservative: only high-frequency,
/// unambiguous system hosts. We do NOT blacklist `sh`/`bash`/`python` here —
/// those are exactly the commands a user might want to capture, so global
/// shell filtering would hide real work. Aggressive Linux noise tuning is a
/// follow-up; this is the safe minimum.
#[cfg(target_os = "linux")]
const SYSTEM_NOISE: &[&str] = &[
    "(sd-pam)",
    "gvfsd",
    "gvfsd-fuse",
    "dconf-service",
    "xdg-desktop-portal",
    "xdg-document-portal",
    "xdg-permission-store",
    "at-spi-bus-launcher",
    "at-spi2-registryd",
];

/// No capture backend on other platforms (macOS / etc.), so there is no
/// stream to filter. Empty keeps `should_emit` correct if it is ever
/// exercised by a test on those targets.
#[cfg(not(any(windows, target_os = "linux")))]
const SYSTEM_NOISE: &[&str] = &[];

/// Maximum number of recent (image, command-line) pairs remembered for
/// deduplication. Bounds memory: when the set is full, the oldest entry is
/// evicted (FIFO). Sized so a burst of distinct starts from one user action
/// is never falsely deduped, while a long-running session can't leak.
const DEDUP_CAPACITY: usize = 512;

/// True for a Chromium/Electron *child* process (renderer, GPU, utility,
/// crashpad handler, …).
///
/// Keyed on the `--type=<role>` child-role switch **combined with** a
/// Chromium IPC handle (`--field-trial-handle` or
/// `--mojo-platform-channel-handle`). Requiring both keeps the rule precise:
/// the app's main/parent process has neither switch and still flows through,
/// and an unrelated CLI tool that merely happens to take a `--type` argument
/// is not mistaken for browser plumbing.
fn is_browser_helper(command_line: &str) -> bool {
    command_line.contains("--type=")
        && (command_line.contains("--field-trial-handle")
            || command_line.contains("--mojo-platform-channel-handle"))
}

/// Lowercased basename of a path, using both `/` and `\\` as separators so
/// the same logic works for Windows image paths and any test fixtures.
fn basename_lower(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_ascii_lowercase()
}

/// Known POSIX shell basenames. On Linux `/bin/sh` is usually `dash`/`bash`,
/// and the recorder sees the resolved image, so all of these must count as a
/// shell for the wrapper-collapse rule (§3.5 of the scoping plan).
const SHELL_BASENAMES: &[&str] = &["sh", "dash", "bash", "ash", "zsh", "ksh"];

/// True if `image` is a POSIX shell binary.
fn is_shell(image: &str) -> bool {
    SHELL_BASENAMES.contains(&basename_lower(image).as_str())
}

/// True if `(image, command_line)` is a shell invoked with `-c <cmd>` (incl.
/// combined flags like `-lc`/`-xc`, and an optional `--`). Such a process is
/// a "wrapper": the user's real command is `<cmd>`, and the shell will then
/// `exec` the wrapped tool and/or every pipeline stage as DIRECT children.
/// Once we surface the wrapper row, those direct children are plumbing.
///
/// We deliberately do NOT inspect or match `<cmd>` against the children:
/// every direct child exec of the wrapper shell (the re-exec'd tool, each
/// `sed`/`tr` pipeline stage) is suppressed purely by PPID. Grandchildren
/// (children of the wrapped TOOL, not of the shell) keep a different PPID and
/// are unaffected, so a wrapped long-running app's own launches still surface.
///
/// Pure and tested on fixtures.
fn is_shell_c_wrapper(image: &str, command_line: &str) -> bool {
    if !is_shell(image) {
        return false;
    }
    let mut tokens = command_line.split_whitespace();
    let _argv0 = tokens.next(); // the shell itself
                                // A `-c`-bearing flag must follow (combined flags like `-lc`/`-xc` count).
    matches!(tokens.next(), Some(flag) if flag.starts_with('-') && flag.contains('c'))
}

/// Stateful capture filter. One instance lives for the duration of a
/// capture session (owned by the ETW callback). `should_emit` is the only
/// method called on the hot path.
///
/// `allow(dead_code)` on platforms with no capture backend (macOS/other):
/// the filter is wired into the Windows ETW and Linux cn_proc callbacks, but
/// the logic is platform-agnostic and fully exercised by the unit tests
/// below on every platform.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
pub struct CaptureFilter {
    /// Lowercased basename of ProcMix's own executable, so its self-spawned
    /// children and its own process are excluded.
    self_image: String,
    /// Rule #0 — capture scope by process tree (all / subtree / exclude).
    scope: ScopeTracker,
    /// Rule #0b — MANDATORY exclusion of ProcMix's own / launcher subtree,
    /// applied on TOP of `scope` (including `All`). `None` when no self-root
    /// was supplied (e.g. unit tests, or `current_exe`/ppid lookup failed).
    /// A privacy obligation: recording the launcher/agent's commands leaks.
    /// See the scoping plan §3.4.
    self_exclude: Option<ScopeTracker>,
    /// PIDs of `sh -c <cmd>` wrapper processes we have surfaced. A process
    /// whose PPID is in this set is a pipeline stage / re-exec'd tool and is
    /// suppressed (Rule #4). Pruned on the wrapper's exit via `on_exit`.
    wrapper_shells: HashSet<u32>,
    /// Recently-seen (image, command-line) keys for dedup, with insertion
    /// order tracked in `dedup_order` for FIFO eviction.
    dedup_seen: HashSet<String>,
    dedup_order: VecDeque<String>,
}

#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
impl CaptureFilter {
    /// Build a filter that excludes the given ProcMix executable path and
    /// captures EVERYTHING (scope = [`CaptureScope::All`]). Typically
    /// `std::env::current_exe()` on the platform side; tests pass a literal.
    /// No process-tree self-exclusion (use
    /// [`CaptureFilter::with_scope_and_self_subtree`] on the platform side to
    /// add it).
    pub fn new(self_exe_path: &str) -> Self {
        Self::with_scope(self_exe_path, CaptureScope::All)
    }

    /// Build a filter with an explicit capture scope (rule #0), no
    /// process-tree self-exclusion.
    pub fn with_scope(self_exe_path: &str, scope: CaptureScope) -> Self {
        Self::with_scope_and_self_subtree(self_exe_path, scope, HashSet::new())
    }

    /// Build a filter with an explicit capture scope PLUS a mandatory
    /// exclusion of ProcMix's own subtree, rooted at `self_subtree_roots`
    /// (typically ProcMix's PID and/or its immediate parent — the launcher).
    /// The exclusion is layered on top of `scope`, so even
    /// [`CaptureScope::All`] never records the launcher/agent's commands.
    /// An empty `self_subtree_roots` disables it (no self-exclusion tree).
    pub fn with_scope_and_self_subtree(
        self_exe_path: &str,
        scope: CaptureScope,
        self_subtree_roots: HashSet<u32>,
    ) -> Self {
        let self_exclude = if self_subtree_roots.is_empty() {
            None
        } else {
            Some(ScopeTracker::new(CaptureScope::ExcludeSubtree {
                roots: self_subtree_roots,
            }))
        };
        Self {
            self_image: basename_lower(self_exe_path),
            scope: ScopeTracker::new(scope),
            self_exclude,
            wrapper_shells: HashSet::new(),
            dedup_seen: HashSet::new(),
            dedup_order: VecDeque::new(),
        }
    }

    /// Seed the scope tracker(s) with a `(pid, ppid)` snapshot so descendants
    /// of a scoped root — and of ProcMix's own subtree — that were already
    /// running before recording started are recognised. See the scoping plan
    /// §3.3.
    pub fn seed_scope(&mut self, pairs: &[(u32, u32)]) {
        self.scope.seed(pairs);
        if let Some(self_exclude) = &mut self.self_exclude {
            self_exclude.seed(pairs);
        }
    }

    /// Whether [`CaptureFilter::seed_scope`] would do anything — `true` if the
    /// capture scope OR the self-exclusion tree needs seeding. Lets the
    /// platform avoid an expensive process-tree snapshot only when neither
    /// does (plain `All` with no self-exclusion).
    pub fn needs_seeding(&self) -> bool {
        self.scope.needs_seeding()
            || self
                .self_exclude
                .as_ref()
                .is_some_and(ScopeTracker::needs_seeding)
    }

    /// Decide whether a captured process start should be surfaced.
    ///
    /// Applies rules 0–5 in order (see the module header). Side effects on
    /// acceptance/scoping: updates the scope tree, records the dedup key, and
    /// remembers a `sh -c` wrapper's PID so its child stages are suppressed.
    pub fn should_emit(&mut self, pid: u32, ppid: u32, image: &str, command_line: &str) -> bool {
        // Rule 0: scope. Always called (it updates tree membership even when
        // the process is out of scope, so descendants classify correctly).
        let in_scope = self.scope.on_spawn(pid, ppid);

        // Rule 0b: mandatory self-exclusion of ProcMix's own subtree, layered
        // on top of `scope`. Always fed the spawn so its tree grows correctly;
        // `on_spawn` returns `false` for a process INSIDE the excluded subtree.
        let outside_self = self
            .self_exclude
            .as_mut()
            .map(|ex| ex.on_spawn(pid, ppid))
            .unwrap_or(true);

        // Rule 4 (evaluated early, needs PPID): shell-wrapper collapse. A
        // direct child of a surfaced `sh -c` wrapper is a pipeline stage or
        // the re-exec'd tool — plumbing. Decided before we (maybe) register
        // THIS process as a new wrapper below, so a wrapper is never treated
        // as a child of itself.
        let is_wrapper_child = self.wrapper_shells.contains(&ppid);

        // Register a new wrapper shell regardless of scope, so its children
        // are recognised even if the wrapper itself was out of scope.
        if is_shell_c_wrapper(image, command_line) {
            self.wrapper_shells.insert(pid);
        }

        if !in_scope || !outside_self || is_wrapper_child {
            return false;
        }

        let base = basename_lower(image);

        // Rule 1: self-exclusion.
        if base == self.self_image {
            return false;
        }

        // Rule 2: system-noise blacklist.
        if SYSTEM_NOISE.contains(&base.as_str()) {
            return false;
        }

        // Rule 3: browser/Electron helper processes. Chromium-based apps
        // (Electron, WebView2, Chrome/Edge/Yandex, draw.io, …) spawn a swarm
        // of child processes — renderers, GPU, utility, network — for every
        // window. These are never something the user "ran", and they bury the
        // real launches. This also drops ProcMix's OWN WebView2 children,
        // which carry a different image name (`msedgewebview2.exe`) than
        // `self_image` and so slip past Rule 1.
        if is_browser_helper(command_line) {
            return false;
        }

        // Rule 5: dedup. Key on the raw image + command line so two genuinely
        // different invocations of the same binary are both kept.
        let key = format!("{image}\u{0}{command_line}");
        if self.dedup_seen.contains(&key) {
            return false;
        }
        self.remember(key);
        true
    }

    /// Record a process exit: prune it from BOTH scope trees and from the
    /// wrapper-shell set so a reused PID cannot leak membership. The platform
    /// watcher calls this on each ProcessEnd / `PROC_EVENT_EXIT`.
    pub fn on_exit(&mut self, pid: u32) {
        self.scope.on_exit(pid);
        if let Some(self_exclude) = &mut self.self_exclude {
            self_exclude.on_exit(pid);
        }
        self.wrapper_shells.remove(&pid);
    }

    /// Insert a dedup key, evicting the oldest when at capacity.
    fn remember(&mut self, key: String) {
        if self.dedup_seen.len() >= DEDUP_CAPACITY {
            if let Some(oldest) = self.dedup_order.pop_front() {
                self.dedup_seen.remove(&oldest);
            }
        }
        self.dedup_order.push_back(key.clone());
        self.dedup_seen.insert(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn filter() -> CaptureFilter {
        CaptureFilter::new("C:/Program Files/ProcMix/procmix.exe")
    }

    // Most noise-rule tests don't care about pid/ppid (scope = All). This
    // helper drives `should_emit` with a FRESH unique pid each call and a
    // fixed unrelated parent (ppid = 1), so the scope + wrapper-collapse
    // rules never interfere with image/command-line assertions.
    thread_local! {
        static NEXT_PID: Cell<u32> = const { Cell::new(1000) };
    }
    fn emit(f: &mut CaptureFilter, image: &str, command_line: &str) -> bool {
        let pid = NEXT_PID.with(|c| {
            let v = c.get();
            c.set(v + 1);
            v
        });
        f.should_emit(pid, 1, image, command_line)
    }

    #[test]
    fn accepts_a_normal_user_command() {
        let mut f = filter();
        assert!(emit(
            &mut f,
            "C:/Program Files/Git/bin/git.exe",
            "git status"
        ));
    }

    #[test]
    fn rejects_procmix_itself_by_basename() {
        let mut f = filter();
        // Different directory, same exe name — still ProcMix.
        assert!(!emit(&mut f, "D:/elsewhere/procmix.exe", "procmix"));
    }

    #[test]
    fn self_exclusion_is_case_insensitive() {
        let mut f = CaptureFilter::new("C:/app/ProcMix.EXE");
        assert!(!emit(&mut f, "C:/app/procmix.exe", "procmix"));
    }

    #[cfg(windows)]
    #[test]
    fn rejects_system_noise_regardless_of_path_or_case() {
        let mut f = filter();
        assert!(!emit(
            &mut f,
            "C:/Windows/System32/svchost.exe",
            "svchost -k netsvcs"
        ));
        assert!(!emit(
            &mut f,
            "C:/Windows/System32/SVCHOST.EXE",
            "svchost -k other"
        ));
        assert!(!emit(&mut f, "C:/Windows/System32/RuntimeBroker.exe", ""));
    }

    /// Linux parallel: the cn_proc session-plumbing noise is dropped by
    /// basename, case-insensitively, regardless of the `/usr/...` path.
    #[cfg(target_os = "linux")]
    #[test]
    fn rejects_linux_system_noise_regardless_of_path_or_case() {
        let mut f = filter();
        assert!(!emit(&mut f, "/usr/libexec/gvfsd", "gvfsd"));
        assert!(!emit(&mut f, "/usr/libexec/GVFSD", "gvfsd"));
        assert!(!emit(
            &mut f,
            "/usr/libexec/xdg-desktop-portal",
            "/usr/libexec/xdg-desktop-portal"
        ));
        assert!(!emit(&mut f, "/usr/bin/dconf-service", "dconf-service"));
    }

    /// Linux must NOT blacklist user shells / interpreters — those are
    /// exactly the commands worth capturing, so they flow through.
    #[cfg(target_os = "linux")]
    #[test]
    fn keeps_user_shells_and_interpreters_on_linux() {
        let mut f = filter();
        assert!(emit(&mut f, "/usr/bin/bash", "bash -c 'make build'"));
        assert!(emit(&mut f, "/usr/bin/sh", "sh deploy.sh"));
        assert!(emit(
            &mut f,
            "/usr/bin/python3",
            "python3 manage.py migrate"
        ));
        assert!(emit(&mut f, "/usr/bin/git", "git status"));
    }

    #[test]
    fn rejects_chromium_helper_children() {
        let mut f = filter();
        // draw.io (Electron) renderer.
        assert!(!emit(
            &mut f,
            "C:/Program Files/WindowsApps/draw.io/app/draw.io.exe",
            "\"C:\\Program Files\\WindowsApps\\draw.io\\app\\draw.io.exe\" \
             --type=renderer --user-data-dir=\"C:\\Users\\Mi\\AppData\\Roaming\\draw.io\" \
             --field-trial-handle=1304,i,11969538719744404825,4625502481333311898,262144"
        ));
        // ProcMix's OWN WebView2 GPU process — different image name than
        // procmix.exe, so only this rule (not self-exclusion) catches it.
        assert!(!emit(
            &mut f,
            "C:/Program Files (x86)/Microsoft/EdgeWebView/Application/149/msedgewebview2.exe",
            "\"...\\msedgewebview2.exe\" --type=gpu-process \
             --webview-exe-name=procmix.exe --mojo-platform-channel-handle=1316"
        ));
    }

    #[test]
    fn keeps_main_app_launch_and_type_lookalikes() {
        let mut f = filter();
        // Main Electron process: no --type, no IPC handle — a real launch.
        assert!(emit(
            &mut f,
            "C:/Program Files/WindowsApps/draw.io/app/draw.io.exe",
            "\"C:\\Program Files\\WindowsApps\\draw.io\\app\\draw.io.exe\" "
        ));
        // A genuine CLI tool that takes a `--type` argument but is not a
        // Chromium child (no IPC handle) must NOT be filtered.
        assert!(emit(
            &mut f,
            "C:/tools/convert.exe",
            "convert --type=png input.svg output.png"
        ));
    }

    #[test]
    fn dedupes_identical_image_and_command_line() {
        let mut f = filter();
        assert!(emit(&mut f, "C:/tools/ffmpeg.exe", "ffmpeg -i a.mp4 b.mp4"));
        // Exact repeat is suppressed.
        assert!(!emit(
            &mut f,
            "C:/tools/ffmpeg.exe",
            "ffmpeg -i a.mp4 b.mp4"
        ));
    }

    #[test]
    fn different_command_line_for_same_image_is_kept() {
        let mut f = filter();
        assert!(emit(&mut f, "C:/tools/ffmpeg.exe", "ffmpeg -i a.mp4 b.mp4"));
        assert!(emit(&mut f, "C:/tools/ffmpeg.exe", "ffmpeg -i c.mp4 d.mp4"));
    }

    #[test]
    fn same_command_line_for_different_image_is_kept() {
        let mut f = filter();
        assert!(emit(&mut f, "C:/a/run.exe", "run"));
        assert!(emit(&mut f, "C:/b/run.exe", "run"));
    }

    #[test]
    fn dedup_set_evicts_oldest_at_capacity() {
        let mut f = filter();
        // Fill to capacity with distinct keys.
        for i in 0..DEDUP_CAPACITY {
            assert!(emit(&mut f, "C:/x.exe", &format!("cmd {i}")));
        }
        // The very first key should now be evictable: inserting one more
        // distinct key evicts "cmd 0", so re-emitting it is accepted again.
        assert!(emit(&mut f, "C:/x.exe", &format!("cmd {DEDUP_CAPACITY}")));
        assert!(
            emit(&mut f, "C:/x.exe", "cmd 0"),
            "oldest key should have been evicted, allowing re-emit"
        );
        // A key still inside the window stays deduped.
        assert!(!emit(&mut f, "C:/x.exe", &format!("cmd {DEDUP_CAPACITY}")));
    }

    #[test]
    fn dedup_set_is_bounded() {
        let mut f = filter();
        for i in 0..(DEDUP_CAPACITY * 3) {
            emit(&mut f, "C:/x.exe", &format!("cmd {i}"));
        }
        assert!(
            f.dedup_seen.len() <= DEDUP_CAPACITY,
            "dedup set must stay bounded, got {}",
            f.dedup_seen.len()
        );
        assert_eq!(
            f.dedup_seen.len(),
            f.dedup_order.len(),
            "set and order queue must stay in lockstep"
        );
    }

    // ---- Rule 0: scope (Stage 1) ----

    #[test]
    fn scope_subtree_keeps_only_the_chosen_tree() {
        let roots = std::iter::once(500u32).collect();
        let mut f =
            CaptureFilter::with_scope("/opt/procmix/procmix", CaptureScope::Subtree { roots });
        // Root and its child are captured.
        assert!(f.should_emit(500, 1, "/usr/bin/app", "app"));
        assert!(f.should_emit(600, 500, "/usr/bin/git", "git status"));
        // A sibling-branch process (IDE/Docker noise) is dropped by scope.
        assert!(!f.should_emit(700, 9, "/usr/bin/git", "git for-each-ref"));
    }

    #[test]
    fn scope_exclude_subtree_drops_self_tree_keeps_rest() {
        let roots = std::iter::once(42u32).collect();
        let mut f = CaptureFilter::with_scope(
            "/opt/procmix/procmix",
            CaptureScope::ExcludeSubtree { roots },
        );
        // The excluded subtree (e.g. the launcher/agent) is suppressed...
        assert!(!f.should_emit(42, 1, "/usr/bin/rg", "rg pattern"));
        assert!(!f.should_emit(43, 42, "/usr/bin/git", "git status"));
        // ...but an unrelated user launch flows through.
        assert!(f.should_emit(99, 7, "/usr/bin/ffmpeg", "ffmpeg -i a b"));
    }

    #[test]
    fn seed_scope_pulls_in_preexisting_children() {
        let roots = std::iter::once(500u32).collect();
        let mut f =
            CaptureFilter::with_scope("/opt/procmix/procmix", CaptureScope::Subtree { roots });
        // 600 was already a child of the root before recording began.
        f.seed_scope(&[(600, 500), (500, 1)]);
        // A child of the pre-existing 600 is recognised without a fresh
        // spawn event for 600.
        assert!(f.should_emit(601, 600, "/usr/bin/node", "node build.js"));
    }

    // ---- Rule 0b: mandatory self-exclusion (Stage 4, §3.4) ----

    #[test]
    fn self_exclusion_drops_own_subtree_even_under_all_scope() {
        // Scope = All, but ProcMix's own subtree (root 42) must never surface.
        let mut f = CaptureFilter::with_scope_and_self_subtree(
            "/opt/procmix/procmix",
            CaptureScope::All,
            std::iter::once(42u32).collect(),
        );
        // The launcher root and its descendants (the agent's `rg`/`git`) are
        // suppressed...
        assert!(!f.should_emit(42, 1, "/usr/bin/sh", "sh"));
        assert!(!f.should_emit(43, 42, "/usr/bin/rg", "rg pattern"));
        assert!(!f.should_emit(44, 43, "/usr/bin/git", "git status"));
        // ...while an unrelated user launch under `All` still flows through.
        assert!(f.should_emit(99, 7, "/usr/bin/ffmpeg", "ffmpeg -i a b"));
    }

    #[test]
    fn self_exclusion_layers_on_top_of_subtree_scope() {
        // Capture app subtree (root 500) but ALSO exclude ProcMix's tree
        // (root 500's child 600 belongs to ProcMix in this contrived case).
        let mut f = CaptureFilter::with_scope_and_self_subtree(
            "/opt/procmix/procmix",
            CaptureScope::Subtree {
                roots: std::iter::once(500u32).collect(),
            },
            std::iter::once(600u32).collect(),
        );
        assert!(f.should_emit(500, 1, "/usr/bin/app", "app")); // in scope, not self
        assert!(f.should_emit(700, 500, "/usr/bin/git", "git log")); // in scope, not self
                                                                     // 600 is in the capture scope (child of 500) BUT also in the excluded
                                                                     // self subtree → suppressed; and so are its descendants.
        assert!(!f.should_emit(600, 500, "/usr/bin/sh", "sh"));
        assert!(!f.should_emit(601, 600, "/usr/bin/rg", "rg x"));
    }

    #[test]
    fn no_self_exclusion_when_roots_empty() {
        // Empty self-roots disables self-exclusion (the unit-test default via
        // `with_scope`); behaviour is unchanged from before Stage 4.
        let mut f = filter();
        assert!(f.should_emit(std::process::id(), 1, "/usr/bin/git", "git status"));
    }

    #[test]
    fn self_exclusion_needs_seeding_even_under_all() {
        // Because self-exclusion is an ExcludeSubtree, the platform must still
        // snapshot the tree to seed it — needs_seeding is true even for `All`.
        let f = CaptureFilter::with_scope_and_self_subtree(
            "/opt/procmix/procmix",
            CaptureScope::All,
            std::iter::once(42u32).collect(),
        );
        assert!(f.needs_seeding());
        // ...but with NO self-roots and `All`, no seeding is needed.
        let f2 = filter();
        assert!(!f2.needs_seeding());
    }

    // ---- Rule 4: shell-wrapper collapse (Stage 1, §3.5) ----

    #[test]
    fn collapses_sh_c_pipeline_stages_by_ppid() {
        let mut f = filter();
        // The wrapper itself surfaces (it carries the user's full intent).
        assert!(f.should_emit(
            100,
            1,
            "/usr/bin/dash",
            "sh -c -- lsblk | sed s/x// | tr -s ' '"
        ));
        // Every pipeline stage is a DIRECT child of the wrapper shell (ppid
        // 100) and is suppressed as plumbing.
        assert!(!f.should_emit(101, 100, "/usr/bin/lsblk", "lsblk"));
        assert!(!f.should_emit(102, 100, "/usr/bin/sed", "sed s/x//"));
        assert!(!f.should_emit(103, 100, "/usr/bin/tr", "tr -s  "));
    }

    #[test]
    fn collapses_sh_c_wrapped_tool_reexec() {
        let mut f = filter();
        // `/bin/sh -c git status` → wrapper, then git re-exec'd as its child.
        assert!(f.should_emit(200, 1, "/usr/bin/dash", "/bin/sh -c git status --porcelain"));
        assert!(!f.should_emit(201, 200, "/usr/bin/git", "git status --porcelain"));
    }

    #[test]
    fn wrapper_collapse_does_not_suppress_grandchildren() {
        let mut f = filter();
        // Wrapper shell (300) → wrapped tool (301, suppressed) → the tool's
        // OWN launch (302) whose ppid is the TOOL, not the shell — must surface.
        assert!(f.should_emit(300, 1, "/usr/bin/bash", "bash -c make"));
        assert!(!f.should_emit(301, 300, "/usr/bin/make", "make"));
        assert!(f.should_emit(302, 301, "/usr/bin/gcc", "gcc -c main.c"));
    }

    #[test]
    fn shell_without_dash_c_is_not_a_wrapper() {
        let mut f = filter();
        // `sh deploy.sh` is a real script run, not a `-c` wrapper; its child
        // must NOT be suppressed.
        assert!(f.should_emit(400, 1, "/usr/bin/sh", "sh deploy.sh"));
        assert!(f.should_emit(401, 400, "/usr/bin/git", "git pull"));
    }

    #[test]
    fn nested_sh_c_wrapper_child_is_suppressed_and_collapses_its_own_children() {
        let mut f = filter();
        // Outer wrapper surfaces.
        assert!(f.should_emit(700, 1, "/usr/bin/dash", "sh -c 'sh -c inner'"));
        // The inner `sh -c` is a direct child of the outer shell → suppressed
        // as plumbing...
        assert!(!f.should_emit(701, 700, "/usr/bin/dash", "sh -c inner"));
        // ...AND it is itself registered as a wrapper, so ITS child is also
        // suppressed.
        assert!(!f.should_emit(702, 701, "/usr/bin/inner", "inner"));
    }

    #[test]
    fn on_exit_prunes_wrapper_so_reused_pid_does_not_suppress() {
        let mut f = filter();
        assert!(f.should_emit(500, 1, "/usr/bin/sh", "sh -c echo hi"));
        f.on_exit(500); // wrapper dies; pid 500 may be reused
                        // A NEW unrelated process that reuses 500 as parent must not be
                        // collapsed as a stale wrapper child.
        assert!(f.should_emit(501, 500, "/usr/bin/git", "git status"));
    }

    // ---- Pure helpers ----

    #[test]
    fn is_shell_c_wrapper_detects_variants() {
        assert!(is_shell_c_wrapper("/usr/bin/dash", "sh -c echo hi"));
        assert!(is_shell_c_wrapper("/bin/bash", "bash -lc 'make'"));
        assert!(is_shell_c_wrapper("/usr/bin/sh", "sh -c -- pipeline"));
        // Not a `-c` invocation.
        assert!(!is_shell_c_wrapper("/usr/bin/sh", "sh deploy.sh"));
        assert!(!is_shell_c_wrapper("/usr/bin/bash", "bash"));
        // Not a shell.
        assert!(!is_shell_c_wrapper(
            "/usr/bin/git",
            "git -c foo.bar=1 status"
        ));
    }
}
