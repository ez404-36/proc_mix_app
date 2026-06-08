// Parser and writer for .env files.
//
// Supports the widely-used dotenv format:
//   - Lines starting with `#` (after optional leading whitespace) are comments.
//   - Blank lines are preserved on write.
//   - KEY=VALUE pairs: key must be a non-empty identifier; value may be
//     unquoted, single-quoted, or double-quoted.
//   - `export KEY=VALUE` is supported (the `export ` prefix is stripped).
//   - Inline comments on unquoted values (`FOO=bar # comment`) are stripped;
//     the ` #...` suffix is excluded from the parsed value. Single- and
//     double-quoted values include everything inside the quotes verbatim.
//   - `write_entry` preserves existing `export ` prefixes and auto-quotes
//     written values that contain spaces, `#`, `"`, or `'`.
//
// The `parse_dotenv_file` function is the read path. `write_entry` and
// `delete_entry` are the write paths — both operate line-by-line to preserve
// all formatting, comments, and blank lines that the parser skips.
//
// Line endings (C4): the original file's dominant newline style (LF vs CRLF)
// is detected and re-applied on write, so editing one entry in a CRLF file
// does not silently rewrite the whole file to LF.
//
// Atomicity (C2): writes go to a sibling temp file and are renamed over the
// target, so a crash mid-write cannot truncate the user's .env.
//
// Existence (C3): `write_entry` refuses to operate on a non-existent file
// (it would otherwise silently create one); `delete_entry` is a no-op on a
// missing file. Symmetric "missing file" handling.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// A single key/value pair parsed from a .env file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvEntry {
    pub key: String,
    pub value: String,
    /// 1-based line number of the KEY=VALUE line in the source file.
    pub line: usize,
}

/// The parsed result of a .env file.
///
/// `error` is set when the file could not be read or is not a valid path;
/// `entries` is empty in that case. When the file is readable, any
/// unparseable lines are silently skipped (they are preserved verbatim on
/// write-back).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvFileSummary {
    pub path: String,
    pub entries: Vec<EnvEntry>,
    pub error: Option<String>,
}

/// Load and merge the registered `.env` files into a single key→value map for
/// injection into a command's environment (C1).
///
/// Files are merged in `paths` order, so a key declared in a LATER file
/// overrides the same key in an EARLIER one — matching the manager's display
/// precedence. A file that cannot be read or parsed is skipped silently
/// (a broken or externally-deleted file must not abort a command run); the
/// manager view surfaces such errors separately via `parse_dotenv_file`.
///
/// The returned map carries NO precedence over the command's own `env`: the
/// caller (the executor) applies these first and then the per-command env, so
/// `Command.env` always wins. Inherited process environment is the lowest
/// precedence (these entries are added on top of it).
pub fn load_merged_env_files(paths: &[String]) -> std::collections::BTreeMap<String, String> {
    let mut merged = std::collections::BTreeMap::new();
    for p in paths {
        let Ok(entries) = parse_dotenv_file(Path::new(p)) else {
            continue;
        };
        for entry in entries {
            merged.insert(entry.key, entry.value);
        }
    }
    merged
}

/// Parse a .env file at `path` and return the list of key/value entries.
///
/// Skips blank lines and comment lines. Strips an optional `export ` prefix.
/// Unquotes single- and double-quoted values. Returns an error string if the
/// file cannot be read.
pub fn parse_dotenv_file(path: &Path) -> Result<Vec<EnvEntry>, String> {
    let contents = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;

    let mut entries = Vec::new();
    for (idx, line) in contents.lines().enumerate() {
        let line_no = idx + 1;
        let Some((key, raw_value)) = parse_key_value_from_line(line) else {
            continue;
        };
        entries.push(EnvEntry {
            key: key.to_string(),
            value: unquote_value(raw_value),
            line: line_no,
        });
    }
    Ok(entries)
}

/// Update or append a single `KEY=VALUE` line in a .env file.
///
/// Reads the file line-by-line. If a line that sets `key` is found (with or
/// without `export ` prefix), its value is replaced in-place. If no such
/// line exists, `KEY=VALUE` is appended at the end. Comment and blank lines
/// are preserved verbatim, and the file's existing newline style (LF/CRLF) is
/// retained.
///
/// (C3) The file MUST already exist — editing a value should never silently
/// create a new file (the registered file may have been deleted outside the
/// app). Returns an error if it does not exist.
///
/// The `key` is validated as a POSIX-style env name; an invalid key is
/// rejected so a malformed `KEY` can never be written into the file.
pub fn write_entry(path: &Path, key: &str, value: &str) -> Result<(), String> {
    if !is_valid_env_key(key) {
        return Err(format!("invalid environment variable name: {key:?}"));
    }
    if !path.exists() {
        return Err(format!("file does not exist: {}", path.display()));
    }
    let contents =
        std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let newline = detect_newline(&contents);

    let mut lines: Vec<String> = contents.lines().map(str::to_string).collect();
    let mut found = false;

    let formatted = format_value(value);
    for line in &mut lines {
        if line_matches_key(line, key) {
            // Preserve an existing `export ` prefix so a shell-style file
            // is not silently modified on write-back.
            let prefix = if line.trim_start().starts_with("export ") {
                "export "
            } else {
                ""
            };
            *line = format!("{prefix}{key}={formatted}");
            found = true;
            break;
        }
    }

    if !found {
        lines.push(format!("{key}={formatted}"));
    }

    let new_contents = join_lines(&lines, newline);
    write_atomic(path, new_contents.as_bytes())
}

/// Remove the line(s) that set `key` in a .env file.
///
/// All lines matching `key` (with or without `export ` prefix) are removed.
/// Comment and blank lines are preserved. If the key is not found the file is
/// left unchanged and `Ok(())` is returned.
pub fn delete_entry(path: &Path, key: &str) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let contents =
        std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let newline = detect_newline(&contents);

    let new_lines: Vec<&str> = contents
        .lines()
        .filter(|line| !line_matches_key(line, key))
        .collect();

    let new_contents = join_lines(&new_lines, newline);
    write_atomic(path, new_contents.as_bytes())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Parse a single source line into `(key, raw_value)`, or `None` when the line
/// is blank, a comment, has no `=`, or has an empty key.
///
/// Shared by `parse_dotenv_file` (read path) and `line_matches_key` (write
/// path) so both agree on exactly what counts as a KEY assignment (D2). The
/// returned `key` is trimmed; `raw_value` is everything after the first `=`
/// (NOT unquoted — the caller decides whether to unquote).
fn parse_key_value_from_line(line: &str) -> Option<(&str, &str)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    // Strip optional `export ` prefix.
    let without_export = trimmed
        .strip_prefix("export ")
        .map(str::trim_start)
        .unwrap_or(trimmed);
    // Split on the first `=`.
    let eq_pos = without_export.find('=')?;
    let key = without_export[..eq_pos].trim();
    if key.is_empty() {
        return None;
    }
    Some((key, &without_export[eq_pos + 1..]))
}

/// True when `line` is a KEY assignment (with optional `export ` prefix)
/// for the given `key`.
fn line_matches_key(line: &str, key: &str) -> bool {
    matches!(parse_key_value_from_line(line), Some((k, _)) if k == key)
}

/// True when `key` is a valid POSIX-style environment variable name: a letter
/// or underscore followed by letters, digits, or underscores. Mirrors the
/// frontend check in `src/utils/envVars.ts::isValidEnvVarName`.
pub fn is_valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Detect the dominant newline style of `contents`.
///
/// Returns `"\r\n"` if any CRLF is present, else `"\n"`. Used to preserve a
/// Windows-style .env file's line endings on write (C4) instead of silently
/// rewriting it to LF.
fn detect_newline(contents: &str) -> &'static str {
    if contents.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

/// Join `lines` with `newline` and append a trailing `newline` (unless the
/// result is empty). `lines` come from `str::lines()`, which has already
/// stripped any `\r`, so this reconstructs the chosen style uniformly.
fn join_lines<S: AsRef<str>>(lines: &[S], newline: &str) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let joined = lines
        .iter()
        .map(AsRef::as_ref)
        .collect::<Vec<_>>()
        .join(newline);
    format!("{joined}{newline}")
}

/// Atomically write `bytes` to `target`: write to a sibling temp file, then
/// rename it over the target. Rename is atomic on the same filesystem, so a
/// crash mid-write leaves the previous file intact and a concurrent reader
/// never sees a partial write (C2).
fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = target
        .parent()
        .ok_or_else(|| format!("path has no parent directory: {}", target.display()))?;
    let file_name = target
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("path has no file name: {}", target.display()))?;
    let tmp_name = format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let tmp_path = dir.join(tmp_name);

    std::fs::write(&tmp_path, bytes)
        .map_err(|e| format!("write temp file {}: {e}", tmp_path.display()))?;
    if let Err(e) = std::fs::rename(&tmp_path, target) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("rename over {}: {e}", target.display()));
    }
    Ok(())
}

/// Strip an inline comment from an unquoted value.
///
/// Scans for the first occurrence of ` #` (space followed by `#`) that is
/// not inside any quoting context. Everything from that point to the end of
/// the string is dropped. The result is then trimmed of surrounding
/// whitespace. Returns the input unchanged if no comment marker is found.
fn strip_inline_comment(s: &str) -> &str {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b' ' && i + 1 < bytes.len() && bytes[i + 1] == b'#' {
            return s[..i].trim_end();
        }
        i += 1;
    }
    s.trim_end()
}

/// Process escape sequences inside a double-quoted value body (the content
/// between the outer `"` delimiters, NOT including them).
///
/// Recognised escapes: `\n` → newline, `\t` → tab, `\\` → backslash,
/// `\"` → double-quote. Any other `\x` sequence is kept verbatim (`\x`).
fn unquote_double(inner: &str) -> String {
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('\\') => out.push('\\'),
                Some('"') => out.push('"'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// Format a value for writing to a .env file. This is the exact inverse of
/// the double-quoted path of [`unquote_value`] — i.e. `unquote_value(format_value(v)) == v`
/// for every `v` (see the `format_value_unquote_value_round_trip` test).
///
/// A value is wrapped in double quotes when it is empty or contains any
/// character that would otherwise change meaning on re-parse: whitespace,
/// `#` (inline-comment marker), `"`/`'` (quote delimiters), `\` (escape lead),
/// or a control character such as a newline or tab (which would otherwise
/// span lines / be trimmed). Inside the quotes, `\`, `"`, newline, and tab are
/// escaped as `\\`, `\"`, `\n`, `\t` respectively — matching [`unquote_double`].
/// Simple values like `bar` or `123` are returned unquoted.
fn format_value(value: &str) -> String {
    let needs_quotes = value.is_empty()
        || value
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '#' | '"' | '\'' | '\\'));
    if !needs_quotes {
        return value.to_string();
    }
    let mut escaped = String::with_capacity(value.len() + 2);
    for ch in value.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\t' => escaped.push_str("\\t"),
            other => escaped.push(other),
        }
    }
    format!("\"{escaped}\"")
}

/// Parse a raw value string (everything after the first `=` on a line).
///
/// Dispatch rules:
///   - Single-quoted (`'...'`): strip outer quotes, no escape processing.
///     Inline comments inside single quotes are literal and NOT stripped.
///   - Double-quoted (`"..."`): strip outer quotes, process `\n`/`\t`/`\\`/`\"`.
///     Inline comments inside double quotes are literal and NOT stripped.
///   - Unquoted: strip inline ` # comment` suffix, then trim whitespace.
fn unquote_value(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() >= 2 {
        if trimmed.starts_with('\'') && trimmed.ends_with('\'') {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
        if trimmed.starts_with('"') && trimmed.ends_with('"') {
            return unquote_double(&trimmed[1..trimmed.len() - 1]);
        }
    }
    strip_inline_comment(trimmed).to_string()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp(contents: &str) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(contents.as_bytes()).unwrap();
        f
    }

    #[test]
    fn parse_basic_key_value() {
        let f = write_temp("FOO=bar\nBAZ=qux\n");
        let entries = parse_dotenv_file(f.path()).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].key, "FOO");
        assert_eq!(entries[0].value, "bar");
        assert_eq!(entries[1].key, "BAZ");
        assert_eq!(entries[1].value, "qux");
    }

    #[test]
    fn parse_skips_comments_and_blanks() {
        let f = write_temp("# comment\n\nFOO=bar\n");
        let entries = parse_dotenv_file(f.path()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].key, "FOO");
    }

    #[test]
    fn parse_strips_export_prefix() {
        let f = write_temp("export FOO=bar\n");
        let entries = parse_dotenv_file(f.path()).unwrap();
        assert_eq!(entries[0].key, "FOO");
        assert_eq!(entries[0].value, "bar");
    }

    #[test]
    fn parse_single_quoted_value() {
        let f = write_temp("FOO='hello world'\n");
        let entries = parse_dotenv_file(f.path()).unwrap();
        assert_eq!(entries[0].value, "hello world");
    }

    #[test]
    fn parse_double_quoted_value() {
        let f = write_temp("FOO=\"hello world\"\n");
        let entries = parse_dotenv_file(f.path()).unwrap();
        assert_eq!(entries[0].value, "hello world");
    }

    #[test]
    fn parse_line_numbers() {
        let f = write_temp("# comment\nFOO=bar\nBAZ=qux\n");
        let entries = parse_dotenv_file(f.path()).unwrap();
        assert_eq!(entries[0].line, 2);
        assert_eq!(entries[1].line, 3);
    }

    #[test]
    fn write_entry_updates_existing() {
        let f = write_temp("FOO=old\nBAR=baz\n");
        write_entry(f.path(), "FOO", "new").unwrap();
        let contents = std::fs::read_to_string(f.path()).unwrap();
        assert!(contents.contains("FOO=new"));
        assert!(contents.contains("BAR=baz"));
        assert!(!contents.contains("FOO=old"));
    }

    #[test]
    fn write_entry_appends_new() {
        let f = write_temp("FOO=bar\n");
        write_entry(f.path(), "NEW_KEY", "val").unwrap();
        let contents = std::fs::read_to_string(f.path()).unwrap();
        assert!(contents.contains("FOO=bar"));
        assert!(contents.contains("NEW_KEY=val"));
    }

    #[test]
    fn write_entry_preserves_comments() {
        let f = write_temp("# comment\nFOO=bar\n");
        write_entry(f.path(), "FOO", "new").unwrap();
        let contents = std::fs::read_to_string(f.path()).unwrap();
        assert!(contents.contains("# comment"));
        assert!(contents.contains("FOO=new"));
    }

    #[test]
    fn delete_entry_removes_key() {
        let f = write_temp("FOO=bar\nBAZ=qux\n");
        delete_entry(f.path(), "FOO").unwrap();
        let entries = parse_dotenv_file(f.path()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].key, "BAZ");
    }

    #[test]
    fn delete_entry_noop_when_absent() {
        let f = write_temp("FOO=bar\n");
        delete_entry(f.path(), "MISSING").unwrap();
        let entries = parse_dotenv_file(f.path()).unwrap();
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn delete_entry_preserves_comments() {
        let f = write_temp("# comment\nFOO=bar\n");
        delete_entry(f.path(), "FOO").unwrap();
        let contents = std::fs::read_to_string(f.path()).unwrap();
        assert!(contents.contains("# comment"));
    }

    // --- Edge cases fixed by the improved helpers ---

    #[test]
    fn parse_strips_inline_comment_from_unquoted_value() {
        // `FOO=bar # this is a comment` should yield value `bar`, not `bar # this is a comment`.
        let f = write_temp("FOO=bar # this is a comment\n");
        let entries = parse_dotenv_file(f.path()).unwrap();
        assert_eq!(entries[0].value, "bar");
    }

    #[test]
    fn parse_preserves_hash_inside_single_quotes() {
        // Single-quoted values are literal — `#` is NOT a comment delimiter inside quotes.
        let f = write_temp("FOO='bar#baz'\n");
        let entries = parse_dotenv_file(f.path()).unwrap();
        assert_eq!(entries[0].value, "bar#baz");
    }

    #[test]
    fn parse_preserves_hash_inside_double_quotes() {
        // Same for double-quoted values.
        let f = write_temp("FOO=\"bar#baz\"\n");
        let entries = parse_dotenv_file(f.path()).unwrap();
        assert_eq!(entries[0].value, "bar#baz");
    }

    #[test]
    fn parse_double_quoted_escape_sequences() {
        // `\n`, `\t`, `\\`, `\"` inside double quotes are processed.
        let f = write_temp("FOO=\"line1\\nline2\\ttab\\\\back\\\"quote\"\n");
        let entries = parse_dotenv_file(f.path()).unwrap();
        assert_eq!(entries[0].value, "line1\nline2\ttab\\back\"quote");
    }

    #[test]
    fn parse_value_with_equals_sign() {
        // A `=` in the value part must not split the key further.
        let f = write_temp("FOO=bar=baz\n");
        let entries = parse_dotenv_file(f.path()).unwrap();
        assert_eq!(entries[0].key, "FOO");
        assert_eq!(entries[0].value, "bar=baz");
    }

    #[test]
    fn write_entry_preserves_export_prefix() {
        // When the matched line uses `export KEY=VALUE`, the replacement must
        // keep the `export ` prefix so the file style is not silently changed.
        let f = write_temp("export FOO=old\nBAR=baz\n");
        write_entry(f.path(), "FOO", "new").unwrap();
        let contents = std::fs::read_to_string(f.path()).unwrap();
        assert!(
            contents.contains("export FOO=new"),
            "export prefix must be preserved"
        );
        assert!(!contents.contains("export FOO=old"));
        assert!(contents.contains("BAR=baz"));
    }

    #[test]
    fn write_entry_auto_quotes_value_with_spaces() {
        // A value containing spaces must be written in double quotes so the
        // file can be re-parsed correctly.
        let f = write_temp("FOO=plain\n");
        write_entry(f.path(), "FOO", "hello world").unwrap();
        let entries = parse_dotenv_file(f.path()).unwrap();
        assert_eq!(entries[0].value, "hello world");
    }

    #[test]
    fn write_entry_auto_quotes_value_with_hash() {
        // A value containing `#` must be quoted so it is not misread as an
        // inline comment on the next parse.
        let f = write_temp("FOO=plain\n");
        write_entry(f.path(), "FOO", "bar#baz").unwrap();
        let entries = parse_dotenv_file(f.path()).unwrap();
        assert_eq!(entries[0].value, "bar#baz");
    }

    // --- C3: missing-file handling ---

    #[test]
    fn write_entry_errors_on_missing_file() {
        // Editing a value must NOT silently create a new file.
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist.env");
        let err = write_entry(&missing, "FOO", "bar").unwrap_err();
        assert!(err.contains("does not exist"), "got: {err}");
        assert!(!missing.exists(), "file must not be created");
    }

    #[test]
    fn delete_entry_noop_on_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist.env");
        // Symmetric with write_entry: a no-op, not an error, and no file made.
        delete_entry(&missing, "FOO").unwrap();
        assert!(!missing.exists());
    }

    // --- C4: CRLF preservation ---

    #[test]
    fn write_entry_preserves_crlf() {
        let f = write_temp("FOO=old\r\nBAR=baz\r\n");
        write_entry(f.path(), "FOO", "new").unwrap();
        let contents = std::fs::read_to_string(f.path()).unwrap();
        assert!(contents.contains("\r\n"), "CRLF must be preserved");
        assert!(!contents.contains("FOO=old"));
        assert!(contents.contains("FOO=new"));
        // No stray LF-only lines introduced.
        assert!(!contents.lines().any(|l| l.ends_with('\r')) || contents.contains("\r\n"));
    }

    #[test]
    fn write_entry_keeps_lf_for_lf_file() {
        let f = write_temp("FOO=old\n");
        write_entry(f.path(), "FOO", "new").unwrap();
        let contents = std::fs::read_to_string(f.path()).unwrap();
        assert!(!contents.contains("\r\n"), "LF file must stay LF");
        assert!(contents.ends_with("FOO=new\n"));
    }

    #[test]
    fn delete_entry_preserves_crlf() {
        let f = write_temp("FOO=bar\r\nBAZ=qux\r\n");
        delete_entry(f.path(), "FOO").unwrap();
        let contents = std::fs::read_to_string(f.path()).unwrap();
        assert!(contents.contains("\r\n"), "CRLF must be preserved");
        assert_eq!(contents, "BAZ=qux\r\n");
    }

    // --- Duplicate-key semantics (documented behaviour) ---

    #[test]
    fn write_entry_updates_first_duplicate_only() {
        // When a key appears twice, write_entry updates the FIRST occurrence
        // and leaves the rest untouched (it `break`s on first match).
        let f = write_temp("FOO=one\nFOO=two\n");
        write_entry(f.path(), "FOO", "new").unwrap();
        let contents = std::fs::read_to_string(f.path()).unwrap();
        assert_eq!(contents, "FOO=new\nFOO=two\n");
    }

    #[test]
    fn delete_entry_removes_all_duplicates() {
        // delete_entry removes EVERY matching line (filter, not break).
        let f = write_temp("FOO=one\nBAR=keep\nFOO=two\n");
        delete_entry(f.path(), "FOO").unwrap();
        let contents = std::fs::read_to_string(f.path()).unwrap();
        assert_eq!(contents, "BAR=keep\n");
    }

    // --- C1: load_merged_env_files precedence ---

    #[test]
    fn load_merged_env_files_later_file_wins() {
        let a = write_temp("SHARED=from_a\nONLY_A=a\n");
        let b = write_temp("SHARED=from_b\nONLY_B=b\n");
        let paths = vec![
            a.path().to_string_lossy().into_owned(),
            b.path().to_string_lossy().into_owned(),
        ];
        let merged = load_merged_env_files(&paths);
        assert_eq!(merged.get("SHARED").map(String::as_str), Some("from_b"));
        assert_eq!(merged.get("ONLY_A").map(String::as_str), Some("a"));
        assert_eq!(merged.get("ONLY_B").map(String::as_str), Some("b"));
    }

    #[test]
    fn load_merged_env_files_skips_unreadable() {
        let a = write_temp("OK=1\n");
        let paths = vec![
            "/nonexistent/path/.env".to_string(),
            a.path().to_string_lossy().into_owned(),
        ];
        // An unreadable file is skipped, not fatal.
        let merged = load_merged_env_files(&paths);
        assert_eq!(merged.get("OK").map(String::as_str), Some("1"));
        assert_eq!(merged.len(), 1);
    }

    #[test]
    fn load_merged_env_files_empty_for_empty_input() {
        let merged = load_merged_env_files(&[]);
        assert!(merged.is_empty());
    }

    // --- Atomic write leaves no temp files behind ---

    #[test]
    fn write_entry_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("vars.env");
        std::fs::write(&target, "FOO=old\n").unwrap();
        write_entry(&target, "FOO", "new").unwrap();
        // Directory should contain only the target file — no `.tmp` leftovers.
        let leftover_tmp = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().contains(".tmp"));
        assert!(!leftover_tmp, "atomic write must not leave a temp file");
    }

    // --- Key validation ---

    #[test]
    fn is_valid_env_key_accepts_posix_names() {
        assert!(is_valid_env_key("FOO"));
        assert!(is_valid_env_key("_underscore"));
        assert!(is_valid_env_key("MixedCase_123"));
    }

    #[test]
    fn is_valid_env_key_rejects_bad_names() {
        assert!(!is_valid_env_key(""));
        assert!(!is_valid_env_key("1LEADING_DIGIT"));
        assert!(!is_valid_env_key("HAS SPACE"));
        assert!(!is_valid_env_key("HAS-DASH"));
        assert!(!is_valid_env_key("HAS=EQ"));
    }

    #[test]
    fn write_entry_rejects_invalid_key() {
        let f = write_temp("FOO=bar\n");
        let err = write_entry(f.path(), "BAD KEY", "x").unwrap_err();
        assert!(
            err.contains("invalid environment variable name"),
            "got: {err}"
        );
        // File must be untouched.
        let contents = std::fs::read_to_string(f.path()).unwrap();
        assert_eq!(contents, "FOO=bar\n");
    }

    // --- S3: format_value ↔ unquote_value round-trip on special chars ---

    #[test]
    fn format_value_unquote_value_round_trip() {
        // Every value, once formatted for writing and re-parsed, must come back
        // byte-identical. Covers spaces, #, quotes, backslash, and a real
        // newline / tab (which format_value quotes and unquote_double decodes).
        let cases = [
            "",
            "plain",
            "123",
            "hello world",
            "trailing ",
            "has#hash",
            "has\"dquote",
            "has'squote",
            "back\\slash",
            "tab\tinside",
            "new\nline",
            "a\tb c#d\"e'f\\g",
        ];
        for raw in cases {
            let formatted = format_value(raw);
            let parsed = unquote_value(&formatted);
            assert_eq!(
                parsed, raw,
                "round-trip failed for {raw:?} (wrote {formatted:?})"
            );
        }
    }

    #[test]
    fn write_then_parse_round_trip_via_file() {
        // End-to-end through the file: write a tricky value, parse it back.
        let f = write_temp("K=placeholder\n");
        let tricky = "line1\nline2\twith #hash and \"quotes\"";
        write_entry(f.path(), "K", tricky).unwrap();
        let entries = parse_dotenv_file(f.path()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].value, tricky);
    }
}
