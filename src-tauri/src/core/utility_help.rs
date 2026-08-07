//! Best-effort CLI help fetching for the command-script field.
//!
//! When the user types a script into the Command form, the frontend
//! extracts the leading utility name (e.g. `df` in `df -h /`) and asks
//! the backend for that utility's flag/option help so it can surface a
//! hover tooltip. This module owns:
//!
//!   1. Extracting a *safe* utility name from a raw script body
//!      ([`parse_utility_name`]) — mirroring the leading-line heuristic
//!      in `src/utils/detectAdminEscalation.ts` plus an escalation- and
//!      env-assignment-prefix strip.
//!   2. Fetching the help text by spawning the binary directly with a
//!      fixed argument array ([`fetch_help`]) — `--help`, then `-h`,
//!      then `man -P cat -- <name>` on Unix.
//!
//! ## Security
//!
//! The utility token is the ONLY user-derived value that reaches a child
//! process here, and it is gated by [`is_safe_utility_token`] (an
//! allow-list) — either a bare name ([`is_safe_utility_name`]) or an
//! executable path ([`is_safe_utility_path`]). The binary is ALWAYS
//! spawned directly via [`tokio::process::Command`] with a fixed arg
//! array — never through a shell — so even a path or a metacharacter that
//! slipped past validation could not be interpreted; only the literal
//! file is executed. We only ever pass `--help` / `-h` / `man`'s fixed
//! args: no user-supplied arguments are ever forwarded.

use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::core::proc_ext::NoConsoleWindow;

/// Maximum number of bytes of help text returned to the frontend. Help
/// output can be large (full man pages); we cap it and flag truncation
/// so the UI can show a "truncated" note. Truncation always lands on a
/// UTF-8 char boundary (see [`truncate_text`]).
const MAX_HELP_BYTES: usize = 16 * 1024;

/// Per-probe wall-clock budget. Some tools page or block waiting on a
/// TTY; with stdin closed they should exit promptly, but the timeout is
/// a hard backstop so a misbehaving binary can never hang the command.
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Inline-escalation tools recognised as a leading prefix. Mirrors
/// `ESCALATION_TOOLS` in `src/utils/detectAdminEscalation.ts`. When the
/// first token is one of these we look at the NEXT token for the real
/// utility name (so `sudo apt update` resolves to `apt`).
const ESCALATION_TOOLS: &[&str] = &["sudo", "doas", "pkexec"];

/// Shell command separators. We only ever look at the FIRST command in a
/// chain, so everything from the first separator onward is discarded
/// before tokenising. Listed longest-first so the scanner matches `&&`
/// and `||` before their single-character prefixes (`&`, `|`).
///
/// This makes separators behave consistently regardless of surrounding
/// whitespace: `ls;rm`, `ls ; rm` and `ls && rm` all resolve to `ls`.
/// Without it, `split_whitespace` would yield `ls;` (an unsafe token →
/// no hint) for `ls;rm` while `ls ; rm` yielded `ls` — an arbitrary
/// difference from the user's point of view.
const COMMAND_SEPARATORS: &[&str] = &["&&", "||", ";", "|", "&"];

/// Whether the utility's help was found, mirrored on the wire as
/// `"found"` / `"not-found"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UtilityHelpStatus {
    Found,
    NotFound,
}

/// Which probe produced the help text. Mirrored on the wire as
/// `"help"` / `"short-help"` / `"man"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HelpSource {
    /// `<utility> --help`
    Help,
    /// `<utility> -h`
    ShortHelp,
    /// `man -P cat -- <utility>` (Unix only)
    Man,
}

/// Result of a help-fetch, returned across the IPC boundary. The
/// frontend's `UtilityHelp` type mirrors this shape exactly (camelCase).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UtilityHelp {
    /// The utility name that was probed (echoed back so the UI can label
    /// the tooltip even if the field has since changed).
    pub utility: String,
    pub status: UtilityHelpStatus,
    /// Which probe succeeded; `None` when `status == NotFound`.
    pub source: Option<HelpSource>,
    /// The (possibly truncated) help text; `None` when `status == NotFound`.
    pub text: Option<String>,
    /// `true` when `text` was clipped to [`MAX_HELP_BYTES`].
    pub truncated: bool,
}

impl UtilityHelp {
    /// Construct the "not found" result for `utility`.
    fn not_found(utility: String) -> Self {
        Self {
            utility,
            status: UtilityHelpStatus::NotFound,
            source: None,
            text: None,
            truncated: false,
        }
    }
}

/// Extract the leading utility name from a raw script body, or `None`
/// when there is no plausible bare-utility token.
///
/// Heuristic (mirrors `detectAdminEscalation.ts` for the line scan):
///   - Use the FIRST non-empty, non-comment / non-shebang line.
///   - Strip leading `FOO=bar` environment-assignment tokens.
///   - If the next token is an escalation tool (`sudo`/`doas`/`pkexec`),
///     skip it AND any further env-assignments, and take the token after.
///   - The resulting first whitespace token is the candidate.
///   - Return `None` if the candidate is empty, a `${...}` reference, or
///     fails [`is_safe_utility_token`] (neither a safe bare name nor a
///     safe executable path).
pub fn parse_utility_name(script: &str) -> Option<String> {
    let line = first_executable_line(script)?;
    // Keep only the FIRST command of a chain. We deliberately surface a
    // hint for the leading utility only (per the feature spec), so a
    // separator anywhere in the line terminates the segment we inspect.
    let segment = first_command_segment(line);
    let mut tokens = segment.split_whitespace().peekable();

    // Strip leading env-assignment tokens (FOO=bar) before the program.
    skip_env_assignments(&mut tokens);

    // Optional single escalation prefix, followed by more env-assignments.
    if let Some(tok) = tokens.peek() {
        if ESCALATION_TOOLS.contains(tok) {
            tokens.next();
            skip_env_assignments(&mut tokens);
        }
    }

    let candidate = tokens.next()?;
    if !is_safe_utility_token(candidate) {
        return None;
    }
    Some(candidate.to_string())
}

/// True when the script's LEADING command (first executable line, first
/// command segment, after stripping `NAME=value` env-assignments) is a
/// known inline-escalation tool (`sudo` / `doas` / `pkexec`).
///
/// This is the Rust mirror of `detectAdminEscalation` in
/// `src/utils/detectAdminEscalation.ts`. It is what lets a NON-UI caller
/// (the scheduler) route a `sudo …` script through the backend's
/// `sudo -S` path instead of the non-elevated path — whose child has
/// `Stdio::null()` stdin and no TTY, so an inline `sudo` would die with
/// "a terminal is required to read the password". The UI path applies the
/// equivalent check in `executor.ts`; mirroring it here keeps a scheduled
/// run behaving identically to a direct library run.
///
/// Matches the TS semantics exactly:
///   - First executable line only (skips blanks / `#` comments / shebangs).
///   - First command segment only (everything up to `&& || ; | &`), so a
///     later-pipeline/compound `sudo` does NOT count.
///   - Strips leading `NAME=value` env-assignments before the program.
///
/// Unix-only convention; callers gate on the platform (the scheduler
/// already only sets `elevated` meaningfully on Unix sudo runs).
pub fn detect_admin_escalation(script: &str) -> bool {
    let Some(line) = first_executable_line(script) else {
        return false;
    };
    let segment = first_command_segment(line);
    let mut tokens = segment.split_whitespace().peekable();
    skip_env_assignments(&mut tokens);
    match tokens.peek() {
        Some(tok) => ESCALATION_TOOLS.contains(tok),
        None => false,
    }
}

/// True when `tok` is a valid leading-utility token: either a bare
/// utility name ([`is_safe_utility_name`]) or a safe executable path
/// ([`is_safe_utility_path`]). This is the single predicate the parser
/// and [`fetch_help`] both gate on.
fn is_safe_utility_token(tok: &str) -> bool {
    is_safe_utility_name(tok) || is_safe_utility_path(tok)
}

/// True when `tok` is a path to an executable safe to hand to
/// [`tokio::process::Command::new`] (which spawns it directly, never via
/// a shell, with a fixed argument array).
///
/// A path is recognised by containing a `/`. We allow ONLY
/// `[A-Za-z0-9_.+-/]` and require the first char to be `/` (absolute) or
/// `.` (relative `./`, `../`), so the token can never be parsed as a
/// flag. Every shell metacharacter (`$`, backticks, quotes, whitespace,
/// `;`, `|`, `&`, `<`, `>`, glob `*?[]`, `~`, `\`) is excluded by the
/// allow-list, so even though the path reaches a child process it cannot
/// be interpreted — only the literal file at that path is executed.
///
/// Path traversal (`..`) is allowed: the user is explicitly choosing
/// which binary to run, and with a fixed arg array traversal grants no
/// capability beyond naming any file the user could already name.
fn is_safe_utility_path(tok: &str) -> bool {
    if !tok.contains('/') {
        return false;
    }
    match tok.chars().next() {
        Some('/') | Some('.') => {}
        _ => return false,
    }
    tok.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '+' | '-' | '/'))
}

/// Return the first executable line of `script` (trimmed), skipping
/// blank lines and `#`-prefixed comments/shebangs. `None` when the
/// script has no such line.
fn first_executable_line(script: &str) -> Option<&str> {
    for raw_line in script.split('\n') {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        // `#!` shebang and `#` comments are both skipped — a shebang is
        // a comment to the shell, so collapsing them is correct.
        if line.starts_with('#') {
            continue;
        }
        return Some(line);
    }
    None
}

/// Return the substring of `line` up to (but not including) the first
/// shell command separator (`&&`, `||`, `;`, `|`, `&`). When the line
/// has no separator the whole line is returned. The result is trimmed.
///
/// This is a deliberately shallow scan — it does NOT understand quoting
/// or escaping, so a separator inside a quoted argument (e.g.
/// `echo "a;b"`) would be treated as a real separator. That is
/// acceptable here: the leading token in such a case is `echo`, which is
/// found before the separator is ever reached, and the feature only
/// needs the leading utility name, never a faithful command parse.
fn first_command_segment(line: &str) -> &str {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // A separator at position `i` ends the first command. Longest-
        // first ordering in COMMAND_SEPARATORS lets `&&`/`||` win over
        // `&`/`|`. `i` is always a char boundary (we step by whole UTF-8
        // chars below), so slicing `line[..i]` is safe.
        let at_separator = COMMAND_SEPARATORS
            .iter()
            .any(|sep| line[i..].starts_with(sep));
        if at_separator {
            return line[..i].trim();
        }
        // Advance one full UTF-8 char so multi-byte content (e.g. a
        // non-ASCII argument) can never desync the byte index.
        i += utf8_char_len(bytes[i]);
    }
    line.trim()
}

/// Length in bytes of the UTF-8 sequence whose leading byte is `b`.
/// Falls back to 1 for a stray continuation/invalid byte so the scanner
/// always makes forward progress.
fn utf8_char_len(b: u8) -> usize {
    match b {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF7 => 4,
        _ => 1,
    }
}

/// Advance `tokens` past any leading `NAME=value` environment-assignment
/// tokens. A token counts as an assignment when it contains `=` before
/// any whitespace and the part before `=` is a valid identifier. This is
/// the same shell convention the executor relies on.
fn skip_env_assignments<'a, I>(tokens: &mut std::iter::Peekable<I>)
where
    I: Iterator<Item = &'a str>,
{
    while let Some(tok) = tokens.peek() {
        if is_env_assignment(tok) {
            tokens.next();
        } else {
            break;
        }
    }
}

/// `true` when `tok` looks like `NAME=value` with a valid `NAME`.
fn is_env_assignment(tok: &str) -> bool {
    let Some((name, _value)) = tok.split_once('=') else {
        return false;
    };
    if name.is_empty() {
        return false;
    }
    let mut chars = name.chars();
    // First char must be a letter or underscore; the rest alphanumeric
    // or underscore — the POSIX environment-variable name grammar.
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// THE security boundary. Returns `true` only for a bare utility name
/// safe to hand to [`tokio::process::Command::new`].
///
/// Allows ONLY `[A-Za-z0-9_.+-]`, requires a non-empty name that STARTS
/// with an alphanumeric (so a leading `-` can't be parsed as a flag and
/// `--help` can't be shadowed). Rejects path separators (`/`), parent
/// refs (`..`), `~`, `$`, whitespace, quotes, backticks and every other
/// shell metacharacter implicitly (they are simply not in the allow-list).
fn is_safe_utility_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '+' | '-'))
}

/// Truncate `text` to at most [`MAX_HELP_BYTES`] bytes on a UTF-8 char
/// boundary. Returns the (possibly shortened) string and whether it was
/// clipped.
fn truncate_text(text: String) -> (String, bool) {
    if text.len() <= MAX_HELP_BYTES {
        return (text, false);
    }
    // Walk back to the nearest char boundary at or below the cap so we
    // never split a multi-byte sequence.
    let mut end = MAX_HELP_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

/// Fetch help text for `utility`. See the module docs for the security
/// model. Returns `Ok(NotFound)` for an unknown/absent utility (a normal
/// outcome); `Err` is reserved for genuine internal failures (none are
/// currently produced, but the signature leaves room).
pub async fn fetch_help(utility: String) -> Result<UtilityHelp, String> {
    // Defence in depth: the JS side also validates, but a rejected token
    // is a normal "not found" — never spawn anything for it.
    if !is_safe_utility_token(&utility) {
        return Ok(UtilityHelp::not_found(utility));
    }

    // Probe order: long help, short help, then man (Unix). The first
    // probe that runs and produces output wins.
    if let Some(text) = run_probe(&utility, &["--help"]).await {
        return Ok(found(utility, HelpSource::Help, text));
    }
    if let Some(text) = run_probe(&utility, &["-h"]).await {
        return Ok(found(utility, HelpSource::ShortHelp, text));
    }
    #[cfg(unix)]
    {
        // `man` looks up a manual entry by NAME, not by filesystem path,
        // so it is meaningless for a path token (`man /opt/.../tool` has
        // no entry). Only probe it for bare names.
        if !is_safe_utility_path(&utility) {
            // `--` terminates option parsing so the (already validated)
            // name can never be treated as a `man` flag. `-P cat` forces
            // plain, non-paged output.
            if let Some(text) = run_man(&utility).await {
                return Ok(found(utility, HelpSource::Man, text));
            }
        }
    }

    Ok(UtilityHelp::not_found(utility))
}

/// Build a `Found` result, truncating the text to the byte cap.
fn found(utility: String, source: HelpSource, text: String) -> UtilityHelp {
    let (text, truncated) = truncate_text(text);
    UtilityHelp {
        utility,
        status: UtilityHelpStatus::Found,
        source: Some(source),
        text: Some(text),
        truncated,
    }
}

/// Spawn `<utility> <args...>` directly (no shell) with stdin closed and
/// stdout/stderr captured, bounded by [`PROBE_TIMEOUT`]. Returns the
/// captured text when the probe ran and produced output (stdout
/// preferred, stderr as fallback), or `None` on spawn failure, timeout,
/// or empty output.
async fn run_probe(utility: &str, args: &[&str]) -> Option<String> {
    let mut command = Command::new(utility);
    command
        .args(args)
        // Force ASCII/English help text so the parser's "usage:" and flag
        // detection works regardless of the user's system locale.
        .env("LANG", "C")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // `--help` / `-h`: many well-behaved tools print help to stderr and/or
    // exit non-zero (e.g. they treat `--help` as "unrecognised, here's
    // usage"). So we accept a stderr fallback and do not gate on exit code.
    run_captured(command, StderrPolicy::Fallback).await
}

/// Run `man -P cat -- <utility>` for the rendered man page in plain text.
#[cfg(unix)]
async fn run_man(utility: &str) -> Option<String> {
    let mut command = Command::new("man");
    command
        .args(["-P", "cat", "--", utility])
        .env("LANG", "C")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // `man` writes the page to stdout and exits 0 on success; when there
    // is no manual entry it exits non-zero with a short diagnostic on
    // stderr ("No manual entry for foo"). Treating that stderr as help
    // would surface an error message as if it were documentation, so the
    // man probe requires a SUCCESSFUL exit and uses stdout only.
    run_captured(command, StderrPolicy::Reject).await
}

/// How a probe treats a command that produced no usable stdout.
#[derive(Clone, Copy)]
enum StderrPolicy {
    /// Fall back to non-empty stderr as the help text (for `--help`/`-h`).
    Fallback,
    /// Ignore stderr entirely and require a successful exit (for `man`).
    ///
    /// `allow(dead_code)` off Unix: only the `#[cfg(unix)]` `man` probe
    /// constructs this; the `--help` probe (all platforms) uses `Fallback`.
    #[cfg_attr(not(unix), allow(dead_code))]
    Reject,
}

/// Drive a prepared command to completion within the timeout, returning
/// its captured help text when the probe genuinely produced help. Never
/// panics; all failure modes (spawn error, timeout, empty output, or a
/// rejected exit) collapse to `None`.
///
/// Success rules:
///   - Non-empty stdout always wins (it is the documentation channel).
///   - With [`StderrPolicy::Fallback`], non-empty stderr is accepted when
///     stdout is empty — covers tools that print usage to stderr.
///   - With [`StderrPolicy::Reject`], stderr is ignored and a non-zero
///     exit yields `None` so a "no manual entry" diagnostic is not
///     mistaken for help.
async fn run_captured(mut command: Command, stderr_policy: StderrPolicy) -> Option<String> {
    // Windows: the help probe (`<utility> --help`) must not flash a console
    // window. No-op elsewhere. See `core::proc_ext`.
    command.no_console_window();
    let output = match tokio::time::timeout(PROBE_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(_spawn_err)) => {
            // Binary not on PATH / not executable — a normal "absent"
            // outcome. Do not log the error: it is expected and would be
            // noisy for every unknown token the user types.
            return None;
        }
        Err(_elapsed) => {
            // Timed out. Log without any user content so a pathological
            // tool is diagnosable without leaking the probed name's help.
            tracing::warn!("utility_help: help probe timed out after {PROBE_TIMEOUT:?}");
            return None;
        }
    };

    match stderr_policy {
        StderrPolicy::Reject => {
            // stdout is the documentation channel and a clean exit is
            // required: a non-zero exit means "no manual entry" (or some
            // other failure) whose stderr we must not surface as help.
            if !output.status.success() {
                return None;
            }
            let stdout = String::from_utf8_lossy(&output.stdout);
            if !stdout.trim().is_empty() {
                Some(stdout.into_owned())
            } else {
                None
            }
        }
        StderrPolicy::Fallback => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if !stdout.trim().is_empty() {
                return Some(stdout.into_owned());
            }
            // No stdout: a tool that printed usage to stderr (and possibly
            // exited non-zero) still counts as help — BUT some programs
            // don't understand `--help`/`-h` and instead print a short
            // error diagnostic to stderr (e.g. POSIX `sh --help` →
            // "sh: 0: Illegal option --"). Surfacing that as the tooltip
            // is wrong: it looks like an internal failure to the user.
            // Only accept stderr that actually looks like usage/help.
            let stderr = String::from_utf8_lossy(&output.stderr);
            if looks_like_help(&stderr) {
                Some(stderr.into_owned())
            } else {
                None
            }
        }
    }
}

/// Decide whether captured stderr is genuine usage/help text rather than
/// a short "I don't understand that flag" error diagnostic.
///
/// Why this is needed: with [`StderrPolicy::Fallback`] we accept stderr as
/// help for the many well-behaved tools that print usage there. But some
/// programs — notably POSIX shells (`sh`, `dash`) and a few coreutils —
/// don't recognise `--help`/`-h` and instead emit a one-line error such
/// as `sh: 0: Illegal option --` or `dash: --: invalid option`. Showing
/// that as the hover tooltip looks like an internal failure.
///
/// Heuristic (conservative — only rejects clear error shapes):
///   1. Reject when the text contains a known "bad option" phrase
///      (illegal/invalid/unrecognized/unknown option).
///   2. Reject a SHORT, SINGLE-LINE message — real help is multi-line or
///      at least substantial; a lone short line is almost always an error.
///   3. Otherwise accept (multi-line usage, "Usage:" blocks, etc.).
fn looks_like_help(stderr: &str) -> bool {
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        return false;
    }

    // (1) Known "unrecognised option" diagnostics. Lower-cased substring
    // match so casing/prefix variations ("Illegal option", "invalid
    // option", "unrecognized option") are all caught.
    let lower = trimmed.to_lowercase();
    const BAD_OPTION_PHRASES: &[&str] = &[
        "illegal option",
        "invalid option",
        "unrecognized option",
        "unrecognised option",
        "unknown option",
        "bad option",
        "not an option",
    ];
    if BAD_OPTION_PHRASES.iter().any(|p| lower.contains(p)) {
        return false;
    }

    // (2) A single short line is almost certainly an error, not help.
    // Genuine usage output is multi-line or at least reasonably long
    // (e.g. a one-line "Usage: foo [opts] <arg>" still clears this bar
    // only if it is long enough or contains a usage keyword — see below).
    let line_count = trimmed.lines().filter(|l| !l.trim().is_empty()).count();
    let has_usage_keyword = lower.contains("usage") || lower.contains("options:");
    if line_count <= 1 && trimmed.len() < 60 && !has_usage_keyword {
        return false;
    }

    // (3) Looks like real help/usage.
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_plain_utility_with_flags() {
        assert_eq!(parse_utility_name("df -h /"), Some("df".to_string()));
    }

    // detect_admin_escalation mirrors `detectAdminEscalation.ts`; these
    // cases mirror that module's documented examples so the two can never
    // drift. This is the guard for "scheduled/workflow `sudo …` run fails
    // with 'a terminal is required to read the password'".
    #[test]
    fn detect_escalation_flags_leading_tool() {
        assert!(detect_admin_escalation("sudo apt update"));
        assert!(detect_admin_escalation("doas pkg upgrade"));
        assert!(detect_admin_escalation("pkexec id"));
        // The reported failing command — a leading `sudo sh -c '…'`.
        assert!(detect_admin_escalation(
            "sudo sh -c 'find / -xdev -type f | xargs ls -lh'"
        ));
    }

    #[test]
    fn detect_escalation_strips_env_and_skips_comments() {
        assert!(detect_admin_escalation("FOO=1 sudo apt update"));
        assert!(detect_admin_escalation(
            "#!/usr/bin/env bash\n# comment\nsudo systemctl restart x"
        ));
    }

    #[test]
    fn detect_escalation_ignores_non_leading_escalation() {
        // First command is `echo` / `cd` — the user deliberately kept the
        // leading command unprivileged, so we must NOT auto-elevate.
        assert!(!detect_admin_escalation("echo y | sudo apt remove foo"));
        assert!(!detect_admin_escalation("cd /tmp && sudo apt update"));
        // No escalation at all.
        assert!(!detect_admin_escalation("ls -la"));
        assert!(!detect_admin_escalation(""));
    }

    #[test]
    fn parse_strips_escalation_prefix() {
        assert_eq!(
            parse_utility_name("sudo apt update"),
            Some("apt".to_string())
        );
        assert_eq!(
            parse_utility_name("doas pkg upgrade"),
            Some("pkg".to_string())
        );
        assert_eq!(parse_utility_name("pkexec id"), Some("id".to_string()));
    }

    #[test]
    fn parse_strips_env_assignments() {
        assert_eq!(parse_utility_name("FOO=1 ls"), Some("ls".to_string()));
        assert_eq!(
            parse_utility_name("FOO=1 BAR=2 grep x"),
            Some("grep".to_string())
        );
    }

    #[test]
    fn parse_strips_env_then_escalation() {
        // POSIX allows env assignments before AND after the program word;
        // the escalation tool is the program here, so envs after it apply
        // to the escalated child — we still resolve to the real utility.
        assert_eq!(
            parse_utility_name("FOO=1 sudo BAR=2 systemctl restart x"),
            Some("systemctl".to_string())
        );
    }

    #[test]
    fn parse_skips_blank_and_comment_lines() {
        assert_eq!(
            parse_utility_name("  \n# a comment\nls -la"),
            Some("ls".to_string())
        );
        assert_eq!(
            parse_utility_name("#!/usr/bin/env bash\ndf"),
            Some("df".to_string())
        );
    }

    #[test]
    fn takes_only_first_command_in_chain() {
        // Separators terminate the inspected segment; only the leading
        // utility is returned regardless of what follows.
        assert_eq!(
            parse_utility_name("df -h && du -sh *"),
            Some("df".to_string()),
        );
        assert_eq!(
            parse_utility_name("git status | grep foo"),
            Some("git".to_string()),
        );
        assert_eq!(
            parse_utility_name("ls || echo fail"),
            Some("ls".to_string())
        );
        assert_eq!(parse_utility_name("ls & disown"), Some("ls".to_string()));
    }

    #[test]
    fn separator_is_whitespace_insensitive() {
        // The whole point of `first_command_segment`: a separator with
        // or without surrounding spaces yields the same utility, where
        // previously `ls;rm` (no space) produced an unsafe `ls;` token.
        assert_eq!(parse_utility_name("ls;rm"), Some("ls".to_string()));
        assert_eq!(parse_utility_name("ls ; rm"), Some("ls".to_string()));
        assert_eq!(parse_utility_name("ls&&rm"), Some("ls".to_string()));
        assert_eq!(parse_utility_name("ls && rm"), Some("ls".to_string()));
        assert_eq!(parse_utility_name("cat|less"), Some("cat".to_string()));
    }

    #[test]
    fn separator_combined_with_prefixes() {
        // Env-assignment + escalation + separator all interact correctly:
        // the segment is cut first, then prefixes are stripped.
        assert_eq!(
            parse_utility_name("sudo apt update && reboot"),
            Some("apt".to_string()),
        );
        assert_eq!(
            parse_utility_name("FOO=1 ls; rm -rf x"),
            Some("ls".to_string()),
        );
    }

    #[test]
    fn leading_separator_yields_none() {
        // A line that begins with a separator has an empty first segment
        // → no candidate token → None (not a panic).
        assert_eq!(parse_utility_name("&& ls"), None);
        assert_eq!(parse_utility_name("| grep x"), None);
    }

    #[test]
    fn parse_rejects_variable_reference() {
        assert_eq!(parse_utility_name("${tool} --version"), None);
        assert_eq!(parse_utility_name("$TOOL run"), None);
    }

    #[test]
    fn parse_empty_is_none() {
        assert_eq!(parse_utility_name(""), None);
        assert_eq!(parse_utility_name("   \n\n  "), None);
        assert_eq!(parse_utility_name("# only a comment"), None);
    }

    #[test]
    fn parse_accepts_safe_paths() {
        // Absolute and relative executable paths are now valid leading
        // utilities (spawned directly, never via a shell).
        assert_eq!(
            parse_utility_name("/usr/bin/df -h"),
            Some("/usr/bin/df".to_string())
        );
        assert_eq!(
            parse_utility_name("/opt/cprocsp/sbin/amd64/cpconfig -license -view"),
            Some("/opt/cprocsp/sbin/amd64/cpconfig".to_string())
        );
        assert_eq!(
            parse_utility_name("./script.sh"),
            Some("./script.sh".to_string())
        );
        assert_eq!(
            parse_utility_name("sudo /usr/local/bin/tool run"),
            Some("/usr/local/bin/tool".to_string())
        );
    }

    #[test]
    fn parse_rejects_metachars() {
        assert_eq!(parse_utility_name("$(whoami)"), None);
        // A path carrying a shell metacharacter is rejected.
        assert_eq!(parse_utility_name("/usr/bin/$x"), None);
        assert_eq!(parse_utility_name("~/bin/tool"), None);
        // NOTE: `rm;rm` resolves to `rm` — the segment is cut at the `;`
        // separator (see `separator_is_whitespace_insensitive`).
    }

    #[test]
    fn safe_path_accepts_executable_paths() {
        for p in [
            "/usr/bin/df",
            "/opt/cprocsp/sbin/amd64/cpconfig",
            "./script.sh",
            "../bin/tool",
            "/a/b-c/d_e.f+g",
        ] {
            assert!(is_safe_utility_path(p), "expected `{p}` to be a safe path");
        }
    }

    #[test]
    fn safe_path_rejects_non_paths_and_metachars() {
        for p in [
            // No slash → not a path (handled by is_safe_utility_name).
            "df",
            "apt-get",
            // Must start with `/` or `.`.
            "usr/bin/df",
            "-/x",
            // Shell metacharacters / disallowed chars.
            "~/bin/tool",
            "/usr/bin/$x",
            "/a/b c",
            "/a/b;c",
            "/a/b|c",
            "/a/*",
            "/a/`x`",
        ] {
            assert!(
                !is_safe_utility_path(p),
                "expected `{p}` to be rejected as a path"
            );
        }
    }

    #[test]
    fn safe_name_accepts_typical_utilities() {
        for name in [
            "df", "ls", "git", "docker", "apt-get", "g++", "python3", "a.out", "7z",
        ] {
            assert!(is_safe_utility_name(name), "expected `{name}` to be safe");
        }
    }

    #[test]
    fn safe_name_rejects_dangerous_inputs() {
        for name in [
            "", "-h", "--help", "rm;rm", "foo/bar", "..", "$(x)", "a b", "a|b", "a&b", "`x`",
            "'q'", "\"q\"", "~/x", "a>b", "$VAR",
        ] {
            assert!(
                !is_safe_utility_name(name),
                "expected `{name}` to be rejected"
            );
        }
    }

    #[test]
    fn safe_name_requires_alphanumeric_start() {
        // A name must start with an alphanumeric so it can never be
        // parsed as a flag by the spawned binary. Leading `-`/`.`/`+`/`_`
        // are all rejected even though those chars are allowed mid-name.
        assert!(!is_safe_utility_name("-x"));
        assert!(!is_safe_utility_name(".x"));
        assert!(!is_safe_utility_name("+x"));
        assert!(!is_safe_utility_name("_x"));
        // Mid-name underscore is fine.
        assert!(is_safe_utility_name("a_x"));
    }

    #[test]
    fn truncate_respects_byte_cap_and_char_boundary() {
        // ASCII below the cap is untouched.
        let small = "hello".to_string();
        let (out, truncated) = truncate_text(small.clone());
        assert_eq!(out, small);
        assert!(!truncated);

        // A long string of multi-byte chars is clipped on a boundary.
        let big = "é".repeat(MAX_HELP_BYTES); // each 'é' is 2 bytes
        assert!(big.len() > MAX_HELP_BYTES);
        let (out, truncated) = truncate_text(big);
        assert!(truncated);
        assert!(out.len() <= MAX_HELP_BYTES);
        // Still valid UTF-8 (no split char): re-parsing the bytes succeeds.
        assert!(std::str::from_utf8(out.as_bytes()).is_ok());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fetch_help_finds_present_binary() {
        // `ls` is present on every Unix dev host. Either `--help`, `-h`
        // or `man` should yield text; we only assert "found".
        let help = fetch_help("ls".to_string())
            .await
            .expect("no internal error");
        assert_eq!(help.status, UtilityHelpStatus::Found, "ls help: {help:?}");
        assert!(help.source.is_some());
        assert!(help.text.is_some());
        assert!(!help.text.unwrap().trim().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fetch_help_absent_binary_is_not_found() {
        let help = fetch_help("procmix_no_such_bin_xyz".to_string())
            .await
            .expect("no internal error");
        assert_eq!(help.status, UtilityHelpStatus::NotFound);
        assert!(help.source.is_none());
        assert!(help.text.is_none());
        assert!(!help.truncated);
    }

    #[tokio::test]
    async fn fetch_help_unsafe_name_is_not_found_without_spawning() {
        // An unsafe name must never spawn anything; it collapses to
        // NotFound. (`;` could not pass JS validation but we defend here.)
        let help = fetch_help("rm;rm".to_string())
            .await
            .expect("no internal error");
        assert_eq!(help.status, UtilityHelpStatus::NotFound);
    }

    #[test]
    fn looks_like_help_rejects_illegal_option_diagnostics() {
        // The exact symptom the user reported: POSIX `sh --help`.
        assert!(!looks_like_help("sh: 0: Illegal option --"));
        // Other shells / coreutils phrasings.
        assert!(!looks_like_help("dash: --: invalid option"));
        assert!(!looks_like_help("foo: unrecognized option '--help'"));
        assert!(!looks_like_help("bar: unknown option -- h"));
    }

    #[test]
    fn looks_like_help_rejects_short_single_line_errors() {
        // A lone short line with no usage keyword is treated as an error.
        assert!(!looks_like_help("sh: bad flag"));
        assert!(!looks_like_help("try 'foo --help'"));
        // Blank / whitespace is never help.
        assert!(!looks_like_help("   \n  "));
        assert!(!looks_like_help(""));
    }

    #[test]
    fn looks_like_help_accepts_real_usage() {
        // Multi-line usage is accepted.
        let usage = "Usage: foo [OPTIONS] <FILE>\n  -h  show help\n  -v  verbose";
        assert!(looks_like_help(usage));
        // A single line is accepted when it carries a usage keyword.
        assert!(looks_like_help("Usage: foo [opts] <arg>"));
        // A substantial single line (>= 60 chars) is accepted even without
        // a keyword — real one-line summaries do occur.
        let long = "foo runs the thing with the other thing and prints lots here";
        assert!(long.len() >= 60);
        assert!(looks_like_help(long));
    }
}
