//! Pure, filesystem-free parser for OpenSSH client-config text.
//!
//! Split out from `openssh.rs` so the grammar can be unit-tested against
//! string fixtures without touching `~/.ssh/config`. The provider
//! (`openssh.rs`) handles path resolution, file reading, and `Include`
//! expansion, then feeds raw text here.
//!
//! ## Grammar we honour (per `man 5 ssh_config`)
//!
//! - Keywords are **case-insensitive** (`Host` == `host` == `HOST`).
//! - The keyword/argument separator is whitespace OR `=`, optionally
//!   surrounded by whitespace: `Port 22`, `Port=22`, `Port = 22`.
//! - A `Host` line lists one or more patterns: `Host web *.example.com`.
//!   Patterns may contain `*`, `?`, or a leading `!` (negation).
//! - Directives between one `Host`/`Match` line and the next apply to that
//!   block.
//! - `#` starts a comment; blank lines are ignored.
//! - Argument values may be double-quoted (paths with spaces).
//!
//! ## What we deliberately do NOT do
//!
//! We do not evaluate `Match` conditions, expand `%`-tokens, resolve `~`,
//! apply OpenSSH defaults, or merge wildcard blocks into concrete hosts.
//! This is a read-only *inventory*: we surface what each `Host` block
//! literally declares and let `ssh` itself do the real resolution at
//! connect time.

/// A single parsed host block: one alias pattern plus the directives that
/// applied to it, distilled to the fields ProcMix surfaces.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedHost {
    /// One pattern from the `Host` line (a line with N patterns yields N
    /// `ParsedHost`s sharing the block's directives).
    pub name: String,
    pub host_name: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    /// `true` when ProcMix can safely rewrite this block's modelled directives
    /// (`HostName`/`User`/`Port`/`IdentityFile`) in place: a single-pattern
    /// `Host` line (not multi-pattern, not a negation `!`), outside any
    /// `Match`, and with NO directive outside the modelled set. Wildcards
    /// (`*`, `?`) ARE allowed — a pattern block like `*.staging.example.com`
    /// with only modelled directives is params-editable; the UI just warns on
    /// a name change because it reassigns the rule's scope.
    pub editable_params: bool,
    /// Whether this block's `Host` name may be changed. Same condition as
    /// [`Self::editable_params`] (you can only rename a block you can
    /// rewrite). Surfacing it separately lets the UI gate/word the name field
    /// independently (e.g. warn for patterns).
    pub editable_name: bool,
    /// Whether ProcMix may delete this block. Same condition as
    /// [`Self::editable_params`]; the source-level gate (system/Include are
    /// never deletable) is applied by the provider.
    pub deletable: bool,
    /// The block's raw lines exactly as they appear in the file — the `Host`
    /// line through the line before the next block — with trailing whitespace
    /// (and `\r`) stripped per line. Lets the UI show the FULL block verbatim,
    /// including directives ProcMix doesn't model (`ProxyJump`, `SendEnv`, …),
    /// which is the only place those surface. Trailing blank lines are
    /// trimmed. For a multi-pattern `Host` line, every resulting `ParsedHost`
    /// shares the same `raw_text`.
    pub raw_text: String,
}

/// Outcome of parsing one config file's text.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedConfig {
    pub hosts: Vec<ParsedHost>,
    /// Paths named by `Include` directives, in declaration order, verbatim
    /// (not resolved). The provider resolves + recurses; the parser only
    /// reports them so file IO stays out of this pure layer.
    pub includes: Vec<String>,
}

/// Directives ProcMix understands well enough to round-trip. A block that
/// uses ONLY these (and is a single literal alias outside any `Match`) is
/// considered editable. Anything else flips the block to read-only so a
/// future writer never mangles a config it doesn't fully model.
///
/// Stored lower-cased; lookups lower-case the keyword first (keywords are
/// case-insensitive).
const MODELLED_KEYWORDS: &[&str] = &["hostname", "user", "port", "identityfile"];

/// Split a config line into `(keyword, rest)` honouring the whitespace-or-`=`
/// separator. Returns `None` for blank/comment lines.
fn split_keyword(line: &str) -> Option<(String, String)> {
    // `str::trim` removes a trailing `\r` too, giving CRLF tolerance.
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }

    // The keyword ends at the first whitespace or `=`. OpenSSH treats a
    // leading `=` as part of the separator, e.g. `Port=22` and `Port = 22`.
    let sep_idx = trimmed.find(|c: char| c.is_whitespace() || c == '=');
    let (kw, rest) = match sep_idx {
        Some(i) => (&trimmed[..i], &trimmed[i..]),
        None => (trimmed, ""),
    };
    if kw.is_empty() {
        return None;
    }

    // Strip the separator run: leading whitespace, then an optional single
    // `=`, then more whitespace. This collapses ` = `, `=`, and `   ` alike.
    let mut rest = rest.trim_start();
    if let Some(stripped) = rest.strip_prefix('=') {
        rest = stripped.trim_start();
    }

    Some((kw.to_ascii_lowercase(), rest.to_string()))
}

/// Parse the FIRST whitespace-delimited argument, honouring double quotes.
/// `IdentityFile "C:\Program Files\key"` yields the quoted span verbatim
/// (without the quotes). Subsequent arguments are ignored — for the fields
/// we model, only the first matters.
fn first_arg(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if let Some(after) = value.strip_prefix('"') {
        // Quoted: take up to the next double quote.
        if let Some(end) = after.find('"') {
            return Some(after[..end].to_string());
        }
        // Unterminated quote — take the remainder minus the opening quote.
        return Some(after.to_string());
    }
    Some(
        value
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_string(),
    )
}

/// All whitespace-delimited arguments (for the `Host` line, which lists
/// multiple patterns). Quote handling is intentionally simple: host
/// patterns do not normally contain spaces, so we split on whitespace.
fn all_args(value: &str) -> Vec<String> {
    value.split_whitespace().map(|s| s.to_string()).collect()
}

/// Accumulator for the directives of the block currently being parsed.
#[derive(Default)]
struct BlockState {
    patterns: Vec<String>,
    host_name: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    identity_file: Option<String>,
    /// Set when the block contains a directive outside [`MODELLED_KEYWORDS`].
    has_unmodelled: bool,
    /// Set when the block is introduced/owned by a `Match` line — never
    /// editable, since we don't evaluate match conditions.
    is_match: bool,
    /// Every raw line of the block (the `Host` line and everything under it
    /// up to the next block), per-line trailing-trimmed. Used to surface the
    /// verbatim block in the UI's view modal.
    raw_lines: Vec<String>,
}

impl BlockState {
    /// Join the captured raw lines into block text.
    ///
    /// The capture runs from this block's `Host` line up to the line before
    /// the next block, so the tail may contain lines that actually belong to
    /// the NEXT block — namely its *leading comment* (a run of `#` lines that
    /// describes the following block, separated from this block's own content
    /// by a blank line). Those must be excluded, or e.g. a pattern block ends
    /// up showing the comment that introduces the host below it.
    ///
    /// Trimming rule, from the end:
    ///   1. drop trailing blank lines;
    ///   2. if what remains ends in a run of comment lines AND that run is
    ///      preceded by a blank line (i.e. it is detached from this block's
    ///      directives), drop the comment run too — it leads the next block;
    ///   3. drop the blank line(s) left between.
    ///
    /// An in-block comment (no blank gap above it, e.g. a note between
    /// directives) is NOT detached and is kept.
    fn raw_text(&self) -> String {
        let mut end = self.raw_lines.len();

        // (1) trailing blanks
        while end > 0 && self.raw_lines[end - 1].trim().is_empty() {
            end -= 1;
        }

        // (2) a trailing comment run that is detached by a blank line belongs
        // to the next block. Find the start of the trailing comment run.
        let mut comment_start = end;
        while comment_start > 0
            && self.raw_lines[comment_start - 1]
                .trim_start()
                .starts_with('#')
        {
            comment_start -= 1;
        }
        if comment_start < end {
            // There is a trailing comment run [comment_start, end). It is the
            // next block's lead comment only if a blank line separates it from
            // this block's content above (or it is the whole remainder).
            let detached =
                comment_start == 0 || self.raw_lines[comment_start - 1].trim().is_empty();
            if detached {
                end = comment_start;
                // (3) drop the blank line(s) now left at the tail.
                while end > 0 && self.raw_lines[end - 1].trim().is_empty() {
                    end -= 1;
                }
            }
        }

        self.raw_lines[..end].join("\n")
    }

    fn flush(self, out: &mut Vec<ParsedHost>) {
        let raw_text = self.raw_text();
        for pattern in &self.patterns {
            // A block is ProcMix-writable when it is a single-pattern `Host`
            // line (not multi-pattern), outside any `Match`, with only modelled
            // directives, and not a negation pattern. Wildcards (`*`/`?`) ARE
            // allowed — that's what makes pattern blocks editable.
            let writable = !self.is_match
                && !self.has_unmodelled
                && self.patterns.len() == 1
                && !pattern.starts_with('!');
            out.push(ParsedHost {
                name: pattern.clone(),
                host_name: self.host_name.clone(),
                user: self.user.clone(),
                port: self.port,
                identity_file: self.identity_file.clone(),
                editable_params: writable,
                editable_name: writable,
                deletable: writable,
                raw_text: raw_text.clone(),
            });
        }
    }
}

/// Parse OpenSSH config text into hosts and include directives.
///
/// CRLF-tolerant: lines are split on `\n` and each is `trim`-med, which
/// removes a trailing `\r`. Never fails — malformed lines (e.g. a
/// non-numeric `Port`) are skipped for that field rather than erroring the
/// whole file, matching ssh's own lenient-ish behaviour and keeping the
/// inventory robust against hand-edited configs.
pub fn parse(text: &str) -> ParsedConfig {
    let mut hosts: Vec<ParsedHost> = Vec::new();
    let mut includes: Vec<String> = Vec::new();
    let mut current: Option<BlockState> = None;

    for raw_line in text.split('\n') {
        // Per-line trailing trim (drops a trailing `\r` for CRLF files) so the
        // captured block text is clean but otherwise verbatim.
        let line_for_raw = raw_line.trim_end();

        let Some((keyword, value)) = split_keyword(raw_line) else {
            // Blank/comment line: it belongs to the active block's raw text
            // (e.g. an in-block comment), but contributes no directive.
            if let Some(block) = current.as_mut() {
                block.raw_lines.push(line_for_raw.to_string());
            }
            continue;
        };

        match keyword.as_str() {
            "host" => {
                if let Some(block) = current.take() {
                    block.flush(&mut hosts);
                }
                let patterns = all_args(&value);
                current = Some(BlockState {
                    patterns,
                    raw_lines: vec![line_for_raw.to_string()],
                    ..Default::default()
                });
            }
            "match" => {
                // A Match block ends the previous Host block. We track that a
                // Match context exists (so subsequent Host blocks before the
                // next plain `Host` are still attributed correctly), but a
                // Match block itself contributes no named host to the
                // inventory — it has conditions, not an alias.
                if let Some(block) = current.take() {
                    block.flush(&mut hosts);
                }
                // Represent the Match block as an active-but-nameless state so
                // its directives don't leak onto a later Host; it has no
                // patterns, so flush() emits nothing.
                current = Some(BlockState {
                    is_match: true,
                    raw_lines: vec![line_for_raw.to_string()],
                    ..Default::default()
                });
            }
            "include" => {
                // Include can name multiple (possibly globbed) paths.
                for path in all_args(&value) {
                    includes.push(path);
                }
            }
            _ => {
                let Some(block) = current.as_mut() else {
                    // A directive before any Host/Match line is a global
                    // default. We don't model globals as a host; ignore it
                    // for the inventory (ssh applies it, we don't surface it).
                    continue;
                };
                block.raw_lines.push(line_for_raw.to_string());
                apply_directive(block, &keyword, &value);
            }
        }
    }

    if let Some(block) = current.take() {
        block.flush(&mut hosts);
    }

    ParsedConfig { hosts, includes }
}

/// Apply one non-Host/Match/Include directive to the active block.
fn apply_directive(block: &mut BlockState, keyword: &str, value: &str) {
    match keyword {
        "hostname" => block.host_name = first_arg(value),
        "user" => block.user = first_arg(value),
        "port" => {
            // Non-numeric / out-of-range port: skip the field, mark the block
            // unmodelled (we couldn't fully understand it) so it stays
            // read-only rather than silently dropping data on a future write.
            match first_arg(value).and_then(|s| s.parse::<u16>().ok()) {
                Some(p) => block.port = Some(p),
                None => block.has_unmodelled = true,
            }
        }
        "identityfile" => block.identity_file = first_arg(value),
        _ => {
            if !MODELLED_KEYWORDS.contains(&keyword) {
                block.has_unmodelled = true;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_simple_block() {
        let cfg = parse("Host prod\n  HostName prod.example.com\n  User deploy\n  Port 2222\n");
        assert_eq!(cfg.hosts.len(), 1);
        let h = &cfg.hosts[0];
        assert_eq!(h.name, "prod");
        assert_eq!(h.host_name.as_deref(), Some("prod.example.com"));
        assert_eq!(h.user.as_deref(), Some("deploy"));
        assert_eq!(h.port, Some(2222));
        assert!(h.editable_params);
    }

    #[test]
    fn keywords_are_case_insensitive() {
        let cfg = parse("HOST prod\n  hostname h\n  USER u\n  PoRt 22\n");
        let h = &cfg.hosts[0];
        assert_eq!(h.host_name.as_deref(), Some("h"));
        assert_eq!(h.user.as_deref(), Some("u"));
        assert_eq!(h.port, Some(22));
    }

    #[test]
    fn accepts_equals_separator() {
        let cfg = parse("Host=prod\nHostName=h\nPort = 22\n");
        let h = &cfg.hosts[0];
        assert_eq!(h.name, "prod");
        assert_eq!(h.host_name.as_deref(), Some("h"));
        assert_eq!(h.port, Some(22));
    }

    #[test]
    fn crlf_line_endings_are_tolerated() {
        let cfg = parse("Host prod\r\n  HostName h\r\n  Port 22\r\n");
        let h = &cfg.hosts[0];
        assert_eq!(h.name, "prod");
        assert_eq!(h.host_name.as_deref(), Some("h"));
        assert_eq!(h.port, Some(22));
        assert!(h.editable_params);
    }

    #[test]
    fn comments_and_blank_lines_ignored() {
        let cfg = parse("# a comment\n\nHost prod\n   # inline-ish\n  User u\n\n");
        assert_eq!(cfg.hosts.len(), 1);
        assert_eq!(cfg.hosts[0].user.as_deref(), Some("u"));
    }

    #[test]
    fn multiple_patterns_yield_multiple_hosts_all_non_editable() {
        let cfg = parse("Host web1 web2\n  User u\n");
        assert_eq!(cfg.hosts.len(), 2);
        assert_eq!(cfg.hosts[0].name, "web1");
        assert_eq!(cfg.hosts[1].name, "web2");
        // Multiple patterns in one block => not safely round-trippable.
        assert!(!cfg.hosts[0].editable_params);
        assert!(!cfg.hosts[1].editable_params);
    }

    #[test]
    fn wildcard_pattern_is_editable() {
        // A single-pattern wildcard block with only modelled directives IS
        // params-editable (it's a connection rule ProcMix can rewrite); the
        // UI just warns on a name change.
        let cfg = parse("Host *.example.com\n  User u\n");
        assert_eq!(cfg.hosts.len(), 1);
        assert!(cfg.hosts[0].editable_params);
        assert!(cfg.hosts[0].editable_name);
        assert!(cfg.hosts[0].deletable);
    }

    #[test]
    fn question_mark_is_editable_but_negation_is_not() {
        // `?` is a wildcard → editable. `!` is a negation rule → never
        // editable (editing an exclusion is confusing and rare).
        let q = parse("Host web?\n  User u\n");
        assert!(q.hosts[0].editable_params);
        let neg = parse("Host !secret\n  User u\n");
        assert!(!neg.hosts[0].editable_params);
        assert!(!neg.hosts[0].deletable);
    }

    #[test]
    fn unknown_directive_makes_block_read_only() {
        let cfg = parse("Host prod\n  ProxyJump bastion\n  User u\n");
        assert_eq!(cfg.hosts.len(), 1);
        assert_eq!(cfg.hosts[0].user.as_deref(), Some("u"));
        assert!(!cfg.hosts[0].editable_params);
    }

    #[test]
    fn raw_text_captures_the_full_block_including_unmodelled_lines() {
        let cfg = parse(
            "Host prod\n    # a note\n    HostName h\n    ProxyJump bastion\n\nHost other\n    User u\n",
        );
        let prod = cfg.hosts.iter().find(|h| h.name == "prod").unwrap();
        // The whole block, verbatim, incl. the comment and the unmodelled
        // ProxyJump line; trailing blank line trimmed; next block excluded.
        assert_eq!(
            prod.raw_text,
            "Host prod\n    # a note\n    HostName h\n    ProxyJump bastion"
        );
        let other = cfg.hosts.iter().find(|h| h.name == "other").unwrap();
        assert_eq!(other.raw_text, "Host other\n    User u");
    }

    #[test]
    fn raw_text_strips_crlf_per_line() {
        let cfg = parse("Host prod\r\n    HostName h\r\n");
        assert_eq!(cfg.hosts[0].raw_text, "Host prod\n    HostName h");
    }

    #[test]
    fn raw_text_excludes_next_blocks_detached_leading_comment() {
        // Regression: a comment after a blank line, just above the next
        // `Host`, belongs to that next block and must not be captured into
        // the previous block's raw text.
        let cfg = parse(
            "Host *.staging.example.com\n    User ci\n    Port 22\n\n# leads the next block\nHost behind\n    User ops\n",
        );
        let pattern = cfg
            .hosts
            .iter()
            .find(|h| h.name == "*.staging.example.com")
            .unwrap();
        assert_eq!(
            pattern.raw_text, "Host *.staging.example.com\n    User ci\n    Port 22",
            "the next block's lead comment must be excluded"
        );

        // The comment is genuinely lost from raw_text capture (it leads the
        // next block); the next block's own raw_text starts at its Host line.
        let next = cfg.hosts.iter().find(|h| h.name == "behind").unwrap();
        assert_eq!(next.raw_text, "Host behind\n    User ops");
    }

    #[test]
    fn raw_text_keeps_an_attached_trailing_comment() {
        // A trailing comment with NO blank line above it is part of THIS
        // block (e.g. a note after the last directive), and is kept.
        let cfg =
            parse("Host prod\n    User u\n    # trailing note for prod\nHost other\n    User o\n");
        let prod = cfg.hosts.iter().find(|h| h.name == "prod").unwrap();
        assert_eq!(
            prod.raw_text,
            "Host prod\n    User u\n    # trailing note for prod"
        );
    }

    #[test]
    fn match_block_contributes_no_host_and_isolates_directives() {
        let cfg = parse("Match host *.internal\n  User admin\nHost prod\n  User deploy\n");
        // Only `prod` is a named host; the Match block adds nothing.
        assert_eq!(cfg.hosts.len(), 1);
        assert_eq!(cfg.hosts[0].name, "prod");
        // `prod`'s User must be its own, not leaked from the Match block.
        assert_eq!(cfg.hosts[0].user.as_deref(), Some("deploy"));
        assert!(cfg.hosts[0].editable_params);
    }

    #[test]
    fn quoted_identity_file_with_spaces() {
        let cfg = parse("Host prod\n  IdentityFile \"/path/with space/id\"\n");
        assert_eq!(
            cfg.hosts[0].identity_file.as_deref(),
            Some("/path/with space/id")
        );
    }

    #[test]
    fn collects_include_paths() {
        let cfg = parse("Include ~/.ssh/work/*.conf extra.conf\nHost prod\n");
        assert_eq!(cfg.includes, vec!["~/.ssh/work/*.conf", "extra.conf"]);
        assert_eq!(cfg.hosts.len(), 1);
    }

    #[test]
    fn non_numeric_port_is_skipped_and_marks_unmodelled() {
        let cfg = parse("Host prod\n  Port not-a-number\n");
        assert_eq!(cfg.hosts[0].port, None);
        assert!(!cfg.hosts[0].editable_params);
    }

    #[test]
    fn directives_before_any_host_are_ignored() {
        // Leading global defaults must not crash or invent a host.
        let cfg = parse("ServerAliveInterval 60\nHost prod\n  User u\n");
        assert_eq!(cfg.hosts.len(), 1);
        assert_eq!(cfg.hosts[0].name, "prod");
    }

    #[test]
    fn empty_input_yields_nothing() {
        let cfg = parse("");
        assert!(cfg.hosts.is_empty());
        assert!(cfg.includes.is_empty());
    }
}
