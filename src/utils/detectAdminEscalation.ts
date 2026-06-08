// Heuristic: does this user-authored script body already invoke an
// elevation tool (sudo, doas, pkexec) as its leading command?
//
// Used by the CommandForm to auto-tick the "Run as administrator"
// checkbox and by the execution boundary (`runCommand`) to route a
// `sudo …` script through the backend's `sudo -S` path. If the user's
// script escalates from the get-go, the command is going to need
// elevation regardless of the persisted flag, so we reflect that rather
// than letting it run on the non-elevated path (whose child has
// `Stdio::null()` stdin and no TTY — the inline `sudo` then dies with
// "a terminal is required to read the password").
//
// The leading-command parse is delegated to `parseLeadingCommand` in
// `utilityName.ts` — the SAME primitive the flag-hint feature uses — so
// the two can never disagree about what the first command is. That
// parser is intentionally conservative:
//   - Looks at the FIRST executable line only (ignores leading blank
//     lines, shebangs, and comments).
//   - Inspects only the FIRST command segment (everything up to the
//     first `&& || ; | &`), so a later-pipeline/compound `sudo` does
//     NOT count — those run their leading command unelevated and the
//     user made that choice deliberately; auto-wrapping the whole line
//     would silently elevate the unprivileged part too.
//   - Strips leading `NAME=value` env-assignments (so `FOO=1 sudo …`
//     is correctly recognised as escalation — the shell runs `sudo` as
//     the command there).
//   - On Windows there is no analogous inline-escalation convention
//     (`runas` / `Start-Process -Verb RunAs` are also legitimate non-
//     admin tools), so callers apply this only on Unix.
//
// The function is pure and platform-agnostic.

import { parseLeadingCommand } from "./utilityName";

/**
 * Returns true when the script's leading command (first executable
 * line, first command segment, after stripping `NAME=value` prefixes)
 * is a known inline-escalation tool (`sudo` / `doas` / `pkexec`).
 *
 * Handles:
 *
 *   #!/usr/bin/env bash
 *   # update package list
 *   FOO=1 sudo apt update      -> true
 *
 * Does NOT flag partial/late escalation, by design:
 *   - `echo y | sudo apt remove foo`  -> false (first command is echo)
 *   - `cd /tmp && sudo apt update`    -> false (first command is cd)
 *   - line 2 onward                   -> false (first action unelevated)
 *
 * The escalation-tool list lives in `utilityName.ts` (`ESCALATION_TOOLS`)
 * and is mirrored in the Rust `parse_utility_name`.
 */
export function detectAdminEscalation(script: string): boolean {
  return parseLeadingCommand(script)?.escalated ?? false;
}
