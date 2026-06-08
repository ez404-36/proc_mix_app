// Detect possible duplicates between commands being imported and the
// commands already in the user's library.
//
// Two kinds of collision matter, and they are treated differently downstream:
//   - "name": the imported command's NAME matches an existing one (regardless
//     of script). The user resolves this — keep it with a new name, or skip.
//   - "script": only the SCRIPT matches while the name differs. This is just a
//     heads-up; the command always imports as a new copy (no action offered).
//
// A name match outranks a script-only match: if any existing command shares
// the name, the result is `kind: "name"` even when a different command shares
// the script. Matching is case-insensitive and whitespace-trimmed so trivially
// different spellings ("Deploy" vs "deploy ") are still flagged. Matching by
// name/script (not id) is intentional: imported records always carry fresh
// ids, so an id comparison would never flag a re-imported command.

import type { Command } from "../types";
import type { ExportedCommand } from "./dataTransfer";

/** How an imported command collides with an existing library command. */
export type DuplicateKind = "name" | "script";

/** Why an import candidate was flagged, plus the existing command it hit. */
export interface DuplicateMatch {
  kind: DuplicateKind;
  /** The existing library command the import collides with. */
  existing: Command;
}

/** Case-insensitive, whitespace-trimmed comparison key. */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Find the existing library command that an imported command collides with,
 * or `null` if none. A name collision is preferred over a script-only one
 * (it is the stronger, user-actionable signal).
 */
export function findDuplicate(
  candidate: Pick<ExportedCommand, "name" | "script">,
  existing: ReadonlyArray<Command>,
): DuplicateMatch | null {
  const name = normalize(candidate.name);
  const script = normalize(candidate.script);

  let scriptOnly: DuplicateMatch | null = null;
  for (const cmd of existing) {
    if (name.length > 0 && normalize(cmd.name) === name) {
      return { kind: "name", existing: cmd };
    }
    // Remember the first script-only collision in case nothing matches by name.
    if (
      scriptOnly === null &&
      script.length > 0 &&
      normalize(cmd.script) === script
    ) {
      scriptOnly = { kind: "script", existing: cmd };
    }
  }
  return scriptOnly;
}

/**
 * Build an `importedCommandId → DuplicateMatch` map for every imported
 * command that collides with the existing library. Imported commands absent
 * from the map have no collision and import cleanly.
 */
export function findImportDuplicates(
  candidates: ReadonlyArray<ExportedCommand>,
  existing: ReadonlyArray<Command>,
): Map<string, DuplicateMatch> {
  const out = new Map<string, DuplicateMatch>();
  for (const candidate of candidates) {
    const match = findDuplicate(candidate, existing);
    if (match !== null) out.set(candidate.id, match);
  }
  return out;
}
