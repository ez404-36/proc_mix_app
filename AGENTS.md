# AGENTS.md

ProcMix is a Tauri 2 app: a **Rust** backend in `src-tauri/` and a **React +
TypeScript** frontend in `src/`. See [CONTRIBUTING.md](CONTRIBUTING.md) for
the development workflow (scripts, tests, benchmarks).

## Code comments

Comments explain **what the code does and why it does that now** — not how it
got that way.

- **1-2 lines.** A comment or JSDoc/doc-comment block should fit in one or two
  lines. A public API contract can run longer only when it documents the
  current behavior — never to narrate history.
- **State the invariant, not the story.** If a check looks redundant or a
  workaround looks arbitrary, say what it guards against in one line. Do not
  explain how the bug was found.

### Not allowed in code comments

- Contrasting past and present behavior ("previously...", "used to...", "no
  longer...", "not X anymore").
- Narrating a specific incident, observation, or bug investigation ("it was
  observed that...", "at runtime we noticed...", "this caused X to fail with
  error Y...").
- References to a specific bug report, ticket, or issue number as a stand-in
  for documentation.
- Multi-paragraph reasoning about why an alternative approach was rejected.

That context belongs in the commit message, PR description, `CHANGELOG.md`,
or an ADR — not in the source file.

### Example

Bad:

```ts
// Previously this ran on the non-elevated path, whose child has no TTY,
// so an inline `sudo` in the script died with "a terminal is required
// to read the password". We fixed this by routing it through the
// backend's `sudo -S` path instead, which feeds the password on stdin.
```

Good:

```ts
// Also elevates when the script itself invokes sudo/doas/pkexec,
// even if runAsAdmin is false.
```
