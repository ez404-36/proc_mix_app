//! Heuristic parser for CLI `--help` output.
//!
//! Extracts structured flag / positional-argument information from the raw
//! help text produced by `<utility> --help` / `-h` / `man`. The result is
//! purely best-effort: GNU/POSIX-style option tables are parsed reliably;
//! unusual help formats may produce an empty or incomplete list. The
//! frontend treats every result as an optional pre-fill, so false negatives
//! (missed flags) are always safe — the user can still type the command
//! manually.
//!
//! ## Wire contract
//!
//! `ParsedCli` is returned across the IPC boundary as JSON (camelCase).
//! The TypeScript mirror lives in `src/types/command.ts`.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Public DTOs
// ---------------------------------------------------------------------------

/// A single CLI flag extracted from help text (e.g. `-v, --verbose`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedFlag {
    /// All aliases for this flag, e.g. `["-v", "--verbose"]`.
    pub flags: Vec<String>,
    /// `true` when the flag accepts a value (e.g. `--output <FILE>`).
    pub takes_value: bool,
    /// The value placeholder hint, e.g. `"FILE"`, `"DIR"`, `"N"`.
    /// Empty string when `takes_value` is `false`.
    pub value_hint: String,
    /// One-line description extracted from the help text.
    pub description: String,
    /// `true` for positional arguments explicitly described as required
    /// in the help (via angle brackets in usage lines, e.g. `<SOURCE>`).
    pub required: bool,
}

/// A positional (non-flag) argument extracted from a usage line.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedArg {
    /// Argument name, e.g. `"SOURCE"`, `"DEST"`, `"FILE"`.
    pub name: String,
    /// Short description, if available.
    pub description: String,
    /// `true` when the argument appeared without surrounding brackets
    /// in a usage line (`<ARG>` = required, `[ARG]` = optional).
    pub required: bool,
}

/// Top-level parse result returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedCli {
    /// Positional arguments in the order they appear in the usage line.
    pub positional_args: Vec<ParsedArg>,
    /// All detected flags / options.
    pub flags: Vec<ParsedFlag>,
}

impl ParsedCli {
    fn empty() -> Self {
        Self {
            positional_args: vec![],
            flags: vec![],
        }
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Parse the raw help text and return structured CLI metadata.
/// Never panics; returns an empty `ParsedCli` for unrecognisable input.
pub fn parse_flags(help_text: &str) -> ParsedCli {
    if help_text.trim().is_empty() {
        return ParsedCli::empty();
    }

    let positional_args = extract_positional_args(help_text);
    let flags = extract_flags(help_text);

    ParsedCli {
        positional_args,
        flags,
    }
}

// ---------------------------------------------------------------------------
// Positional argument extraction
// ---------------------------------------------------------------------------

/// Extract positional arguments from "Usage:" lines.
///
/// Scans for lines that start with `usage:` (case-insensitive), then
/// tokenises them looking for `<ARG>` (required) and `[ARG]` (optional)
/// patterns that do NOT start with `-` (those are flags, not args).
fn extract_positional_args(help_text: &str) -> Vec<ParsedArg> {
    let mut args: Vec<ParsedArg> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for line in help_text.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_lowercase();
        // Recognise "usage:" / "usage " (GNU style) and the shorter "use:" /
        // "use " used by X.org tools and some btrfs utilities.
        let prefix_len = if lower.starts_with("usage:") || lower.starts_with("usage ") {
            6
        } else if lower.starts_with("use:") || lower.starts_with("use ") {
            4
        } else {
            continue;
        };
        // Remove the prefix and the utility name (first token after).
        let rest = trimmed[prefix_len..].trim_start();
        let rest = skip_first_word(rest);

        // Tokenise the rest of the usage line.
        let mut chars = rest.chars().peekable();
        while let Some(ch) = chars.next() {
            match ch {
                '<' => {
                    // Required positional: `<NAME>`
                    let name: String = chars.by_ref().take_while(|&c| c != '>').collect();
                    if !name.is_empty() && !name.starts_with('-') {
                        let key = name.to_uppercase();
                        if !seen.contains(&key) {
                            seen.insert(key.clone());
                            args.push(ParsedArg {
                                name: key,
                                description: String::new(),
                                required: true,
                            });
                        }
                    }
                }
                '[' => {
                    // Optional positional: `[NAME]` — only count if it
                    // looks like a positional (no `-` prefix, no `…`).
                    let inner: String = chars.by_ref().take_while(|&c| c != ']').collect();
                    let token = inner.trim();
                    if !token.is_empty()
                        && !token.starts_with('-')
                        && !token.contains("...")
                        && token
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                        && !is_option_metaword(token)
                    {
                        let key = token.to_uppercase();
                        if !seen.contains(&key) {
                            seen.insert(key.clone());
                            args.push(ParsedArg {
                                name: key,
                                description: String::new(),
                                required: false,
                            });
                        }
                    }
                }
                _ => {}
            }
        }
    }

    args
}

/// Returns `true` when `token` (case-insensitive) is a generic placeholder
/// that means "zero or more flags/options go here", not an actual positional
/// argument name. These appear in usage lines as `[OPTION]`, `[OPTIONS]`,
/// `[FLAG]`, etc. and must not be surfaced as positional arg fields.
fn is_option_metaword(token: &str) -> bool {
    const METAWORDS: &[&str] = &[
        "option",
        "options",
        "flag",
        "flags",
        "arg",
        "args",
        "argument",
        "arguments",
        "param",
        "params",
        "parameter",
        "parameters",
        "switch",
        "switches",
    ];
    let lower = token.to_lowercase();
    METAWORDS.iter().any(|&m| lower == m)
}

/// Skip the first whitespace-delimited word in `s`, returning the rest.
fn skip_first_word(s: &str) -> &str {
    let s = s.trim_start();
    let end = s.find(|c: char| c.is_whitespace()).unwrap_or(s.len());
    s[end..].trim_start()
}

// ---------------------------------------------------------------------------
// Flag extraction
// ---------------------------------------------------------------------------

/// Extract flags from the options section of help text.
///
/// Strategy: scan every line for a leading flag token (`-x` or `--foo`).
/// For each match, parse aliases, value hints, and description text.
///
/// Supported formats:
///   - `-v, --verbose          Description here`
///   - `  --output=<FILE>      Write to FILE`
///   - `  -o FILE              Output file`
///   - `      --long-flag[=VALUE]   Optional value`
///
fn extract_flags(help_text: &str) -> Vec<ParsedFlag> {
    let mut flags: Vec<ParsedFlag> = Vec::new();
    // Deduplicate: track the primary (longest) flag name already seen.
    let mut seen_primaries: std::collections::HashSet<String> = std::collections::HashSet::new();

    let lines: Vec<&str> = help_text.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim_start();
        // Some tools (e.g. btrfs-select-super) embed ASCII control characters
        // (SOH \x01, STX \x02, …) as field delimiters before the `-`. Strip
        // them so the `-` check below still fires.
        let trimmed = trimmed.trim_start_matches(|c: char| c.is_ascii_control() && c != '\t');

        // Handle `[--flag]` / `[--flag=VALUE]` bracket-wrapped option lines
        // (used by caca-config and similar tools). Strip the outer `[…]` and
        // try to parse the inner content as a normal flag line.
        let trimmed = if trimmed.starts_with('[') && trimmed.contains("--") {
            let inner = trimmed.trim_start_matches('[');
            // Find the matching closing bracket (last `]`).
            let inner = if let Some(idx) = inner.rfind(']') {
                inner[..idx].trim()
            } else {
                inner.trim()
            };
            inner
        } else {
            trimmed
        };

        // A flag line must start with `-`.
        if !trimmed.starts_with('-') {
            i += 1;
            continue;
        }

        if let Some(parsed) = parse_flag_line(trimmed) {
            let primary = primary_flag(&parsed.flags);
            if !seen_primaries.contains(&primary) {
                // Try to gather a continuation description from the next
                // line if the current line has no description and the next
                // line is indented (continuation pattern).
                let description = if parsed.description.is_empty() && i + 1 < lines.len() {
                    let next = lines[i + 1];
                    let next_trimmed = next.trim();
                    // Continuation: next line is indented by at least 4 spaces
                    // and does NOT start with `-` (i.e. it's not a new flag).
                    let indent = leading_spaces(next);
                    if indent >= 4 && !next_trimmed.starts_with('-') && !next_trimmed.is_empty() {
                        i += 1; // consume continuation line
                        next_trimmed.to_string()
                    } else {
                        String::new()
                    }
                } else {
                    parsed.description.clone()
                };

                seen_primaries.insert(primary);
                flags.push(ParsedFlag {
                    flags: parsed.flags,
                    takes_value: parsed.takes_value,
                    value_hint: parsed.value_hint,
                    description,
                    required: false,
                });
            }
        }
        i += 1;
    }

    flags
}

/// Count the number of leading ASCII spaces on a line.
fn leading_spaces(s: &str) -> usize {
    s.chars().take_while(|c| *c == ' ').count()
}

/// Return the "primary" flag name — the longest alias (usually `--long`).
fn primary_flag(flags: &[String]) -> String {
    flags
        .iter()
        .max_by_key(|f| f.len())
        .cloned()
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Single-line flag parser
// ---------------------------------------------------------------------------

struct FlagLineResult {
    flags: Vec<String>,
    takes_value: bool,
    value_hint: String,
    description: String,
}

/// Parse a single trimmed line that begins with `-`.
///
/// Returns `None` when the line doesn't look like a flag definition.
fn parse_flag_line(line: &str) -> Option<FlagLineResult> {
    // We split the line into a "flag spec" part (leading tokens that look
    // like flags or value placeholders) and a "description" part
    // (everything after sufficient whitespace or a separator).
    //
    // Typical formats we handle:
    //   `-v, --verbose          Verbose output`
    //   `--output=<FILE>        Write output here`
    //   `-o, --output <FILE>    Output file`
    //   `--flag[=VALUE]         Optional value`
    //   `-n N                   Number of items`

    let mut flags: Vec<String> = Vec::new();
    let mut takes_value = false;
    let mut value_hint = String::new();

    // Walk through the line token by token.
    let rest = parse_flag_tokens(line, &mut flags, &mut takes_value, &mut value_hint);

    if flags.is_empty() {
        return None;
    }

    // Trim a separator (` — `, `:`, `  `) from the start of the rest.
    let description = trim_flag_description_prefix(rest.trim()).trim().to_string();

    Some(FlagLineResult {
        flags,
        takes_value,
        value_hint,
        description,
    })
}

/// Walk `line` collecting flag tokens (`-x`, `--long`) and an optional
/// value hint (`<FILE>`, `VALUE`, `N`), writing results into the mutable
/// parameters. Returns the remainder of the line (the description part).
fn parse_flag_tokens<'a>(
    line: &'a str,
    flags: &mut Vec<String>,
    takes_value: &mut bool,
    value_hint: &mut String,
) -> &'a str {
    let mut pos = 0;
    let len = len_chars(line);

    while pos < len {
        let ch = char_at(line, pos);

        if ch == ' ' || ch == '\t' {
            pos += 1;
            // If there's a large gap (≥ 2 spaces), treat the rest as the
            // description — we've consumed all flag/value tokens.
            if pos < len && (char_at(line, pos) == ' ' || char_at(line, pos) == '\t') {
                // Skip all whitespace.
                while pos < len && (char_at(line, pos) == ' ' || char_at(line, pos) == '\t') {
                    pos += 1;
                }
                // If next char is `-`, it's another flag alias; otherwise
                // it's the description.
                if pos < len && char_at(line, pos) != '-' {
                    return substr(line, pos);
                }
            }
            continue;
        }

        // `,`, `;`, and `|` are alias separators (e.g. `-v|--verbose`).
        if ch == ',' || ch == ';' || ch == '|' {
            pos += 1;
            continue;
        }

        if ch == '-' && pos < len - 1 {
            // Flag token: collect until whitespace, `=`, `[`, `,`, or end.
            let start = pos;
            pos += 1; // skip first `-`
            if pos < len && char_at(line, pos) == '-' {
                pos += 1; // skip second `-`
            }
            while pos < len {
                let c = char_at(line, pos);
                // Stop at whitespace, value-separator `=`, optional-value `[`,
                // and alias separators `,` `;` `|`.
                if c == ' ' || c == '\t' || c == ',' || c == ';' || c == '|' || c == '=' || c == '['
                {
                    break;
                }
                pos += 1;
            }
            let flag_str = substr(line, start)[..pos - start].to_string();
            if !flag_str.is_empty() {
                flags.push(flag_str);
            }

            // `=<VALUE>` or `=VALUE` suffix attached to the flag.
            if pos < len && char_at(line, pos) == '=' {
                pos += 1; // skip `=`
                let (hint, consumed) = read_value_hint(substr(line, pos));
                if !hint.is_empty() {
                    *takes_value = true;
                    *value_hint = hint;
                }
                pos += consumed;
            }
            // `[=VALUE]` optional value suffix.
            if pos < len && char_at(line, pos) == '[' {
                pos += 1;
                if pos < len && char_at(line, pos) == '=' {
                    pos += 1;
                }
                let (hint, consumed) = read_value_hint_until_bracket(substr(line, pos));
                if !hint.is_empty() {
                    *takes_value = true;
                    *value_hint = hint;
                }
                pos += consumed;
            }
            continue;
        }

        // Not a flag starter: this might be a bare value hint like `N` or
        // `<FILE>` or the start of the description.
        if ch == '<' {
            pos += 1;
            let (hint, consumed) = read_value_hint_until_angle(substr(line, pos));
            if !hint.is_empty() && !hint.to_ascii_lowercase().contains("options") {
                *takes_value = true;
                *value_hint = hint;
            }
            pos += consumed;
            continue;
        }

        // Bare UPPERCASE word as value hint (e.g. `-o FILE`, `-n N`).
        if ch.is_ascii_uppercase() && !flags.is_empty() {
            let start = pos;
            while pos < len {
                let c = char_at(line, pos);
                if c == ' ' || c == '\t' {
                    break;
                }
                pos += 1;
            }
            let word = &substr(line, start)[..pos - start];
            // Only treat it as a value hint if it looks like a placeholder:
            // all uppercase, possibly with `-` or `_`, length ≥ 1.
            if word
                .chars()
                .all(|c| c.is_ascii_uppercase() || c == '-' || c == '_')
                && !word.is_empty()
            {
                *takes_value = true;
                *value_hint = word.to_string();
                continue;
            }
            // Otherwise it's the start of the description.
            return substr(line, start);
        }

        // Anything else is the description.
        return substr(line, pos);
    }

    ""
}

// ---------------------------------------------------------------------------
// String helpers (char-indexed, since we work with ASCII-dominant help text)
// ---------------------------------------------------------------------------

fn len_chars(s: &str) -> usize {
    s.chars().count()
}

fn char_at(s: &str, idx: usize) -> char {
    s.chars().nth(idx).unwrap_or('\0')
}

fn substr(s: &str, char_offset: usize) -> &str {
    let byte_offset: usize = s
        .char_indices()
        .nth(char_offset)
        .map(|(i, _)| i)
        .unwrap_or(s.len());
    &s[byte_offset..]
}

fn read_value_hint(s: &str) -> (String, usize) {
    if let Some(stripped) = s.strip_prefix('<') {
        read_value_hint_until_angle(stripped)
    } else {
        // Bare uppercase word.
        let end = s
            .char_indices()
            .find(|(_, c)| !c.is_ascii_uppercase() && *c != '-' && *c != '_')
            .map(|(i, _)| i)
            .unwrap_or(s.len());
        (s[..end].to_string(), end)
    }
}

fn read_value_hint_until_angle(s: &str) -> (String, usize) {
    let end = s.find('>').unwrap_or(s.len());
    let consumed = if end < s.len() { end + 1 } else { end };
    (s[..end].trim().to_string(), consumed)
}

fn read_value_hint_until_bracket(s: &str) -> (String, usize) {
    let end = s.find(']').unwrap_or(s.len());
    let consumed = if end < s.len() { end + 1 } else { end };
    let hint = s[..end]
        .trim_start_matches('<')
        .trim_end_matches('>')
        .trim()
        .to_string();
    (hint, consumed)
}

fn trim_flag_description_prefix(s: &str) -> &str {
    let s = s.trim_start_matches(['-', ' ', '\t']);
    // Remove leading `—` (em dash used as separator by some tools).
    let s = s.trim_start_matches('\u{2014}').trim_start();
    s
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------
    // parse_flags: smoke tests
    // -----------------------------------------------------------------

    #[test]
    fn empty_input_returns_empty() {
        let result = parse_flags("");
        assert!(result.flags.is_empty());
        assert!(result.positional_args.is_empty());
    }

    #[test]
    fn whitespace_only_returns_empty() {
        let result = parse_flags("   \n  \t  ");
        assert!(result.flags.is_empty());
    }

    // -----------------------------------------------------------------
    // Flag extraction
    // -----------------------------------------------------------------

    #[test]
    fn gnu_style_long_and_short() {
        let help = "\
Options:
  -v, --verbose          Enable verbose output
  -o, --output <FILE>    Write to FILE
  -n N                   Number of lines
";
        let result = parse_flags(help);
        assert!(!result.flags.is_empty(), "should find flags");

        let verbose = result
            .flags
            .iter()
            .find(|f| f.flags.contains(&"--verbose".to_string()));
        assert!(verbose.is_some(), "--verbose not found");
        let verbose = verbose.unwrap();
        assert!(verbose.flags.contains(&"-v".to_string()));
        assert!(!verbose.takes_value);
        assert!(verbose.description.to_lowercase().contains("verbose"));

        let output = result
            .flags
            .iter()
            .find(|f| f.flags.contains(&"--output".to_string()));
        assert!(output.is_some(), "--output not found");
        let output = output.unwrap();
        assert!(output.takes_value);
        assert_eq!(output.value_hint, "FILE");

        let n_flag = result
            .flags
            .iter()
            .find(|f| f.flags.contains(&"-n".to_string()));
        assert!(n_flag.is_some(), "-n not found");
        let n_flag = n_flag.unwrap();
        assert!(n_flag.takes_value);
        assert_eq!(n_flag.value_hint, "N");
    }

    #[test]
    fn equals_style_value() {
        let help = "  --output=<FILE>    Write output to FILE\n";
        let result = parse_flags(help);
        let flag = result
            .flags
            .iter()
            .find(|f| f.flags.contains(&"--output".to_string()));
        assert!(flag.is_some());
        let flag = flag.unwrap();
        assert!(flag.takes_value);
        assert_eq!(flag.value_hint, "FILE");
    }

    #[test]
    fn optional_equals_value() {
        let help = "  --color[=WHEN]     Colorize the output\n";
        let result = parse_flags(help);
        let flag = result
            .flags
            .iter()
            .find(|f| f.flags.contains(&"--color".to_string()));
        assert!(flag.is_some());
        let flag = flag.unwrap();
        assert!(flag.takes_value);
        assert!(!flag.value_hint.is_empty());
    }

    #[test]
    fn boolean_flag_no_value() {
        let help = "  -h, --help          Show this help\n";
        let result = parse_flags(help);
        let flag = result
            .flags
            .iter()
            .find(|f| f.flags.contains(&"--help".to_string()));
        assert!(flag.is_some());
        let flag = flag.unwrap();
        assert!(!flag.takes_value);
        assert!(flag.value_hint.is_empty());
    }

    #[test]
    fn deduplication() {
        let help = "\
  -v, --verbose    Verbose
  -v, --verbose    Verbose (duplicate)
";
        let result = parse_flags(help);
        let verbose_count = result
            .flags
            .iter()
            .filter(|f| f.flags.contains(&"--verbose".to_string()))
            .count();
        assert_eq!(verbose_count, 1, "duplicates should be deduplicated");
    }

    // -----------------------------------------------------------------
    // Positional argument extraction
    // -----------------------------------------------------------------

    #[test]
    fn required_positional_from_usage() {
        let help = "Usage: cp <SOURCE> <DEST>\n";
        let result = parse_flags(help);
        let names: Vec<&str> = result
            .positional_args
            .iter()
            .map(|a| a.name.as_str())
            .collect();
        assert!(names.contains(&"SOURCE"), "SOURCE not found: {names:?}");
        assert!(names.contains(&"DEST"), "DEST not found: {names:?}");
        assert!(result.positional_args.iter().all(|a| a.required));
    }

    #[test]
    fn optional_positional_from_usage() {
        let help = "Usage: ls [DIRECTORY]\n";
        let result = parse_flags(help);
        let dir = result
            .positional_args
            .iter()
            .find(|a| a.name == "DIRECTORY");
        assert!(dir.is_some(), "DIRECTORY not found");
        assert!(!dir.unwrap().required);
    }

    #[test]
    fn no_false_positive_positionals_from_flags() {
        let help = "Usage: tar [OPTIONS] <ARCHIVE>\nOptions:\n  -v   verbose\n";
        let result = parse_flags(help);
        // Should find ARCHIVE but not OPTIONS.
        let names: Vec<&str> = result
            .positional_args
            .iter()
            .map(|a| a.name.as_str())
            .collect();
        assert!(names.contains(&"ARCHIVE"), "ARCHIVE not found: {names:?}");
        assert!(
            !names.contains(&"OPTIONS"),
            "OPTIONS must not be a positional arg"
        );
    }

    #[test]
    fn option_metawords_are_not_positional_args() {
        // Real cp usage line — SOURCE/DEST are bare words (no <> brackets),
        // so the parser won't detect them as positional args; but OPTION
        // appearing as [OPTION] must definitely not become one either.
        let help = "Usage: cp [OPTION]... [-T] <SOURCE> <DEST>\n";
        let result = parse_flags(help);
        let names: Vec<&str> = result
            .positional_args
            .iter()
            .map(|a| a.name.as_str())
            .collect();
        assert!(
            !names.contains(&"OPTION"),
            "[OPTION] must not appear as a positional arg"
        );
        assert!(names.contains(&"SOURCE"), "SOURCE not found: {names:?}");
        assert!(names.contains(&"DEST"), "DEST not found: {names:?}");
    }

    #[test]
    fn option_metaword_variants_all_filtered() {
        for word in &[
            "OPTION",
            "OPTIONS",
            "FLAG",
            "FLAGS",
            "ARG",
            "ARGS",
            "ARGUMENT",
            "ARGUMENTS",
            "PARAM",
            "PARAMS",
            "PARAMETER",
            "PARAMETERS",
            "SWITCH",
            "SWITCHES",
        ] {
            let help = format!("Usage: foo [{word}] <FILE>\n");
            let result = parse_flags(&help);
            let names: Vec<&str> = result
                .positional_args
                .iter()
                .map(|a| a.name.as_str())
                .collect();
            assert!(
                !names.contains(word),
                "[{word}] must not appear as a positional arg"
            );
            assert!(
                names.contains(&"FILE"),
                "FILE not found for word {word}: {names:?}"
            );
        }
    }

    #[test]
    fn malformed_input_does_not_panic() {
        let help = "-----\n\n<>\n[[]\n\x00\x01\x02\n  --\n  - \n";
        // Must not panic; may return empty or partial results.
        let _ = parse_flags(help);
    }

    #[test]
    fn description_trimming() {
        let help = "  --verbose    — Verbose mode\n";
        let result = parse_flags(help);
        let flag = result
            .flags
            .iter()
            .find(|f| f.flags.contains(&"--verbose".to_string()));
        assert!(flag.is_some());
        // The `—` and surrounding spaces should be stripped.
        assert!(
            !flag.unwrap().description.starts_with('—'),
            "description should not start with em dash"
        );
    }

    // -----------------------------------------------------------------
    // Bug 2: pipe `|` as alias separator
    // -----------------------------------------------------------------

    #[test]
    fn pipe_separated_aliases_both_extracted() {
        // aspell / btrfs style: `-v|--verbose`
        let help = "  -v|--verbose          Enable verbose output\n";
        let result = parse_flags(help);
        let flag = result
            .flags
            .iter()
            .find(|f| f.flags.contains(&"--verbose".to_string()));
        assert!(flag.is_some(), "--verbose not found");
        let flag = flag.unwrap();
        assert!(
            flag.flags.contains(&"-v".to_string()),
            "-v alias missing: {:?}",
            flag.flags
        );
        assert!(!flag.takes_value);
    }

    #[test]
    fn pipe_with_non_flag_rhs_does_not_produce_garbage() {
        // `-?|usage` — the right side of `|` is not a flag token.
        // We should not push "usage" as a flag name.
        let help = "  -?|usage          Show help\n";
        let result = parse_flags(help);
        let garbage = result
            .flags
            .iter()
            .any(|f| f.flags.iter().any(|s| s == "usage"));
        assert!(!garbage, "\"usage\" must not appear as a flag name");
    }

    #[test]
    fn pipe_separated_three_aliases() {
        let help = "  -q|-Q|--quiet      Suppress output\n";
        let result = parse_flags(help);
        let flag = result
            .flags
            .iter()
            .find(|f| f.flags.contains(&"--quiet".to_string()));
        assert!(flag.is_some(), "--quiet not found");
        let flag = flag.unwrap();
        assert!(
            flag.flags.contains(&"-q".to_string()),
            "-q missing: {:?}",
            flag.flags
        );
    }

    // -----------------------------------------------------------------
    // Bug 3: `use:` / `use ` as usage-line prefix
    // -----------------------------------------------------------------

    #[test]
    fn use_colon_prefix_extracts_positional_args() {
        // X.org / Xwayland style.
        let help = "use: Xephyr :<display> [option]\n";
        let result = parse_flags(help);
        let names: Vec<&str> = result
            .positional_args
            .iter()
            .map(|a| a.name.as_str())
            .collect();
        // `<display>` should become a required positional named "DISPLAY".
        assert!(
            names.contains(&"DISPLAY"),
            "DISPLAY not found in: {names:?}"
        );
    }

    #[test]
    fn use_space_prefix_extracts_positional_args() {
        let help = "use foo <INPUT> <OUTPUT>\n";
        let result = parse_flags(help);
        let names: Vec<&str> = result
            .positional_args
            .iter()
            .map(|a| a.name.as_str())
            .collect();
        assert!(names.contains(&"INPUT"), "INPUT not found in: {names:?}");
        assert!(names.contains(&"OUTPUT"), "OUTPUT not found in: {names:?}");
    }

    #[test]
    fn usage_colon_prefix_still_works_after_bug3_change() {
        // Regression: the existing `usage:` path must be unaffected.
        let help = "Usage: cp <SOURCE> <DEST>\n";
        let result = parse_flags(help);
        let names: Vec<&str> = result
            .positional_args
            .iter()
            .map(|a| a.name.as_str())
            .collect();
        assert!(names.contains(&"SOURCE"), "SOURCE not found: {names:?}");
        assert!(names.contains(&"DEST"), "DEST not found: {names:?}");
    }

    // -----------------------------------------------------------------
    // Bug 4: leading ASCII control characters before `-`
    // -----------------------------------------------------------------

    #[test]
    fn control_char_before_flag_is_stripped_and_flag_extracted() {
        // btrfs-select-super embeds SOH (\x01) before the flag dash.
        let help = "  \x01-s NUM     Superblock copy number\n  \x02--verbose  Verbose\n";
        let result = parse_flags(help);
        let s_flag = result
            .flags
            .iter()
            .find(|f| f.flags.contains(&"-s".to_string()));
        assert!(
            s_flag.is_some(),
            "-s flag not extracted despite leading \\x01"
        );
        let v_flag = result
            .flags
            .iter()
            .find(|f| f.flags.contains(&"--verbose".to_string()));
        assert!(
            v_flag.is_some(),
            "--verbose not extracted despite leading \\x02"
        );
    }

    #[test]
    fn tab_before_flag_is_not_stripped_as_control_char() {
        // A tab is a legitimate indent character and must NOT be stripped
        // (it is excluded from the control-char trim).
        let help = "\t-v, --verbose    Verbose\n";
        let result = parse_flags(help);
        let flag = result
            .flags
            .iter()
            .find(|f| f.flags.contains(&"--verbose".to_string()));
        assert!(flag.is_some(), "--verbose not found with tab indent");
    }

    // -----------------------------------------------------------------
    // Bug 5: `[--flag]` bracket-wrapped options
    // -----------------------------------------------------------------

    #[test]
    fn bracket_wrapped_boolean_flag_extracted() {
        let help = "   [--version]\n   [--help]\n";
        let result = parse_flags(help);
        let ver = result
            .flags
            .iter()
            .find(|f| f.flags.contains(&"--version".to_string()));
        assert!(ver.is_some(), "--version not extracted from [--version]");
        assert!(!ver.unwrap().takes_value);
    }

    #[test]
    fn bracket_wrapped_value_flag_extracted() {
        // caca-config style: `[--prefix[=DIR]]`
        let help = "   [--prefix[=DIR]]\n";
        let result = parse_flags(help);
        let flag = result
            .flags
            .iter()
            .find(|f| f.flags.contains(&"--prefix".to_string()));
        assert!(
            flag.is_some(),
            "--prefix not extracted from [--prefix[=DIR]]"
        );
        let flag = flag.unwrap();
        assert!(flag.takes_value, "--prefix should take a value");
        assert!(
            !flag.value_hint.is_empty(),
            "value hint should be non-empty"
        );
    }

    #[test]
    fn bracket_wrapped_does_not_produce_false_positives() {
        // `[OPTIONS]` and `[FILE]` in a usage line must not be mistaken
        // for bracket-wrapped flags (they contain no `--`).
        let help = "Usage: foo [OPTIONS] [FILE]\n";
        let result = parse_flags(help);
        let bad = result
            .flags
            .iter()
            .any(|f| f.flags.iter().any(|s| s == "OPTIONS" || s == "FILE"));
        assert!(!bad, "OPTIONS/FILE must not become flag names");
    }
}
