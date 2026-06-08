//! Shell-availability detection.
//!
//! The CRUD form on the frontend asks the user to pick a shell for each
//! command. To avoid offering a binary the host system cannot run, we
//! probe the `PATH` (and a couple of well-known absolute locations on
//! Windows) at startup and return the subset of known shell identifiers
//! that resolve to an executable.
//!
//! Detection is best-effort and deliberately cheap: no subprocesses are
//! spawned, no version checks are performed. The list returned here is
//! cached for the lifetime of the session on the JS side.
//!
//! The set of "known" shell identifiers mirrors the `Shell` union in
//! `src/types/command.ts`. Any new entry must be added in both places.

use std::collections::HashSet;
#[cfg(target_os = "windows")]
use std::path::Path;
use std::path::PathBuf;

/// Logical shell identifier as exposed across the IPC boundary. These
/// strings match the `Shell` TS union character-for-character.
const KNOWN_SHELLS: &[(&str, &[&str])] = &[
    ("bash", &["bash"]),
    ("zsh", &["zsh"]),
    ("sh", &["sh"]),
    ("fish", &["fish"]),
    ("pwsh", &["pwsh"]),
    ("powershell", &["powershell"]),
    ("cmd", &["cmd"]),
];

/// Well-known absolute paths probed as a safety net on Windows, in case
/// `PATH` is unusually trimmed (system-wide PowerShell and cmd live in
/// `System32` and are essentially guaranteed to be present).
#[cfg(target_os = "windows")]
const WINDOWS_WELL_KNOWN: &[(&str, &str)] = &[
    ("cmd", r"C:\Windows\System32\cmd.exe"),
    (
        "powershell",
        r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
    ),
];

/// Returns the list of shell identifiers detected on the current host.
///
/// The order matches the declaration order in `KNOWN_SHELLS`, and each
/// identifier appears at most once. The empty vec is a valid return
/// value (PATH is empty, sandboxed environment, etc.); callers are
/// expected to fall back to a platform default in that case.
pub fn detect_available_shells() -> Vec<String> {
    let path_dirs = split_path_env();
    let mut found: Vec<String> = Vec::with_capacity(KNOWN_SHELLS.len());
    let mut seen: HashSet<&str> = HashSet::with_capacity(KNOWN_SHELLS.len());

    for (id, candidates) in KNOWN_SHELLS.iter() {
        if seen.contains(id) {
            continue;
        }
        if candidates
            .iter()
            .any(|name| binary_in_path(name, &path_dirs))
        {
            found.push((*id).to_string());
            seen.insert(id);
        }
    }

    #[cfg(target_os = "windows")]
    {
        for (id, abs_path) in WINDOWS_WELL_KNOWN.iter() {
            if seen.contains(id) {
                continue;
            }
            if Path::new(abs_path).is_file() {
                found.push((*id).to_string());
                seen.insert(id);
            }
        }
    }

    found
}

/// Split the host PATH environment variable into directory components.
/// Returns an empty vec when PATH is unset or empty.
fn split_path_env() -> Vec<PathBuf> {
    match std::env::var_os("PATH") {
        Some(value) => std::env::split_paths(&value).collect(),
        None => Vec::new(),
    }
}

/// Returns true iff `name` resolves to an executable file in any of the
/// supplied directories. On Windows we also try common executable
/// extensions (`.exe`, `.cmd`, `.bat`) so callers don't have to encode
/// them per-shell.
fn binary_in_path(name: &str, dirs: &[PathBuf]) -> bool {
    let candidates = build_candidate_filenames(name);
    for dir in dirs {
        for filename in &candidates {
            let candidate = dir.join(filename);
            if candidate.is_file() {
                return true;
            }
        }
    }
    false
}

#[cfg(target_os = "windows")]
fn build_candidate_filenames(name: &str) -> Vec<String> {
    // If the caller already supplied an extension, keep it as-is in
    // addition to the bare name. Otherwise try the common executable
    // suffixes Windows uses to locate binaries (matching PATHEXT order
    // closely enough for shells we care about).
    let lower = name.to_ascii_lowercase();
    let has_ext = Path::new(&lower)
        .extension()
        .map(|e| !e.is_empty())
        .unwrap_or(false);
    if has_ext {
        return vec![name.to_string()];
    }
    vec![
        format!("{name}.exe"),
        format!("{name}.cmd"),
        format!("{name}.bat"),
        name.to_string(),
    ]
}

#[cfg(not(target_os = "windows"))]
fn build_candidate_filenames(name: &str) -> Vec<String> {
    // POSIX: no implicit extensions.
    vec![name.to_string()]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke test: on any developer machine we expect at least one
    /// shell to resolve. A zero return is technically valid in
    /// sandboxed environments, but it would also mean the form has
    /// nothing to offer — flag if it happens during local dev.
    #[test]
    fn detect_returns_at_least_one_shell() {
        let shells = detect_available_shells();
        assert!(
            !shells.is_empty(),
            "expected at least one shell on this host, got an empty list"
        );
    }

    #[cfg(unix)]
    #[test]
    fn detect_finds_sh_on_unix() {
        let shells = detect_available_shells();
        assert!(
            shells.iter().any(|s| s == "sh"),
            "expected `sh` to be present on a Unix host, got {shells:?}"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn detect_finds_cmd_on_windows() {
        let shells = detect_available_shells();
        assert!(
            shells.iter().any(|s| s == "cmd"),
            "expected `cmd` to be present on a Windows host, got {shells:?}"
        );
    }

    #[test]
    fn results_have_no_duplicates() {
        let shells = detect_available_shells();
        let mut seen = HashSet::new();
        for sh in &shells {
            assert!(seen.insert(sh.clone()), "duplicate shell entry: {sh}");
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn candidate_filenames_posix_is_bare() {
        let candidates = build_candidate_filenames("bash");
        assert_eq!(candidates, vec!["bash".to_string()]);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn candidate_filenames_windows_includes_exe() {
        let candidates = build_candidate_filenames("pwsh");
        assert!(candidates.iter().any(|c| c == "pwsh.exe"));
        assert!(candidates.iter().any(|c| c == "pwsh"));
    }
}
