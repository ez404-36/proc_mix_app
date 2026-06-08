// Pure selection logic for the customizable export dialog.
//
// Two kinds of "checked":
//   - EXPLICIT  — the command/workflow the user ticked themselves.
//   - FORCED    — a command pulled in because a SELECTED workflow references
//                 it. Forced commands are always part of the export and are
//                 locked in the UI (checked + disabled) so the file stays
//                 self-consistent: a workflow can never be exported without
//                 the commands its nodes run.
//
// The two are tracked SEPARATELY (the dialog stores the user's explicit
// command checks + the selected workflow ids). The forced set and the final
// export set are DERIVED — so deselecting a workflow correctly releases a
// command that was only force-included, while one the user also ticked (or
// that another selected workflow still needs) stays in.

// These helpers operate on the SHAPE shared by full records and their
// definition-only export forms, so the same selection logic backs both the
// Export dialog (full `Command`/`Workflow`) and the Import dialog
// (`ExportedCommand`/`ExportedWorkflow`). Only the id and the workflow's node
// command references are ever read here.

/** Anything with a stable id (a `Command` or an `ExportedCommand`). */
export interface SelectableCommand {
  id: string;
}

/** A workflow's node, of which only the optional `commandId` is read. */
interface SelectableNode {
  commandId?: string;
}

/** Anything with an id and command-referencing nodes (full or exported). */
export interface SelectableWorkflow {
  id: string;
  nodes: ReadonlyArray<SelectableNode>;
}

/**
 * Return a NEW set with `id` toggled (added if absent, removed if present).
 * Pure — never mutates the input — so it is safe to use directly in a React
 * state updater. Shared by every checkbox toggle in the selection tree.
 */
export function toggleInSet(
  set: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Unique `commandId`s referenced by a workflow's nodes (in encounter order). */
export function collectWorkflowCommandIds(workflow: SelectableWorkflow): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const node of workflow.nodes) {
    const id = node.commandId;
    if (id !== undefined && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Union of the command ids required by every selected workflow. These are the
 * commands the export MUST include (and the dialog locks).
 */
export function computeForcedCommandIds(
  selectedWorkflowIds: ReadonlySet<string>,
  workflows: ReadonlyArray<SelectableWorkflow>,
): Set<string> {
  const forced = new Set<string>();
  for (const wf of workflows) {
    if (!selectedWorkflowIds.has(wf.id)) continue;
    for (const id of collectWorkflowCommandIds(wf)) {
      forced.add(id);
    }
  }
  return forced;
}

/** Whether a command is locked (force-included by a selected workflow). */
export function isCommandLocked(
  commandId: string,
  forcedCommandIds: ReadonlySet<string>,
): boolean {
  return forcedCommandIds.has(commandId);
}

/** The user's raw selection — explicit ticks, kept distinct from forced. */
export interface ExportSelectionInput {
  /** Commands the user explicitly ticked. */
  checkedCommandIds: ReadonlySet<string>;
  /** Workflows the user ticked. */
  checkedWorkflowIds: ReadonlySet<string>;
  /** The full workflow list, needed to resolve forced command dependencies. */
  workflows: ReadonlyArray<SelectableWorkflow>;
}

/** The resolved set of ids that will actually be written to the file. */
export interface ResolvedExportSelection {
  commandIds: Set<string>;
  workflowIds: Set<string>;
}

/**
 * Resolve the final export selection: every selected workflow, plus the
 * union of (explicitly-checked commands) and (commands forced by those
 * workflows). Forced commands are always present even if the user never
 * ticked them.
 */
export function resolveExportSelection(
  input: ExportSelectionInput,
): ResolvedExportSelection {
  const forced = computeForcedCommandIds(input.checkedWorkflowIds, input.workflows);
  const commandIds = new Set<string>(input.checkedCommandIds);
  for (const id of forced) commandIds.add(id);
  return {
    commandIds,
    workflowIds: new Set<string>(input.checkedWorkflowIds),
  };
}

/**
 * Map the resolved id sets back to the concrete records to hand to
 * `exportData`. Order follows the input arrays so the file is stable.
 */
export function selectExportRecords<
  C extends SelectableCommand,
  W extends SelectableWorkflow,
>(
  selection: ResolvedExportSelection,
  commands: ReadonlyArray<C>,
  workflows: ReadonlyArray<W>,
): { commands: C[]; workflows: W[] } {
  return {
    commands: commands.filter((c) => selection.commandIds.has(c.id)),
    workflows: workflows.filter((w) => selection.workflowIds.has(w.id)),
  };
}
