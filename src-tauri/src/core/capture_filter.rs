// Noise filtering for Process Capture (the background "command recorder").
//
// The raw ETW `ProcessStart` stream is extremely noisy: Windows constantly
// spawns service hosts, runtime brokers, and the like, and ProcMix itself
// spawns children when it runs commands. Surfacing all of that would bury
// the handful of starts the user actually cares about (the CLI a GUI app
// launched when they clicked a button).
//
// This module is PURE and platform-agnostic: it operates on the
// image-path / command-line strings, holds no OS handles, and is driven
// entirely by unit tests. The Windows ETW callback owns a
// [`CaptureFilter`] and calls [`CaptureFilter::should_emit`] for each
// record before emitting a `CaptureEvent`.
//
// Three rejection rules, in order of precedence:
//   1. Self-exclusion — never surface ProcMix's own process or the shells
//      it spawns to run commands, or capture would echo its own activity.
//   2. System-noise blacklist — drop high-frequency OS plumbing by image
//      basename (case-insensitive).
//   3. Deduplication — suppress an (image, command-line) pair already seen
//      recently, bounded so the set cannot grow without limit.

use std::collections::{HashSet, VecDeque};

/// Image basenames (lowercased) that are pure OS/runtime plumbing. These
/// are spawned constantly and never represent a user action worth turning
/// into a command, so they are dropped before reaching the UI.
///
/// Intentionally conservative: only well-known, high-frequency system
/// hosts. Anything not on this list still flows through — a missed-noise
/// row is a minor annoyance, whereas over-filtering could hide a real
/// command the user wanted to capture.
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

/// Stateful capture filter. One instance lives for the duration of a
/// capture session (owned by the ETW callback). `should_emit` is the only
/// method called on the hot path.
///
/// `allow(dead_code)` off Windows: the filter is only wired into the
/// Windows ETW callback, but the logic is platform-agnostic and fully
/// exercised by the unit tests below on every platform.
#[cfg_attr(not(windows), allow(dead_code))]
pub struct CaptureFilter {
    /// Lowercased basename of ProcMix's own executable, so its self-spawned
    /// children and its own process are excluded.
    self_image: String,
    /// Recently-seen (image, command-line) keys for dedup, with insertion
    /// order tracked in `dedup_order` for FIFO eviction.
    dedup_seen: HashSet<String>,
    dedup_order: VecDeque<String>,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl CaptureFilter {
    /// Build a filter that excludes the given ProcMix executable path.
    /// Typically `std::env::current_exe()` on Windows; tests pass a literal.
    pub fn new(self_exe_path: &str) -> Self {
        Self {
            self_image: basename_lower(self_exe_path),
            dedup_seen: HashSet::new(),
            dedup_order: VecDeque::new(),
        }
    }

    /// Decide whether a captured process start should be surfaced.
    ///
    /// Returns `true` only if the record passes all three rules. Has the
    /// side effect of recording the (image, command-line) pair for dedup
    /// when it is accepted — so a subsequent identical pair is suppressed.
    pub fn should_emit(&mut self, image: &str, command_line: &str) -> bool {
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

        // Rule 4: dedup. Key on the raw image + command line so two genuinely
        // different invocations of the same binary are both kept.
        let key = format!("{image}\u{0}{command_line}");
        if self.dedup_seen.contains(&key) {
            return false;
        }
        self.remember(key);
        true
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

    fn filter() -> CaptureFilter {
        CaptureFilter::new("C:/Program Files/ProcMix/procmix.exe")
    }

    #[test]
    fn accepts_a_normal_user_command() {
        let mut f = filter();
        assert!(f.should_emit("C:/Program Files/Git/bin/git.exe", "git status"));
    }

    #[test]
    fn rejects_procmix_itself_by_basename() {
        let mut f = filter();
        // Different directory, same exe name — still ProcMix.
        assert!(!f.should_emit("D:/elsewhere/procmix.exe", "procmix"));
    }

    #[test]
    fn self_exclusion_is_case_insensitive() {
        let mut f = CaptureFilter::new("C:/app/ProcMix.EXE");
        assert!(!f.should_emit("C:/app/procmix.exe", "procmix"));
    }

    #[test]
    fn rejects_system_noise_regardless_of_path_or_case() {
        let mut f = filter();
        assert!(!f.should_emit("C:/Windows/System32/svchost.exe", "svchost -k netsvcs"));
        assert!(!f.should_emit("C:/Windows/System32/SVCHOST.EXE", "svchost -k other"));
        assert!(!f.should_emit("C:/Windows/System32/RuntimeBroker.exe", ""));
    }

    #[test]
    fn rejects_chromium_helper_children() {
        let mut f = filter();
        // draw.io (Electron) renderer.
        assert!(!f.should_emit(
            "C:/Program Files/WindowsApps/draw.io/app/draw.io.exe",
            "\"C:\\Program Files\\WindowsApps\\draw.io\\app\\draw.io.exe\" \
             --type=renderer --user-data-dir=\"C:\\Users\\Mi\\AppData\\Roaming\\draw.io\" \
             --field-trial-handle=1304,i,11969538719744404825,4625502481333311898,262144"
        ));
        // ProcMix's OWN WebView2 GPU process — different image name than
        // procmix.exe, so only this rule (not self-exclusion) catches it.
        assert!(!f.should_emit(
            "C:/Program Files (x86)/Microsoft/EdgeWebView/Application/149/msedgewebview2.exe",
            "\"...\\msedgewebview2.exe\" --type=gpu-process \
             --webview-exe-name=procmix.exe --mojo-platform-channel-handle=1316"
        ));
    }

    #[test]
    fn keeps_main_app_launch_and_type_lookalikes() {
        let mut f = filter();
        // Main Electron process: no --type, no IPC handle — a real launch.
        assert!(f.should_emit(
            "C:/Program Files/WindowsApps/draw.io/app/draw.io.exe",
            "\"C:\\Program Files\\WindowsApps\\draw.io\\app\\draw.io.exe\" "
        ));
        // A genuine CLI tool that takes a `--type` argument but is not a
        // Chromium child (no IPC handle) must NOT be filtered.
        assert!(f.should_emit(
            "C:/tools/convert.exe",
            "convert --type=png input.svg output.png"
        ));
    }

    #[test]
    fn dedupes_identical_image_and_command_line() {
        let mut f = filter();
        assert!(f.should_emit("C:/tools/ffmpeg.exe", "ffmpeg -i a.mp4 b.mp4"));
        // Exact repeat is suppressed.
        assert!(!f.should_emit("C:/tools/ffmpeg.exe", "ffmpeg -i a.mp4 b.mp4"));
    }

    #[test]
    fn different_command_line_for_same_image_is_kept() {
        let mut f = filter();
        assert!(f.should_emit("C:/tools/ffmpeg.exe", "ffmpeg -i a.mp4 b.mp4"));
        assert!(f.should_emit("C:/tools/ffmpeg.exe", "ffmpeg -i c.mp4 d.mp4"));
    }

    #[test]
    fn same_command_line_for_different_image_is_kept() {
        let mut f = filter();
        assert!(f.should_emit("C:/a/run.exe", "run"));
        assert!(f.should_emit("C:/b/run.exe", "run"));
    }

    #[test]
    fn dedup_set_evicts_oldest_at_capacity() {
        let mut f = filter();
        // Fill to capacity with distinct keys.
        for i in 0..DEDUP_CAPACITY {
            assert!(f.should_emit("C:/x.exe", &format!("cmd {i}")));
        }
        // The very first key should now be evictable: inserting one more
        // distinct key evicts "cmd 0", so re-emitting it is accepted again.
        assert!(f.should_emit("C:/x.exe", &format!("cmd {DEDUP_CAPACITY}")));
        assert!(
            f.should_emit("C:/x.exe", "cmd 0"),
            "oldest key should have been evicted, allowing re-emit"
        );
        // A key still inside the window stays deduped.
        assert!(!f.should_emit("C:/x.exe", &format!("cmd {DEDUP_CAPACITY}")));
    }

    #[test]
    fn dedup_set_is_bounded() {
        let mut f = filter();
        for i in 0..(DEDUP_CAPACITY * 3) {
            f.should_emit("C:/x.exe", &format!("cmd {i}"));
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
}
