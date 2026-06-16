import type { TFunction } from "i18next";
import type { Command } from "../types";
import { getCommandDescription, getCommandName } from "./commandLabels";

/**
 * Active filter selection for the Library Commands tab. All three
 * dimensions compose with AND between dimensions:
 *   - `query`    : free-text search over localized name/description/tags.
 *   - `tags`     : a command must carry at least ONE of the selected tags
 *                  (ANY semantics — see {@link filterCommands}). Empty
 *                  array means "no tag filter".
 *   - `category` : exact match on the command's `categoryId`. `undefined`
 *                  means "all categories" (no category filter).
 */
export interface CommandFilter {
  query: string;
  tags: string[];
  category?: string;
}

/**
 * Whether a command is global (shared library) — `scope` undefined or
 * `"global"`. The negation identifies workflow-private `"local"` commands.
 */
export function isGlobalCommand(cmd: Command): boolean {
  return cmd.scope === undefined || cmd.scope === "global";
}

/**
 * The subset of `commands` visible in the GLOBAL library: every command
 * except workflow-private `"local"` ones. Used by the Library Commands tab
 * (and its tag/category option derivation) so a local command never leaks
 * into the shared library or its filters.
 */
export function globalCommands(
  commands: ReadonlyArray<Command>,
): Command[] {
  return commands.filter(isGlobalCommand);
}

/**
 * The commands usable inside the editor for the workflow identified by
 * `workflowId`: every global command PLUS this workflow's own `"local"`
 * commands. Other workflows' local commands are excluded. When `workflowId`
 * is `null` (a brand-new, unsaved workflow), only global commands are
 * returned — a local command cannot be owned until the workflow has an id.
 */
export function commandsForWorkflowScope(
  commands: ReadonlyArray<Command>,
  workflowId: string | null,
): Command[] {
  return commands.filter(
    (cmd) =>
      isGlobalCommand(cmd) ||
      (workflowId !== null && cmd.workflowId === workflowId),
  );
}

/**
 * The `"local"` commands owned by the workflow identified by `workflowId`
 * — i.e. workflow-private commands, excluding every global command and any
 * other workflow's locals. Used by the editor palette's "Local commands"
 * section. Returns an empty array for a brand-new (unsaved) workflow
 * (`workflowId === null`), which cannot own a local command yet.
 */
export function localCommandsForWorkflow(
  commands: ReadonlyArray<Command>,
  workflowId: string | null,
): Command[] {
  if (workflowId === null) return [];
  return commands.filter(
    (cmd) => !isGlobalCommand(cmd) && cmd.workflowId === workflowId,
  );
}

/**
 * Normalize a tag list for persistence: trim each entry, drop empties,
 * and dedupe case-insensitively while PRESERVING the casing of the first
 * occurrence. Order is preserved (first-seen wins). Used by the command
 * form's tag editor so the stored `Command.tags` is always clean.
 */
export function normalizeTags(tags: ReadonlyArray<string>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

/**
 * Collect the unique set of tags used across `commands`, sorted
 * case-insensitively for stable display. Tags are compared by their
 * literal value (casing preserved as authored). Empty/whitespace-only
 * tags are ignored — they should never be persisted, but we defend
 * against stale data rather than surfacing a blank chip.
 */
export function collectTags(commands: ReadonlyArray<Command>): string[] {
  const seen = new Set<string>();
  for (const cmd of commands) {
    for (const tag of cmd.tags) {
      if (tag.trim() !== "") seen.add(tag);
    }
  }
  return [...seen].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

/**
 * Collect the unique set of category names in use across `commands`,
 * sorted case-insensitively. Commands without a category (`categoryId`
 * undefined or blank) contribute nothing.
 */
export function collectCategories(commands: ReadonlyArray<Command>): string[] {
  const seen = new Set<string>();
  for (const cmd of commands) {
    const cat = cmd.categoryId;
    if (cat !== undefined && cat.trim() !== "") seen.add(cat);
  }
  return [...seen].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

/**
 * Whether a command matches the free-text query. Matches against the
 * LOCALIZED name/description (so a user typing in their own language
 * finds seed commands by their translated label) and any tag,
 * case-insensitively. An empty query matches everything.
 */
function matchesQuery(cmd: Command, query: string, t: TFunction): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  if (getCommandName(cmd, t).toLowerCase().includes(q)) return true;
  const desc = getCommandDescription(cmd, t);
  if (desc && desc.toLowerCase().includes(q)) return true;
  if (cmd.tags.some((tag) => tag.toLowerCase().includes(q))) return true;
  return false;
}

/**
 * Filter `commands` by query + tags + category, composed with AND across
 * the three dimensions.
 *
 * Tag semantics are ANY (union): with one or more tags selected, a
 * command is kept when it carries AT LEAST ONE of them. This is the more
 * forgiving default — selecting two tags broadens rather than narrows,
 * matching how most tag filters behave. Tag comparison is
 * case-insensitive. Category is an exact (case-sensitive) match on
 * `categoryId`; `undefined`/empty category means no category constraint.
 */
export function filterCommands(
  commands: ReadonlyArray<Command>,
  filter: CommandFilter,
  t: TFunction,
): Command[] {
  const selectedTags = filter.tags
    .map((tag) => tag.toLowerCase())
    .filter((tag) => tag !== "");
  const category =
    filter.category !== undefined && filter.category.trim() !== ""
      ? filter.category
      : undefined;

  return commands.filter((cmd) => {
    if (!matchesQuery(cmd, filter.query, t)) return false;
    if (selectedTags.length > 0) {
      const cmdTags = cmd.tags.map((tag) => tag.toLowerCase());
      const hasAny = selectedTags.some((tag) => cmdTags.includes(tag));
      if (!hasAny) return false;
    }
    if (category !== undefined && cmd.categoryId !== category) return false;
    return true;
  });
}
