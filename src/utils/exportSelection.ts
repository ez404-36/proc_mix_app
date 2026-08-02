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
// Export dialog (full `Command`/`Workflow`/`MiniApp`) and the Import dialog
// (`ExportedCommand`/`ExportedWorkflow`/`ExportedMiniApp`). Only the id, the
// workflow's node command references, and the mini-app's widget command
// references are ever read here.

import type { MiniAppAction, MiniAppWidget, StatusSource } from "../types";

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
 * Anything with an id and command-referencing widgets (a `MiniApp` or an
 * `ExportedMiniApp` — both carry the identical `widgets` union, since the
 * export only strips per-install state).
 */
export interface SelectableMiniApp {
  id: string;
  widgets: ReadonlyArray<MiniAppWidget>;
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

/** The `commandId` a `commandRef` action points at, or `undefined` for inline. */
function actionCommandId(action: MiniAppAction): string | undefined {
  return action.kind === "commandRef" ? action.commandId : undefined;
}

/** The `commandId` a `commandRef` status source points at, or `undefined`. */
function statusSourceCommandId(source: StatusSource): string | undefined {
  return source.kind === "commandRef" ? source.commandId : undefined;
}

/**
 * Every `commandId` a single widget references — across its action(s) and any
 * status source. An inline action / inline status source references no
 * command, and an artifact widget references none at all. Unknown widget kinds
 * (a hand-edited or newer-version file) contribute nothing rather than
 * throwing, mirroring the importer's pass-through policy.
 */
function collectWidgetCommandIds(widget: MiniAppWidget): string[] {
  const out: string[] = [];
  const push = (id: string | undefined): void => {
    if (id !== undefined && id !== "") out.push(id);
  };
  switch (widget.kind) {
    case "button":
      push(actionCommandId(widget.action));
      break;
    case "toggle":
      push(actionCommandId(widget.onAction));
      push(actionCommandId(widget.offAction));
      if (widget.status !== undefined) {
        push(statusSourceCommandId(widget.status.source));
      }
      break;
    case "status":
      push(statusSourceCommandId(widget.source));
      break;
    case "artifact":
      break;
  }
  return out;
}

/** Unique `commandId`s referenced by a mini-app's widgets (encounter order). */
export function collectMiniAppCommandIds(miniapp: SelectableMiniApp): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const widget of miniapp.widgets) {
    for (const id of collectWidgetCommandIds(widget)) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

/**
 * Union of the command ids required by every selected workflow AND mini-app.
 * These are the commands the export MUST include (and the dialog locks) so the
 * file is always self-consistent: a workflow can never be exported without the
 * commands its nodes run, nor a mini-app without the commands its widgets
 * reference.
 */
export function computeForcedCommandIds(
  selectedWorkflowIds: ReadonlySet<string>,
  workflows: ReadonlyArray<SelectableWorkflow>,
  selectedMiniAppIds: ReadonlySet<string> = new Set(),
  miniapps: ReadonlyArray<SelectableMiniApp> = [],
): Set<string> {
  const forced = new Set<string>();
  for (const wf of workflows) {
    if (!selectedWorkflowIds.has(wf.id)) continue;
    for (const id of collectWorkflowCommandIds(wf)) {
      forced.add(id);
    }
  }
  for (const ma of miniapps) {
    if (!selectedMiniAppIds.has(ma.id)) continue;
    for (const id of collectMiniAppCommandIds(ma)) {
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
  /** Mini-apps the user ticked. */
  checkedMiniAppIds?: ReadonlySet<string>;
  /** The full workflow list, needed to resolve forced command dependencies. */
  workflows: ReadonlyArray<SelectableWorkflow>;
  /** The full mini-app list, needed to resolve forced command dependencies. */
  miniapps?: ReadonlyArray<SelectableMiniApp>;
}

/** The resolved set of ids that will actually be written to the file. */
export interface ResolvedExportSelection {
  commandIds: Set<string>;
  workflowIds: Set<string>;
  miniappIds: Set<string>;
}

/**
 * Resolve the final export selection: every selected workflow and mini-app,
 * plus the union of (explicitly-checked commands) and (commands forced by
 * those workflows / mini-apps). Forced commands are always present even if the
 * user never ticked them.
 */
export function resolveExportSelection(
  input: ExportSelectionInput,
): ResolvedExportSelection {
  const checkedMiniAppIds = input.checkedMiniAppIds ?? new Set<string>();
  const forced = computeForcedCommandIds(
    input.checkedWorkflowIds,
    input.workflows,
    checkedMiniAppIds,
    input.miniapps ?? [],
  );
  const commandIds = new Set<string>(input.checkedCommandIds);
  for (const id of forced) commandIds.add(id);
  return {
    commandIds,
    workflowIds: new Set<string>(input.checkedWorkflowIds),
    miniappIds: new Set<string>(checkedMiniAppIds),
  };
}

/**
 * Map the resolved id sets back to the concrete records to hand to
 * `exportData`. Order follows the input arrays so the file is stable.
 */
export function selectExportRecords<
  C extends SelectableCommand,
  W extends SelectableWorkflow,
  M extends SelectableMiniApp,
>(
  selection: ResolvedExportSelection,
  commands: ReadonlyArray<C>,
  workflows: ReadonlyArray<W>,
  miniapps: ReadonlyArray<M> = [],
): { commands: C[]; workflows: W[]; miniapps: M[] } {
  return {
    commands: commands.filter((c) => selection.commandIds.has(c.id)),
    workflows: workflows.filter((w) => selection.workflowIds.has(w.id)),
    miniapps: miniapps.filter((m) => selection.miniappIds.has(m.id)),
  };
}
