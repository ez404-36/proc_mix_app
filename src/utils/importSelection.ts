// Pure resolution of the user's import choices into an `ImportSelection`.
//
// The Import dialog gathers raw input — which commands/workflows are ticked,
// which commands are forced by a selected workflow, which ticked commands
// collide with the library, and the per-name-duplicate choice. Turning that
// into the final selection is DOMAIN POLICY, not presentation, so it lives
// here as a tested pure function rather than inside the component.
//
// Policy rules (importing NEVER overwrites an existing command — a shared file
// must not be able to clobber a command a workflow depends on):
//   - A non-duplicate command imports as a new copy.
//   - A "script"-only collision (same script, different name) is informational
//     — the command still imports as a new copy; no choice is offered.
//   - A "name" collision is the user's call:
//       * "rename" (default) → import as a copy under a fresh, unique name so
//         both the original and the import survive;
//       * "skip" → drop it, UNLESS a selected workflow depends on it (forced).
//         A forced "skip" can't drop the command (that would unbind the node),
//         so it falls back to "rename".

import type { DuplicateMatch } from "./importDuplicates";

/** What to do with a checked command whose NAME duplicates an existing one. */
export type DuplicateChoice = "rename" | "skip";

/**
 * The resolved import plan handed to `applyImport`:
 *   - `commandIds` / `workflowIds`: the subset to import.
 *   - `rename`: imported command id → the new, unique name it should be
 *     created under (only for name-duplicates resolved to "rename").
 */
export interface ImportSelection {
  commandIds: ReadonlySet<string>;
  workflowIds: ReadonlySet<string>;
  rename: ReadonlyMap<string, string>;
}

/** Minimal view of an importable command the policy needs. */
export interface ResolveImportCommand {
  id: string;
  name: string;
}

export interface ResolveImportInput {
  /** Commands the user resolved to import (already includes forced ones). */
  commands: ReadonlyArray<ResolveImportCommand>;
  /** Workflows the user resolved to import. */
  workflowIds: ReadonlyArray<string>;
  /** Command ids force-included by a selected workflow (cannot be skipped). */
  forcedCommandIds: ReadonlySet<string>;
  /** Imported command id → its duplicate match, for flagged commands only. */
  duplicates: ReadonlyMap<string, DuplicateMatch>;
  /** Imported command id → the user's rename/skip choice for a name-duplicate. */
  choiceFor: (commandId: string) => DuplicateChoice;
  /** Names already present in the library (used to mint a unique rename). */
  existingNames: ReadonlyArray<string>;
}

/** Case-insensitive, trimmed key for name-uniqueness checks. */
function nameKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Produce a name based on `base` that does not collide (case-insensitively)
 * with any name in `taken`: "Deploy" → "Deploy (2)" → "Deploy (3)" … The
 * `taken` set is mutated to include the result so repeated calls within one
 * import stay unique relative to each other too.
 */
function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(nameKey(base))) {
    taken.add(nameKey(base));
    return base;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${base} (${n})`;
    if (!taken.has(nameKey(candidate))) {
      taken.add(nameKey(candidate));
      return candidate;
    }
  }
}

/**
 * Apply the import policy (see module docs) to the user's raw choices,
 * producing the final {@link ImportSelection}.
 */
export function resolveImportSelection(
  input: ResolveImportInput,
): ImportSelection {
  const commandIds = new Set<string>();
  const rename = new Map<string, string>();

  // Names already claimed: the whole library plus every name this import has
  // committed so far. Seeds `uniqueName` so two renamed imports never collide.
  const taken = new Set<string>(input.existingNames.map(nameKey));

  for (const cmd of input.commands) {
    const match = input.duplicates.get(cmd.id);

    // No collision, or a script-only collision → import as-is (new copy).
    if (match === undefined || match.kind === "script") {
      commandIds.add(cmd.id);
      continue;
    }

    // Name collision: rename (default) or skip.
    const choice = input.choiceFor(cmd.id);
    if (choice === "skip" && !input.forcedCommandIds.has(cmd.id)) {
      // Dropped — do NOT claim a name for it.
      continue;
    }
    // "rename", or a forced "skip" that falls back to rename.
    commandIds.add(cmd.id);
    rename.set(cmd.id, uniqueName(cmd.name, taken));
  }

  return {
    commandIds,
    workflowIds: new Set(input.workflowIds),
    rename,
  };
}
