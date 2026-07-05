// Apply a validated `ProcMixExport` to the live stores.
//
// Every imported command and workflow is given a FRESH id (the store
// generates it) so importing never overwrites an existing entry — even
// re-importing the same file just produces duplicates. Because command
// ids change, a workflow node that referenced an imported command must be
// re-pointed at that command's NEW id. We therefore import commands first,
// build an `oldCommandId → newCommandId` map, then remap workflow nodes
// before creating them.
//
// Both creates go through the history-aware `commandActions` /
// `workflowActions` wrappers, so each imported entry is logged as a
// `commandCreated` / `workflowCreated` event, exactly like a manual create.

import {
  createCommand,
  existingCommandApiSlugs,
  updateCommand,
} from "./commandActions";
import { createWorkflow, existingWorkflowApiSlugs } from "./workflowActions";
import type {
  ExportedCommand,
  ExportedWorkflow,
  ProcMixExport,
} from "../utils/dataTransfer";
import type { ImportSelection } from "../utils/importSelection";
import type { Command, WorkflowNode } from "../types";

// `ImportSelection` is computed by the pure `resolveImportSelection` policy in
// `utils/importSelection`; re-exported here so callers that apply the import
// keep a single import site.
export type { ImportSelection };

export interface ImportResult {
  /** How many commands were created as new entries. */
  commands: number;
  /** How many name-duplicates were imported under a new, unique name. */
  renamed: number;
  workflows: number;
  /**
   * How many imported commands had `runAsAdmin: true` in the source file and
   * were demoted to `false` on import (M2 — security audit). Import is
   * untrusted input: a shared/malicious file must never install a command
   * that is one click away from an elevated run. The user re-enables the flag
   * per command after reviewing the script. The Settings status surfaces this
   * count so the demotion is never silent.
   */
  demotedAdmin: number;
  /**
   * How many imported items (commands + workflows) had an API slug that
   * collided with an existing entity of the same type. Their slug was cleared
   * and HTTP API access turned off on the imported copy so the import never
   * fails on the backend's unique-slug index. The user can set a new slug
   * afterwards. Surfaced in the Settings status so the change is never silent.
   */
  clearedApiSlugs: number;
}

/**
 * Per-install state keys that the export strips but which a hand-edited or
 * older-version file might still carry. The importer drops them defensively
 * — the store re-stamps id/timestamps/runCount and we force `favorite:
 * false` — so a stray field can never leak into the new record. `sound` is
 * likewise no longer exported and points at a per-install sound config, so an
 * older file that still carries it is dropped rather than re-imported.
 */
type CarriedState = Partial<
  Pick<
    Command,
    | "id"
    | "favorite"
    | "runCount"
    | "lastRunAt"
    | "createdAt"
    | "updatedAt"
    | "sound"
  >
>;

/**
 * Build the `createCommand` input from an imported command: drop the `id`
 * (the store mints a fresh one), the i18n-key fields reserved for built-in
 * seeds (so an import can never inject translation keys), and any per-install
 * state fields a non-conforming file might still carry. `favorite` is reset
 * to false — it is local state the user sets, not part of the definition.
 *
 * SECURITY (M2): `runAsAdmin` is forced to `false`. Import is untrusted input,
 * so a command must never arrive pre-armed for elevated execution. The second
 * tuple element reports whether the source had it set, so the caller can count
 * the demotions and tell the user.
 */
function toCommandInput(
  cmd: ExportedCommand,
  nameOverride: string | undefined,
  existingSlugs: ReadonlySet<string>,
): [
  Parameters<typeof createCommand>[0],
  { wasAdmin: boolean; clearedSlug: boolean },
] {
  const {
    id: _id,
    favorite: _favorite,
    runCount: _runCount,
    lastRunAt: _lastRunAt,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    sound: _sound,
    nameKey: _nameKey,
    descriptionKey: _descriptionKey,
    ...rest
  } = cmd as ExportedCommand & CarriedState;
  const wasAdmin = rest.runAsAdmin === true;
  // A slug that collides with an existing command is cleared (and API access
  // disabled) so the import never trips the backend's unique-slug index.
  const clearedSlug =
    rest.apiSlug !== undefined && existingSlugs.has(rest.apiSlug);
  return [
    {
      ...rest,
      // A name-duplicate the user kept is created under a fresh unique name.
      name: nameOverride ?? rest.name,
      favorite: false,
      runAsAdmin: false,
      ...(clearedSlug ? { apiSlug: undefined, apiEnabled: false } : {}),
    },
    { wasAdmin, clearedSlug },
  ];
}

/**
 * Remap a workflow node's `commandId` through the old→new command id map.
 * A node whose referenced command was NOT part of the import (absent from
 * the map) keeps its original id — it simply becomes an unbound node the
 * user can re-point later, rather than crashing the import.
 */
function remapNode(
  node: WorkflowNode,
  idMap: ReadonlyMap<string, string>,
): WorkflowNode {
  if (node.commandId === undefined) return node;
  const mapped = idMap.get(node.commandId);
  if (mapped === undefined) return node;
  return { ...node, commandId: mapped };
}

/**
 * Build the `createWorkflow` input from an imported workflow: drop the
 * store-materialised fields and re-point every node at the freshly
 * imported command ids.
 */
function toWorkflowInput(
  wf: ExportedWorkflow,
  idMap: ReadonlyMap<string, string>,
  existingSlugs: ReadonlySet<string>,
): [Parameters<typeof createWorkflow>[0], { clearedSlug: boolean }] {
  const {
    id: _id,
    favorite: _favorite,
    runCount: _runCount,
    lastRunAt: _lastRunAt,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    sound: _sound,
    ...rest
  } = wf as ExportedWorkflow & CarriedState;
  const clearedSlug =
    rest.apiSlug !== undefined && existingSlugs.has(rest.apiSlug);
  return [
    {
      ...rest,
      favorite: false,
      nodes: rest.nodes.map((n: WorkflowNode) => remapNode(n, idMap)),
      ...(clearedSlug ? { apiSlug: undefined, apiEnabled: false } : {}),
    },
    { clearedSlug },
  ];
}

/**
 * Resolve the selection for an import. When `selection` is omitted, the whole
 * envelope is imported as new copies (legacy behaviour); callers that ran the
 * Import dialog pass the user's explicit subset + rename resolution.
 */
function resolveSelection(
  parsed: ProcMixExport,
  selection?: ImportSelection,
): {
  commands: ExportedCommand[];
  workflows: ExportedWorkflow[];
  rename: ReadonlyMap<string, string>;
} {
  if (selection === undefined) {
    return {
      commands: [...parsed.commands],
      workflows: [...parsed.workflows],
      rename: new Map(),
    };
  }
  return {
    commands: parsed.commands.filter((c) => selection.commandIds.has(c.id)),
    workflows: parsed.workflows.filter((w) => selection.workflowIds.has(w.id)),
    rename: selection.rename,
  };
}

/**
 * Persist the chosen commands and workflows from a validated export.
 *
 * Every imported command is created FRESH (a new id) — importing never
 * overwrites an existing entry, so a shared file can't clobber a command a
 * workflow depends on. A name-duplicate the user chose to keep is created
 * under the unique name the dialog resolved (`selection.rename`). Workflow
 * nodes are then remapped through the old→new id map before the workflows are
 * created.
 *
 * Returns counts (created / renamed / workflows / admin demotions) for the
 * Settings status plaque.
 */
export function applyImport(
  parsed: ProcMixExport,
  selection?: ImportSelection,
): ImportResult {
  const { commands, workflows, rename } = resolveSelection(parsed, selection);

  // API slugs already in use, per type (separate namespaces). A colliding
  // imported slug is cleared so the backend's unique-slug index never rejects
  // the import. Read once up front through the actions facade (which owns the
  // store access) so this service stays free of direct store imports.
  const existingCommandSlugs = existingCommandApiSlugs();
  const existingWorkflowSlugs = existingWorkflowApiSlugs();
  let clearedApiSlugs = 0;

  const commandIdMap = new Map<string, string>();
  // For each imported command that is `local`, remember its NEW id and the
  // OLD workflow id it referenced — so a second pass can re-point it at the
  // imported workflow's freshly-generated id (commands import before
  // workflows, so the new workflow id is not known yet at create time).
  const localCommandRemap: { newCommandId: string; oldWorkflowId: string }[] =
    [];
  let created = 0;
  let renamed = 0;
  let demotedAdmin = 0;

  for (const cmd of commands) {
    const newName = rename.get(cmd.id);
    const [input, { wasAdmin, clearedSlug }] = toCommandInput(
      cmd,
      newName,
      existingCommandSlugs,
    );
    if (wasAdmin) demotedAdmin += 1;
    if (clearedSlug) clearedApiSlugs += 1;

    const record = createCommand(input);
    commandIdMap.set(cmd.id, record.id);
    if (record.scope === "local" && record.workflowId !== undefined) {
      localCommandRemap.push({
        newCommandId: record.id,
        oldWorkflowId: record.workflowId,
      });
    }
    created += 1;
    if (newName !== undefined) renamed += 1;
  }

  // Build the old→new workflow id map AS workflows are created so local
  // commands can be re-pointed at the imported workflow's new id.
  const workflowIdMap = new Map<string, string>();
  for (const wf of workflows) {
    const [input, { clearedSlug }] = toWorkflowInput(
      wf,
      commandIdMap,
      existingWorkflowSlugs,
    );
    if (clearedSlug) clearedApiSlugs += 1;
    const record = createWorkflow(input);
    workflowIdMap.set(wf.id, record.id);
  }

  // Second pass: re-point each imported local command at the NEW workflow id.
  // A local command whose owning workflow was NOT part of the import keeps its
  // (now-dangling) old id rather than crashing — it simply has no owner in
  // this install until the user promotes or removes it.
  for (const { newCommandId, oldWorkflowId } of localCommandRemap) {
    const newWorkflowId = workflowIdMap.get(oldWorkflowId);
    if (newWorkflowId !== undefined && newWorkflowId !== oldWorkflowId) {
      updateCommand(newCommandId, { workflowId: newWorkflowId });
    }
  }

  return {
    commands: created,
    renamed,
    workflows: workflows.length,
    demotedAdmin,
    clearedApiSlugs,
  };
}
