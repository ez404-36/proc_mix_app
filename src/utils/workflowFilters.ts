import type { Workflow } from "../types";

/**
 * Whether a workflow matches the free-text query. Workflows are
 * user-authored, so their `name`/`description` are not run through the
 * seed-localization helper that commands use — they are matched verbatim.
 * Tags are matched case-insensitively, mirroring the command search. An
 * empty query matches everything.
 */
export function matchesWorkflowQuery(wf: Workflow, query: string): boolean {
  if (query.length === 0) return true;
  const q = query.toLowerCase();
  if (wf.name.toLowerCase().includes(q)) return true;
  if (wf.description && wf.description.toLowerCase().includes(q)) return true;
  if (wf.tags.some((tag) => tag.toLowerCase().includes(q))) return true;
  return false;
}
