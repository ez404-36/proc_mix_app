//! Pure, filesystem-free **surgical editor** for OpenSSH client-config text.
//!
//! Companion to [`super::openssh_parse`]: where the parser turns text into a
//! host inventory, this turns an edit request into NEW text — touching only
//! the bytes that belong to the target `Host` block and leaving everything
//! else (comments, blank lines, unknown directives, other blocks, the file's
//! indentation style and line endings) **byte-for-byte intact**.
//!
//! This is the riskiest part of the whole SSH feature — a careless rewrite
//! could mangle a user's hand-maintained config — so the strategy is
//! deliberately conservative:
//!
//!   * We never reformat or re-serialise the whole file. We splice.
//!   * A block we don't fully model (wildcard alias, `Match`, an unknown
//!     directive) is NEVER edited here — callers must gate on the parser's
//!     `editable` flag first, and the provider re-validates.
//!   * Within an edited block we only ever touch the four modelled directive
//!     lines (`HostName`/`User`/`Port`/`IdentityFile`); any other line in the
//!     block (a comment, a blank line) is preserved verbatim and in place.
//!
//! ## Block boundary
//!
//! A block starts at a `Host <alias>` line and runs until the next top-level
//! `Host`/`Match` line or EOF — the same boundary the parser uses. We match a
//! block by an EXACT, case-insensitive single-pattern alias; multi-pattern or
//! wildcard `Host` lines are never targeted.

// Consumed by the `SshSourceWriter` impl on `OpenSshProvider`
// (`upsert_block` / `delete_block` / `is_editable_after`).

use super::openssh_parse;

/// The modelled fields of a host block. `None` for a field means "this
/// directive should not be present" — on update an existing line is removed;
/// on insert it is simply omitted.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HostEdit {
    pub alias: String,
    pub host_name: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
}

/// Detected line-ending style of a file, preserved across an edit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LineEnding {
    Lf,
    Crlf,
}

impl LineEnding {
    fn detect(text: &str) -> Self {
        // CRLF if the first newline is preceded by a CR. A file with no
        // newline at all defaults to LF (the Unix norm for ~/.ssh/config).
        match text.find('\n') {
            Some(i) if i > 0 && text.as_bytes()[i - 1] == b'\r' => LineEnding::Crlf,
            _ => LineEnding::Lf,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            LineEnding::Lf => "\n",
            LineEnding::Crlf => "\r\n",
        }
    }
}

/// Lower-cased keyword of a config line, or `None` for blank/comment lines.
/// Mirrors the parser's tokenisation so the two agree on what a "directive"
/// and a "Host"/"Match" line are.
fn line_keyword(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let end = trimmed
        .find(|c: char| c.is_whitespace() || c == '=')
        .unwrap_or(trimmed.len());
    let kw = &trimmed[..end];
    if kw.is_empty() {
        None
    } else {
        Some(kw.to_ascii_lowercase())
    }
}

/// The single pattern of a `Host` line, IF the line names exactly one
/// editable target. Returns `None` for non-Host lines, multi-pattern lines,
/// or a negation pattern (`!secret`). A wildcard pattern (`*.example.com`,
/// `web?`) IS returned — those are editable connection rules ProcMix can
/// locate and rewrite/delete in place.
fn host_line_single_alias(line: &str) -> Option<String> {
    if line_keyword(line).as_deref() != Some("host") {
        return None;
    }
    // Strip the `Host` keyword and its separator, then split the remainder.
    let trimmed = line.trim();
    let after = &trimmed[4..]; // safe: keyword was exactly "host" (4 bytes)
    let after = after.trim_start().trim_start_matches('=').trim_start();
    let mut patterns = after.split_whitespace();
    let first = patterns.next()?;
    if patterns.next().is_some() {
        return None; // multiple patterns → not a single-pattern block
    }
    if first.starts_with('!') {
        return None; // negation → not an editable target
    }
    Some(first.to_string())
}

/// Index range `[start, end)` of the block whose `Host` line names exactly
/// `alias` (case-insensitive). `start` is the `Host` line; `end` is the line
/// index of the next top-level `Host`/`Match`, or `lines.len()` at EOF.
fn find_block(lines: &[&str], alias: &str) -> Option<(usize, usize)> {
    let target = alias.to_ascii_lowercase();
    let mut start = None;
    for (i, line) in lines.iter().enumerate() {
        if let Some(found) = host_line_single_alias(line) {
            if found.to_ascii_lowercase() == target {
                start = Some(i);
                break;
            }
        }
    }
    let start = start?;

    // Scan for the next block-introducing line after start.
    let mut end = lines.len();
    for (i, line) in lines.iter().enumerate().skip(start + 1) {
        match line_keyword(line).as_deref() {
            Some("host") | Some("match") => {
                end = i;
                break;
            }
            _ => {}
        }
    }
    Some((start, end))
}

/// Index of the first line of the block's **leading comment** — the run of
/// contiguous comment lines (`#…`) immediately above the `Host` line at
/// `host_idx`, with NO blank line separating them from it. Such a comment
/// describes the block, so it should be removed together with the block on a
/// delete. Returns `host_idx` itself when there is no attached comment.
///
/// A blank line BETWEEN a comment and the `Host` line detaches the comment
/// (it then reads as a free-standing/file-level comment) and is left intact.
fn leading_comment_start(lines: &[&str], host_idx: usize) -> usize {
    let mut start = host_idx;
    while start > 0 {
        let prev = lines[start - 1].trim();
        if prev.starts_with('#') {
            start -= 1;
        } else {
            // Stop at the first non-comment line (blank line included → the
            // comment above the blank is NOT attached to this block).
            break;
        }
    }
    start
}

/// The leading-whitespace string of a line (its indentation).
fn indent_of(line: &str) -> &str {
    let end = line
        .find(|c: char| !c.is_whitespace())
        .unwrap_or(line.len());
    &line[..end]
}

/// Choose the indentation to use for directive lines in a block, inferred
/// from the block's existing directive lines; defaults to four spaces (the
/// conventional ssh_config indent) when the block has no directives yet.
fn block_indent(block_lines: &[&str]) -> String {
    for line in block_lines.iter().skip(1) {
        if line_keyword(line).is_some() {
            return indent_of(line).to_string();
        }
    }
    "    ".to_string()
}

/// Render one directive line, quoting the value if it contains whitespace
/// (so an `IdentityFile` path with spaces round-trips through the parser).
fn directive_line(indent: &str, keyword: &str, value: &str) -> String {
    let needs_quotes = value.chars().any(char::is_whitespace);
    if needs_quotes {
        format!("{indent}{keyword} \"{value}\"")
    } else {
        format!("{indent}{keyword} {value}")
    }
}

/// Build the directive lines for an edit, in canonical order. Only fields
/// that are `Some` produce a line.
fn render_directives(edit: &HostEdit, indent: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(v) = &edit.host_name {
        out.push(directive_line(indent, "HostName", v));
    }
    if let Some(v) = &edit.user {
        out.push(directive_line(indent, "User", v));
    }
    if let Some(p) = edit.port {
        out.push(directive_line(indent, "Port", &p.to_string()));
    }
    if let Some(v) = &edit.identity_file {
        out.push(directive_line(indent, "IdentityFile", v));
    }
    out
}

/// Insert or replace the host block named by `edit.alias`.
///
/// * If a block with that exact single-literal alias exists, its modelled
///   directive lines are rewritten **in place** (preserving the block's
///   `Host` line, indentation, comments, blank lines and any unknown
///   directives the caller's gating allowed through), and the rendered
///   directives replace the previous modelled lines.
/// * If no such block exists, a new one is appended at EOF.
///
/// Returns the new file text. Non-target blocks are never touched.
pub fn upsert_block(text: &str, edit: &HostEdit) -> String {
    // No rename: locate the block by the same alias we'll write.
    upsert_block_locating(text, &edit.alias, edit)
}

/// Like [`upsert_block`], but locates the existing block by `locate_alias`
/// (which may differ from `edit.alias`). This is how a **rename** preserves
/// position: we find the OLD block and rewrite it where it sits, replacing its
/// `Host` line with the new alias — instead of deleting it and appending a new
/// block at EOF (which would move the host to the bottom of the file).
///
/// If no block named `locate_alias` exists, a new block (using `edit.alias`)
/// is appended at EOF, exactly like a create.
pub fn upsert_block_locating(text: &str, locate_alias: &str, edit: &HostEdit) -> String {
    let ending = LineEnding::detect(text);
    let had_trailing_newline = text.ends_with('\n');
    // Split on '\n' and strip a trailing '\r' so CRLF files round-trip.
    let raw_lines: Vec<&str> = text.split('\n').collect();
    let lines: Vec<&str> = raw_lines
        .iter()
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();

    // `split('\n')` on a trailing-newline file yields a final empty element;
    // drop it so we don't treat the phantom line as content.
    let lines: Vec<&str> = if had_trailing_newline && lines.last() == Some(&"") {
        lines[..lines.len() - 1].to_vec()
    } else {
        lines
    };

    let new_lines: Vec<String> = match find_block(&lines, locate_alias) {
        Some((start, end)) => rewrite_existing(&lines, start, end, edit),
        None => append_new(&lines, edit),
    };

    let joined = new_lines.join(ending.as_str());
    if had_trailing_newline {
        format!("{joined}{}", ending.as_str())
    } else {
        joined
    }
}

/// Rewrite the modelled directives of an existing block in place. The block's
/// `Host` line is regenerated from `edit.alias` (preserving the original
/// line's leading indentation), so a rename keeps the block's position while
/// updating the alias.
fn rewrite_existing(lines: &[&str], start: usize, end: usize, edit: &HostEdit) -> Vec<String> {
    let block = &lines[start..end];
    let indent = block_indent(block);
    let rendered = render_directives(edit, &indent);

    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    // Lines before the block, verbatim.
    out.extend(lines[..start].iter().map(|s| s.to_string()));

    // Keep the original `Host` line VERBATIM when the alias is unchanged (so a
    // same-alias edit never alters keyword casing or spacing the user chose).
    // On a rename, regenerate the line with the new alias, preserving only the
    // original leading indentation.
    let existing_alias = host_line_single_alias(block[0]);
    let alias_changed = existing_alias.as_deref() != Some(edit.alias.as_str());
    if alias_changed {
        let host_indent = indent_of(block[0]);
        out.push(format!("{host_indent}Host {}", edit.alias));
    } else {
        out.push(block[0].to_string());
    }

    // Walk the block body: drop every MODELLED directive line (we'll re-emit
    // them in canonical order), keep everything else (comments, blanks,
    // unknown directives) verbatim and in place.
    let mut trailing: Vec<String> = Vec::new();
    for line in &block[1..] {
        let is_modelled = line_keyword(line)
            .map(|kw| matches!(kw.as_str(), "hostname" | "user" | "port" | "identityfile"))
            .unwrap_or(false);
        if !is_modelled {
            trailing.push(line.to_string());
        }
    }

    // Emit the new directives right after the Host line, then the preserved
    // non-modelled lines (comments/blanks/unknown). This keeps directives
    // grouped under their Host while never dropping a user's comment.
    for d in rendered {
        out.push(d);
    }
    out.extend(trailing);

    // Lines after the block, verbatim.
    out.extend(lines[end..].iter().map(|s| s.to_string()));
    out
}

/// Append a brand-new block at EOF.
fn append_new(lines: &[&str], edit: &HostEdit) -> Vec<String> {
    let indent = "    ";
    let mut out: Vec<String> = lines.iter().map(|s| s.to_string()).collect();

    // Separate from prior content with a single blank line, unless the file
    // is empty or already ends with a blank line.
    let needs_blank = out.iter().any(|l| !l.trim().is_empty())
        && out.last().map(|l| !l.trim().is_empty()).unwrap_or(false);
    if needs_blank {
        out.push(String::new());
    }

    out.push(format!("Host {}", edit.alias));
    out.extend(render_directives(edit, indent));
    out
}

/// Remove the block whose `Host` line names exactly `alias`.
///
/// Deletes from the `Host` line through the line before the next top-level
/// `Host`/`Match` (or EOF), then trims a single redundant blank line left
/// behind so the file doesn't accumulate gaps. Returns the new text; if no
/// such block exists the text is returned unchanged.
pub fn delete_block(text: &str, alias: &str) -> String {
    let ending = LineEnding::detect(text);
    let had_trailing_newline = text.ends_with('\n');
    let raw_lines: Vec<&str> = text.split('\n').collect();
    let lines: Vec<&str> = raw_lines
        .iter()
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();
    let lines: Vec<&str> = if had_trailing_newline && lines.last() == Some(&"") {
        lines[..lines.len() - 1].to_vec()
    } else {
        lines
    };

    let Some((host_start, end)) = find_block(&lines, alias) else {
        return text.to_string();
    };
    // Also remove the block's attached leading comment (the `# …` lines
    // directly above the `Host` line) so a deleted block doesn't orphan its
    // describing comment onto the next block.
    let start = leading_comment_start(&lines, host_start);

    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    out.extend(lines[..start].iter().map(|s| s.to_string()));

    // Skip [start, end). Then, to avoid a double blank line at the seam,
    // drop ONE leading blank line of the remainder if the kept prefix already
    // ends in a blank (or is empty).
    let prefix_ends_blank = out.last().map(|l| l.trim().is_empty()).unwrap_or(true);
    let drop_one_blank =
        prefix_ends_blank && lines.get(end).map(|l| l.trim().is_empty()).unwrap_or(false);
    let tail_start = if drop_one_blank { end + 1 } else { end };
    out.extend(lines[tail_start..].iter().map(|s| s.to_string()));

    let joined = out.join(ending.as_str());
    if had_trailing_newline && !joined.is_empty() {
        format!("{joined}{}", ending.as_str())
    } else {
        joined
    }
}

/// Re-validate, against the parser, that `text` declares `alias` as a single
/// **params-editable** host. The provider calls this AFTER an edit to
/// guarantee the result is well-formed and still owned by ProcMix (defence in
/// depth: never trust that an edit produced a parseable, editable block).
pub fn is_editable_after(text: &str, alias: &str) -> bool {
    let parsed = openssh_parse::parse(text);
    parsed
        .hosts
        .iter()
        .any(|h| h.name == alias && h.editable_params)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ssh::providers::openssh_parse;

    fn edit(alias: &str) -> HostEdit {
        HostEdit {
            alias: alias.to_string(),
            ..Default::default()
        }
    }

    // ----- upsert: new block -------------------------------------------------

    #[test]
    fn upsert_appends_new_block_to_empty_file() {
        let e = HostEdit {
            alias: "prod".into(),
            host_name: Some("prod.example.com".into()),
            user: Some("deploy".into()),
            port: Some(2222),
            identity_file: None,
        };
        let out = upsert_block("", &e);
        let parsed = openssh_parse::parse(&out);
        assert_eq!(parsed.hosts.len(), 1);
        let h = &parsed.hosts[0];
        assert_eq!(h.name, "prod");
        assert_eq!(h.host_name.as_deref(), Some("prod.example.com"));
        assert_eq!(h.user.as_deref(), Some("deploy"));
        assert_eq!(h.port, Some(2222));
        assert!(h.editable_params);
    }

    #[test]
    fn upsert_appends_after_existing_content_with_blank_separator() {
        let original = "Host existing\n    User u\n";
        let out = upsert_block(original, &{
            let mut e = edit("new");
            e.host_name = Some("new.example.com".into());
            e
        });
        // Original block is untouched.
        assert!(out.contains("Host existing"));
        assert!(out.contains("    User u"));
        // New block present and parseable.
        let parsed = openssh_parse::parse(&out);
        let names: Vec<&str> = parsed.hosts.iter().map(|h| h.name.as_str()).collect();
        assert!(names.contains(&"existing"));
        assert!(names.contains(&"new"));
        // A blank line separates the two blocks.
        assert!(out.contains("\n\nHost new"));
    }

    // ----- upsert: existing block --------------------------------------------

    #[test]
    fn upsert_updates_existing_directive_in_place() {
        let original = "Host prod\n    HostName old.example.com\n    User deploy\n";
        let mut e = edit("prod");
        e.host_name = Some("new.example.com".into());
        e.user = Some("deploy".into());
        let out = upsert_block(original, &e);

        let parsed = openssh_parse::parse(&out);
        let h = parsed.hosts.iter().find(|h| h.name == "prod").unwrap();
        assert_eq!(h.host_name.as_deref(), Some("new.example.com"));
        assert_eq!(h.user.as_deref(), Some("deploy"));
        // Only one prod block.
        assert_eq!(parsed.hosts.iter().filter(|h| h.name == "prod").count(), 1);
    }

    #[test]
    fn same_alias_edit_keeps_block_position() {
        // Editing the MIDDLE block must not move it to the bottom.
        let original = "Host a\n    User ua\n\nHost b\n    HostName old\n\nHost c\n    User uc\n";
        let mut e = edit("b");
        e.host_name = Some("new".into());
        let out = upsert_block(original, &e);

        let parsed = openssh_parse::parse(&out);
        let order: Vec<&str> = parsed.hosts.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(order, vec!["a", "b", "c"], "b must stay in the middle");
    }

    // ----- rename (locate by previous alias) ---------------------------------

    #[test]
    fn rename_keeps_block_position() {
        // Renaming the MIDDLE block must keep it in the middle, NOT append it
        // at EOF. This is the regression for the "edited host jumped to the
        // bottom of the file" bug.
        let original = "Host a\n    User ua\n\nHost b\n    HostName h\n\nHost c\n    User uc\n";
        let mut e = edit("b-renamed");
        e.host_name = Some("h".into());
        let out = upsert_block_locating(original, "b", &e);

        let parsed = openssh_parse::parse(&out);
        let order: Vec<&str> = parsed.hosts.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(
            order,
            vec!["a", "b-renamed", "c"],
            "renamed block must keep its position"
        );
        // Old alias gone, new alias present exactly once.
        assert!(!order.contains(&"b"));
        assert_eq!(order.iter().filter(|n| **n == "b-renamed").count(), 1);
    }

    #[test]
    fn rename_preserves_surrounding_comments() {
        let original =
            "# top\nHost a\n    User ua\n\n# keep this\nHost b\n    HostName h\n\nHost c\n    User uc\n";
        let mut e = edit("b2");
        e.host_name = Some("h".into());
        let out = upsert_block_locating(original, "b", &e);

        assert!(out.contains("# top"));
        assert!(
            out.contains("# keep this"),
            "the renamed block's lead comment survives"
        );
        let parsed = openssh_parse::parse(&out);
        let order: Vec<&str> = parsed.hosts.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(order, vec!["a", "b2", "c"]);
    }

    #[test]
    fn rename_to_missing_locate_appends_like_create() {
        // If the locate alias doesn't exist, behave like a create (append).
        let original = "Host a\n    User ua\n";
        let mut e = edit("brand-new");
        e.host_name = Some("h".into());
        let out = upsert_block_locating(original, "ghost", &e);

        let parsed = openssh_parse::parse(&out);
        let order: Vec<&str> = parsed.hosts.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(order, vec!["a", "brand-new"]);
    }

    #[test]
    fn upsert_adds_a_missing_directive_to_existing_block() {
        let original = "Host prod\n    HostName h\n";
        let mut e = edit("prod");
        e.host_name = Some("h".into());
        e.port = Some(22);
        let out = upsert_block(original, &e);
        let parsed = openssh_parse::parse(&out);
        let h = parsed.hosts.iter().find(|h| h.name == "prod").unwrap();
        assert_eq!(h.port, Some(22));
    }

    #[test]
    fn upsert_removes_a_directive_when_field_is_none() {
        let original = "Host prod\n    HostName h\n    Port 2222\n";
        let mut e = edit("prod");
        e.host_name = Some("h".into());
        // port left None → the Port line must be dropped.
        let out = upsert_block(original, &e);
        let parsed = openssh_parse::parse(&out);
        let h = parsed.hosts.iter().find(|h| h.name == "prod").unwrap();
        assert_eq!(h.port, None);
        assert!(!out.contains("Port"));
    }

    #[test]
    fn upsert_preserves_comments_inside_the_block() {
        let original = "Host prod\n    # keep me\n    HostName old\n";
        let mut e = edit("prod");
        e.host_name = Some("new".into());
        let out = upsert_block(original, &e);
        assert!(out.contains("# keep me"), "in-block comment must survive");
        let parsed = openssh_parse::parse(&out);
        let h = parsed.hosts.iter().find(|h| h.name == "prod").unwrap();
        assert_eq!(h.host_name.as_deref(), Some("new"));
    }

    #[test]
    fn upsert_does_not_touch_other_blocks_or_leading_comments() {
        let original =
            "# top comment\nHost a\n    User ua\n\nHost prod\n    HostName old\n\nHost b\n    User ub\n";
        let mut e = edit("prod");
        e.host_name = Some("new".into());
        let out = upsert_block(original, &e);
        assert!(out.contains("# top comment"));
        assert!(out.contains("Host a"));
        assert!(out.contains("    User ua"));
        assert!(out.contains("Host b"));
        assert!(out.contains("    User ub"));
    }

    #[test]
    fn upsert_preserves_tab_indentation_of_existing_block() {
        let original = "Host prod\n\tHostName old\n";
        let mut e = edit("prod");
        e.host_name = Some("new".into());
        e.user = Some("u".into());
        let out = upsert_block(original, &e);
        // New lines should use the block's existing tab indent.
        assert!(out.contains("\tHostName new"));
        assert!(out.contains("\tUser u"));
    }

    #[test]
    fn upsert_quotes_identity_file_with_spaces() {
        let mut e = edit("prod");
        e.identity_file = Some("/path/with space/id".into());
        let out = upsert_block("", &e);
        assert!(out.contains("IdentityFile \"/path/with space/id\""));
        let parsed = openssh_parse::parse(&out);
        let h = parsed.hosts.iter().find(|h| h.name == "prod").unwrap();
        assert_eq!(h.identity_file.as_deref(), Some("/path/with space/id"));
    }

    #[test]
    fn upsert_is_case_insensitive_on_alias_match() {
        let original = "host PROD\n    HostName old\n";
        let mut e = edit("prod");
        e.host_name = Some("new".into());
        let out = upsert_block(original, &e);
        // Must update the existing block, not append a second one.
        assert_eq!(out.matches("HostName").count(), 1);
        assert!(out.contains("HostName new"));
    }

    #[test]
    fn upsert_does_not_target_a_wildcard_block_with_same_text() {
        // A wildcard block must never be matched as the target; editing
        // alias "web" with a "Host web*" present should APPEND a new block.
        let original = "Host web*\n    User ci\n";
        let mut e = edit("web");
        e.user = Some("me".into());
        let out = upsert_block(original, &e);
        assert!(out.contains("Host web*"));
        assert!(out.contains("    User ci"));
        // A distinct literal block was appended; the wildcard block is left
        // as its own separate entry (both happen to be params-editable now,
        // but the point is they are DISTINCT blocks).
        let parsed = openssh_parse::parse(&out);
        assert!(parsed.hosts.iter().any(|h| h.name == "web"));
        assert!(parsed.hosts.iter().any(|h| h.name == "web*"));
        assert_eq!(parsed.hosts.iter().filter(|h| h.name == "web").count(), 1);
    }

    // ----- line endings ------------------------------------------------------

    #[test]
    fn upsert_preserves_crlf_line_endings() {
        let original = "Host prod\r\n    HostName old\r\n";
        let mut e = edit("prod");
        e.host_name = Some("new".into());
        let out = upsert_block(original, &e);
        assert!(out.contains("\r\n"), "CRLF must be preserved");
        assert!(!out.contains("\n\n") || out.contains("\r\n\r\n"));
        let parsed = openssh_parse::parse(&out);
        let h = parsed.hosts.iter().find(|h| h.name == "prod").unwrap();
        assert_eq!(h.host_name.as_deref(), Some("new"));
    }

    #[test]
    fn upsert_preserves_trailing_newline_presence() {
        let with_nl = upsert_block("Host prod\n    HostName h\n", &{
            let mut e = edit("prod");
            e.host_name = Some("h2".into());
            e
        });
        assert!(with_nl.ends_with('\n'));

        let without_nl = upsert_block("Host prod\n    HostName h", &{
            let mut e = edit("prod");
            e.host_name = Some("h2".into());
            e
        });
        assert!(!without_nl.ends_with('\n'));
    }

    // ----- delete ------------------------------------------------------------

    #[test]
    fn delete_removes_only_the_target_block() {
        let original =
            "Host a\n    User ua\n\nHost prod\n    HostName h\n    User deploy\n\nHost b\n    User ub\n";
        let out = delete_block(original, "prod");
        let parsed = openssh_parse::parse(&out);
        let names: Vec<&str> = parsed.hosts.iter().map(|h| h.name.as_str()).collect();
        assert!(!names.contains(&"prod"));
        assert!(names.contains(&"a"));
        assert!(names.contains(&"b"));
        assert!(out.contains("    User ua"));
        assert!(out.contains("    User ub"));
    }

    #[test]
    fn delete_removes_the_blocks_attached_leading_comment() {
        // A comment DIRECTLY above the Host line (no blank between) describes
        // that block and must be removed with it — otherwise it orphans onto
        // the next block.
        let original = "# describes prod\nHost prod\n    HostName h\nHost keep\n    User k\n";
        let out = delete_block(original, "prod");
        assert!(
            !out.contains("# describes prod"),
            "attached comment removed"
        );
        assert!(!out.contains("Host prod"));
        assert!(out.contains("Host keep"));
    }

    #[test]
    fn delete_keeps_a_comment_detached_by_a_blank_line() {
        // A comment separated from the Host line by a blank line is NOT
        // attached (it reads as a free-standing/file-level comment) and stays.
        let original = "# file header\n\nHost prod\n    HostName h\n\nHost keep\n    User k\n";
        let out = delete_block(original, "prod");
        assert!(out.contains("# file header"), "detached comment preserved");
        assert!(!out.contains("Host prod"));
        assert!(out.contains("Host keep"));
    }

    #[test]
    fn delete_removes_a_multi_line_attached_comment() {
        let original =
            "Host a\n    User ua\n\n# line one\n# line two\nHost prod\n    HostName h\n\nHost keep\n    User k\n";
        let out = delete_block(original, "prod");
        assert!(!out.contains("# line one"));
        assert!(!out.contains("# line two"));
        let parsed = openssh_parse::parse(&out);
        let order: Vec<&str> = parsed.hosts.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(order, vec!["a", "keep"]);
    }

    #[test]
    fn delete_of_missing_alias_is_a_noop() {
        let original = "Host prod\n    HostName h\n";
        let out = delete_block(original, "does-not-exist");
        assert_eq!(out, original);
    }

    #[test]
    fn delete_does_not_collapse_into_a_double_blank_line() {
        let original = "Host a\n    User ua\n\nHost prod\n    User p\n\nHost b\n    User ub\n";
        let out = delete_block(original, "prod");
        // No triple newline (double blank) should be left at the seam.
        assert!(!out.contains("\n\n\n"));
        let parsed = openssh_parse::parse(&out);
        assert_eq!(parsed.hosts.len(), 2);
    }

    #[test]
    fn delete_last_block_leaves_prior_content_intact() {
        let original = "Host keep\n    User k\n\nHost prod\n    User p\n";
        let out = delete_block(original, "prod");
        let parsed = openssh_parse::parse(&out);
        assert_eq!(parsed.hosts.len(), 1);
        assert_eq!(parsed.hosts[0].name, "keep");
    }

    #[test]
    fn delete_does_not_match_a_wildcard_block() {
        let original = "Host web*\n    User ci\n";
        let out = delete_block(original, "web");
        // "web" is not the wildcard alias "web*", so nothing is removed.
        assert_eq!(out, original);
    }

    // ----- round-trip safety -------------------------------------------------

    #[test]
    fn is_editable_after_confirms_a_clean_upsert() {
        let mut e = edit("prod");
        e.host_name = Some("h".into());
        let out = upsert_block("", &e);
        assert!(is_editable_after(&out, "prod"));
    }

    #[test]
    fn upsert_then_delete_returns_to_parseable_empty() {
        let mut e = edit("prod");
        e.host_name = Some("h".into());
        let added = upsert_block("", &e);
        let removed = delete_block(&added, "prod");
        let parsed = openssh_parse::parse(&removed);
        assert!(parsed.hosts.iter().all(|h| h.name != "prod"));
    }
}
