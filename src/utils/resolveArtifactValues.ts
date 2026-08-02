// DISPLAY-TEXT resolution for Mini-App artifact references.
//
// The Rust executor performs the actual `${name}` substitution on script /
// args / workingDir / env VALUES (see `core/parser.rs`) before spawning a
// child. The frontend NEVER substitutes those — it only builds a
// `Record<string,string>` (artifact values) and routes it through
// `RunOptions.variableValues`.
//
// This module exists for the *display* side only: widget labels, artifact
// values shown to the user, and anything else that is rendered (never
// executed). It mirrors the Rust grammar (`${name}`, `${name:default}`,
// `$$` → `$`) but ONLY replaces tokens whose name is a known artifact
// (`artifactNames`). A token that names a command variable (not an
// artifact) is left verbatim — those are resolved by Rust at run time.
//
// Grammar (matches `core/parser.rs::substitute`):
//   reference       := "${" name [":" inline_default] "}"
//   name            := [A-Za-z_][A-Za-z0-9_]*
//   inline_default  := any character except "}", including empty
//   escape          := "$$"   → literal "$"
//
// Resolution for an artifact token:
//   `${name}`             → `values.get(name) ?? ""`
//   `${name:default}`     → `values.get(name) ?? default`
// A non-artifact `${...}` token (or a malformed one) is emitted verbatim.

/**
 * Test whether a code unit is a valid identifier START char (`[A-Za-z_]`).
 * Mirrors the Rust `scan_name` first-char check. Operates on a UTF-16 code
 * unit, which is safe because the identifier alphabet is pure ASCII.
 */
function isNameStart(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x5f // _
  );
}

/**
 * Test whether a code unit is a valid identifier CONTINUATION char
 * (`[A-Za-z0-9_]`). Mirrors the Rust `scan_name` loop body.
 */
function isNamePart(code: number): boolean {
  return (
    isNameStart(code) ||
    (code >= 0x30 && code <= 0x39) // 0-9
  );
}

/**
 * Replace `${name}` tokens that name a known artifact with their current
 * values. Tokens that name something else (a command variable) or are
 * malformed are left UNCHANGED — display text is rendered verbatim so the
 * user sees what they wrote, and command-variable substitution is the
 * Rust executor's job at run time.
 *
 * @param text - the display text containing possible `${artifactName}` references
 * @param values - current artifact values keyed by artifact name
 * @param artifactNames - the set of names that ARE artifacts (used to distinguish
 *   from command variables, which share the same `${name}` syntax but are
 *   resolved by Rust)
 * @returns the text with artifact references replaced; non-artifact and
 *   malformed `${...}` tokens left verbatim
 */
export function resolveArtifactValues(
  text: string,
  values: ReadonlyMap<string, string>,
  artifactNames: ReadonlySet<string>,
): string {
  const len = text.length;
  let out = "";
  // `spanStart` marks the first un-flushed character; literal spans are
  // appended whenever we hit a special sequence, then we resume after it.
  let spanStart = 0;
  let i = 0;
  while (i < len) {
    if (text.charCodeAt(i) !== 0x24 /* $ */) {
      i += 1;
      continue;
    }
    // Reached a `$`. Flush any pending literal span before deciding how to
    // handle the sequence.
    if (i > spanStart) out += text.slice(spanStart, i);

    const next = i + 1 < len ? text.charCodeAt(i + 1) : -1;
    if (next === 0x24 /* $ */) {
      // `$$` → literal `$`.
      out += "$";
      i += 2;
      spanStart = i;
      continue;
    }
    if (next === 0x7b /* { */) {
      // `${ ...`. Find the name and the closing `}`.
      const tokenStart = i;
      const nameStart = i + 2;
      // Mirrors `scan_name`: first char must be a name-start, then zero or
      // more name-part chars.
      let nameEnd = nameStart;
      if (nameStart < len && isNameStart(text.charCodeAt(nameStart))) {
        nameEnd = nameStart + 1;
        while (nameEnd < len && isNamePart(text.charCodeAt(nameEnd))) {
          nameEnd += 1;
        }
      }
      if (nameEnd > nameStart && nameEnd < len) {
        const name = text.slice(nameStart, nameEnd);
        const terminator = text.charCodeAt(nameEnd);
        if (terminator === 0x7d /* } */) {
          // `${name}` — bare reference.
          if (artifactNames.has(name)) {
            out += values.get(name) ?? "";
          } else {
            out += text.slice(tokenStart, nameEnd + 1);
          }
          i = nameEnd + 1;
          spanStart = i;
          continue;
        }
        if (terminator === 0x3a /* : */) {
          // `${name:default}` — inline default. Find the closing `}` (any
          // char except `}` may appear in the default body, including empty).
          let k = nameEnd + 1;
          while (k < len && text.charCodeAt(k) !== 0x7d) k += 1;
          if (k < len) {
            if (artifactNames.has(name)) {
              const supplied = values.get(name);
              out += supplied !== undefined
                ? supplied
                : text.slice(nameEnd + 1, k);
            } else {
              out += text.slice(tokenStart, k + 1);
            }
            i = k + 1;
            spanStart = i;
            continue;
          }
          // Unterminated `${name:...` — fall through to lone-`$` handling
          // so the rest of the string is emitted verbatim.
        }
      }
      // Malformed `${...}` (empty name, name starting with a digit, missing
      // closing `}`, etc.). Emit just the `$` and advance one char; the
      // remaining `{...}` characters pass through as a literal span on
      // subsequent iterations, so the malformed token is left unchanged.
    }
    // Lone `$` (end of input, followed by neither `$` nor `{`, or a
    // `${...}` that did not parse cleanly). Treat as a literal so
    // `echo $PATH` round-trips verbatim — mirrors the Rust parser.
    out += "$";
    i += 1;
    spanStart = i;
  }
  // Flush the trailing literal span.
  if (spanStart < len) out += text.slice(spanStart);
  return out;
}
