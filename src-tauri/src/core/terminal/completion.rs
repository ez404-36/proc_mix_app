//! Tab-completion candidate lookup for the interactive Terminal.
//!
//! Pure read-only filesystem/PATH enumeration: no process spawn, no shell,
//! no writes. The FRONTEND owns all command-line parsing (quote handling,
//! first-word detection, `~` expansion — see
//! `app/src/components/Terminal/completion/parseLine.ts`) and sends this
//! module an already-parsed request: what KIND of word is being completed,
//! the literal prefix to match, and (for path kinds) the absolute base
//! directory to search. Keeping the IO here and the parsing there means
//! every parsing rule is unit-testable in Vitest and every filesystem rule
//! is unit-testable in Rust.
//!
//! Like every other `core::terminal` API this is UI-only: it is NOT
//! reachable from `core::http_server`, the scheduler, or the workflow
//! runner. See `docs/interactive-terminal.md` for the boundary rationale.

use std::collections::BTreeSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// What kind of word the frontend decided is being completed (see the
/// parsing rules in `parseLine.ts`). Mirrors the TS
/// `TerminalCompletionKind` union.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompletionKind {
    /// The first word of a command line: complete executable names from
    /// `$PATH` plus a fixed list of common shell builtins.
    Command,
    /// A later word: complete files AND directories under `base_dir`.
    Path,
    /// A later word after `cd`/`pushd`/`rmdir`: directories only.
    Dir,
}

/// One completion candidate. `name` is the last path segment (or bare
/// executable name for [`CompletionKind::Command`]) — never a full path;
/// the frontend re-joins it onto the already-typed directory part.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionCandidate {
    pub name: String,
    pub is_dir: bool,
}

/// Request payload of the `terminal_complete` command. Mirrors the TS
/// `TerminalCompletionRequest`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionRequest {
    pub kind: CompletionKind,
    /// Literal text (already unquoted by the frontend) the candidates must
    /// start with. Empty prefix = every entry in the searched location.
    pub prefix: String,
    /// Absolute directory to search for [`CompletionKind::Path`] and
    /// [`CompletionKind::Dir`]. Ignored (may be `None`) for
    /// [`CompletionKind::Command`], which searches `$PATH` instead.
    pub base_dir: Option<String>,
}

/// Response payload of the `terminal_complete` command. Mirrors the TS
/// `TerminalCompletionResponse`. `candidates` is sorted by name and capped
/// at [`MAX_COMPLETION_CANDIDATES`]; an empty list tells the frontend to
/// fall through to the shell's own native readline completion.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionResponse {
    pub candidates: Vec<CompletionCandidate>,
}

/// Hard cap on returned candidates. Bounds both the IPC payload and the
/// popup's usefulness (a list of 5000 entries is not completable by eye
/// anyway) — the user can always type one more character to narrow it.
pub const MAX_COMPLETION_CANDIDATES: usize = 200;

/// A deliberately SMALL fixed set of common POSIX-shell builtins. Bash's
/// own builtin list is much larger and shell-dependent (bash vs zsh vs
/// busybox), but these are the ones that appear at a command position most
/// often and are never visible in `$PATH` scans. `sudo`-style command
/// prefixes are handled on the frontend (it decides a word is a command
/// position at all), not here.
const SHELL_BUILTINS: [&str; 24] = [
    "alias", "bg", "cd", "command", "declare", "echo", "eval", "exec", "exit", "export", "false",
    "fc", "fg", "history", "jobs", "kill", "local", "popd", "pushd", "pwd", "read", "return",
    "source", "true",
];

/// Compute completion candidates for one parsed word. Errors only on
/// invalid requests (e.g. a path kind without a base directory); an
/// unreadable/unexisting directory or `$PATH` entry simply contributes no
/// candidates — completion is best-effort, never fatal.
pub fn complete(request: &CompletionRequest) -> Result<CompletionResponse, String> {
    match request.kind {
        CompletionKind::Command => Ok(complete_commands(&request.prefix)),
        CompletionKind::Path | CompletionKind::Dir => {
            let base_dir = request.base_dir.as_deref().unwrap_or_default();
            if base_dir.is_empty() {
                return Err("path completion requires base_dir".to_string());
            }
            Ok(complete_paths(
                base_dir,
                &request.prefix,
                request.kind == CompletionKind::Dir,
            ))
        }
    }
}

/// Complete an executable name: union of (a) every builtin whose name
/// starts with `prefix` and (b) every executable file found in any `$PATH`
/// directory whose name starts with `prefix` (deduplicated across dirs —
/// the same binary shadowed on several PATH entries is ONE candidate).
fn complete_commands(prefix: &str) -> CompletionResponse {
    // Builtins get RESERVED slots before the cap: on a full desktop PATH,
    // >200 executables can sort before an early-alphabet builtin like
    // `cd`, and a plain take(cap) would silently drop exactly the names
    // that PATH scanning can never rediscover.
    let mut names: Vec<String> = SHELL_BUILTINS
        .iter()
        .filter(|b| b.starts_with(prefix))
        .map(|b| (*b).to_string())
        .collect();
    names.sort();
    names.dedup();

    let mut path_names: BTreeSet<String> = BTreeSet::new();
    for dir in path_directories() {
        collect_in_dir(Path::new(&dir), prefix, false, true, &mut |mut entry| {
            entry.is_dir = false;
            path_names.insert(entry.name);
        });
    }

    let remaining = MAX_COMPLETION_CANDIDATES.saturating_sub(names.len());
    names.extend(path_names.into_iter().take(remaining));
    names.sort();
    names.dedup(); // a PATH binary shadowing a builtin (e.g. /bin/kill)
    names.truncate(MAX_COMPLETION_CANDIDATES);

    let candidates = names
        .into_iter()
        .map(|name| CompletionCandidate {
            name,
            is_dir: false,
        })
        .collect();
    CompletionResponse { candidates }
}

/// Complete a file/directory name inside `base_dir`. `dirs_only` restricts
/// candidates to directories (after `cd` & co.). Symlinks are followed for
/// the directory flag (bash offers a symlink-to-dir with a trailing `/`).
fn complete_paths(base_dir: &str, prefix: &str, dirs_only: bool) -> CompletionResponse {
    let mut candidates: Vec<CompletionCandidate> = Vec::new();
    collect_in_dir(
        Path::new(base_dir),
        prefix,
        dirs_only,
        false,
        &mut |entry| {
            candidates.push(entry);
        },
    );
    candidates.sort();
    candidates.truncate(MAX_COMPLETION_CANDIDATES);
    CompletionResponse { candidates }
}

/// The directories of this process's `$PATH`, empty on a missing or
/// malformed value (an empty list just yields builtin-only completion).
fn path_directories() -> Vec<String> {
    // `split_paths` uses the OS PATH-list separator (`:` on Unix, `;` on
    // Windows) — NOT `MAIN_SEPARATOR`, which is the path-component slash
    // and would split every entry apart. Empty entries (a doubled `:`) are
    // conventionally CWD in POSIX shells — skip them rather than silently
    // completing against whatever CWD is.
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.to_string_lossy().into_owned())
        .collect()
}

/// Call `emit` for every entry of `dir` whose file name starts with
/// `prefix` (passing through the `dirs_only` filter). Per-directory IO
/// failures are swallowed: one unreadable directory must not kill the
/// whole completion — this mirrors bash, which also silently skips
/// unreadable PATH entries. Hidden entries (leading `.`) are only offered
/// when the typed prefix itself starts with `.`, like bash/readline.
/// `require_executable` (the PATH-scan mode) keeps only entries whose
/// permission bits mark them executable on Unix; on Windows every regular
/// file is offered (there is no mode bit — a proper PATHEXT filter is v2,
/// see the plan).
fn collect_in_dir(
    dir: &Path,
    prefix: &str,
    dirs_only: bool,
    require_executable: bool,
    emit: &mut dyn FnMut(CompletionCandidate),
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue; // non-UTF-8 names: skip (the frontend works in UTF-8)
        };
        // Hidden entries (leading `.`) are only offered when the typed
        // prefix itself starts with `.`, like bash/readline.
        if name.starts_with('.') && !prefix.starts_with('.') {
            continue;
        }
        if !name.starts_with(prefix) {
            continue;
        }
        let meta = entry.metadata().ok(); // follows symlinks; broken → None
        let is_dir = meta.as_ref().is_some_and(|m| m.is_dir());
        if require_executable && !meta.as_ref().is_some_and(is_executable_meta) {
            continue;
        }
        if dirs_only && !is_dir {
            continue;
        }
        emit(CompletionCandidate {
            name: name.to_string(),
            is_dir,
        });
    }
}

/// Unix: any execute bit (owner/group/other) counts, like bash's PATH
/// lookup. Windows: no mode bit exists — offer every regular file (v2).
#[cfg(unix)]
fn is_executable_meta(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable_meta(_meta: &std::fs::Metadata) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RAII temp dir for filesystem-flavoured tests: unique per-process
    /// name, removed on drop (also on assertion failure — no `unwrap`ed
    /// cleanup path to forget).
    struct TestDir(std::path::PathBuf);

    impl TestDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("procmix-completion-{tag}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    #[test]
    fn command_scan_skips_non_executables() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TestDir::new("exec");
        let script = dir.path().join("runnable.sh");
        std::fs::write(&script, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(dir.path().join("readme.txt"), b"docs").unwrap();

        let mut found: Vec<String> = Vec::new();
        collect_in_dir(dir.path(), "", false, true, &mut |entry| {
            found.push(entry.name)
        });
        assert_eq!(found, ["runnable.sh"]);

        // The same dir WITHOUT the executable filter offers both entries.
        let mut all: Vec<String> = Vec::new();
        collect_in_dir(dir.path(), "", false, false, &mut |entry| {
            all.push(entry.name)
        });
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn command_completion_includes_builtins_by_prefix() {
        let resp = complete_commands("push");
        let names: Vec<&str> = resp.candidates.iter().map(|c| c.name.as_str()).collect();
        // "push" is unique to the builtin across any sane PATH (a real
        // binary named `push` would still be fine — the assertion below
        // tolerates it), so this pins the builtin source without depending
        // on this machine's installed binaries.
        assert_eq!(names, ["pushd"]);
        assert!(resp.candidates.iter().all(|c| !c.is_dir));
    }

    #[test]
    fn command_completion_empty_prefix_is_capped() {
        let resp = complete_commands("");
        assert!(resp.candidates.len() <= MAX_COMPLETION_CANDIDATES);
        // Every builtin survives the cap regardless of how many PATH
        // executables sort before it, and the whole list is sorted.
        for builtin in SHELL_BUILTINS {
            assert!(
                resp.candidates.iter().any(|c| c.name == builtin),
                "missing builtin {builtin}"
            );
        }
        let names: Vec<&str> = resp.candidates.iter().map(|c| c.name.as_str()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);
    }

    #[test]
    fn path_completion_lists_matching_entries_with_dir_flag() {
        let dir = TestDir::new("entries");
        std::fs::create_dir_all(dir.path().join("alpha_sub")).unwrap();
        std::fs::write(dir.path().join("alpha.txt"), b"x").unwrap();
        std::fs::write(dir.path().join("zeta.txt"), b"x").unwrap();

        let base = dir.path().to_str().unwrap();
        let resp = complete_paths(base, "alpha", false);
        assert_eq!(
            resp.candidates,
            vec![
                CompletionCandidate {
                    name: "alpha.txt".to_string(),
                    is_dir: false
                },
                CompletionCandidate {
                    name: "alpha_sub".to_string(),
                    is_dir: true
                },
            ]
        );

        // `cd`-style: only the directory survives.
        let dirs_only = complete_paths(base, "alpha", true);
        assert_eq!(dirs_only.candidates.len(), 1);
        assert!(dirs_only.candidates[0].is_dir);
    }

    #[test]
    fn path_completion_hidden_entries_require_dot_prefix() {
        let dir = TestDir::new("hidden");
        std::fs::write(dir.path().join(".secret"), b"x").unwrap();
        std::fs::write(dir.path().join("visible.txt"), b"x").unwrap();

        let base = dir.path().to_str().unwrap();
        let bare = complete_paths(base, "", false);
        assert_eq!(bare.candidates.len(), 1);
        assert_eq!(bare.candidates[0].name, "visible.txt");

        let dotted = complete_paths(base, ".", false);
        assert!(dotted.candidates.iter().any(|c| c.name == ".secret"));
    }

    #[test]
    fn path_completion_swallows_missing_directory() {
        let resp = complete_paths("/definitely/not/a/real/dir", "x", false);
        assert!(resp.candidates.is_empty());
    }

    #[test]
    fn complete_rejects_path_kind_without_base_dir() {
        let request = CompletionRequest {
            kind: CompletionKind::Path,
            prefix: "x".to_string(),
            base_dir: None,
        };
        assert!(complete(&request).is_err());
    }
}
