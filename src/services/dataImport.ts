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
import { createMiniApp } from "./miniappActions";
import { createWorkflow, existingWorkflowApiSlugs } from "./workflowActions";
import type {
  ExportedCommand,
  ExportedMiniApp,
  ExportedWorkflow,
  ProcMixExport,
} from "../utils/dataTransfer";
import type { ImportSelection } from "../utils/importSelection";
import type {
  Command,
  MiniApp,
  MiniAppAction,
  MiniAppWidget,
  PanelSize,
  StatusSource,
  WidgetLayout,
  WorkflowNode,
} from "../types";

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
  /** How many mini-apps were created as new entries (v2+ envelopes). */
  miniapps: number;
  /**
   * How many imported commands had `runAsAdmin: true` in the source file AND
   * how many inline mini-app actions were armed, combined — both demoted to
   * `false` on import (M2 — security audit). Import is untrusted input: a
   * shared/malicious file must never install a command or inline mini-app
   * action that is one click away from an elevated run. The user re-enables
   * the flag per command/action after reviewing the script. The Settings
   * status surfaces this count so the demotion is never silent.
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
  /**
   * How many selected mini-apps could not be created because building their
   * input threw (a malformed widget tree the file guard cannot catch — it
   * validates only the envelope shape, not the deep discriminated widget
   * union). Each failure is contained so ONE bad mini-app never aborts an
   * import that has already written commands and workflows to SQLite; the
   * Settings status surfaces the count so the loss is never silent.
   */
  miniappsFailed: number;
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
 * Per-install state keys a hand-edited or older mini-app file might still
 * carry. The importer drops them defensively — the store re-stamps id /
 * timestamps / runCount and we force `favorite: false` — so a stray field can
 * never leak into the new record. `MiniApp` carries no `sound` config.
 */
type MiniAppCarriedState = Partial<
  Pick<
    MiniApp,
    "id" | "favorite" | "runCount" | "lastRunAt" | "createdAt" | "updatedAt"
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
 * Remap a mini-app action through the old→new command id map.
 *
 * For a `commandRef` action the `commandId` is re-pointed to the freshly
 * imported command id; a command that was NOT part of the import (absent from
 * the map) keeps its original id — it becomes a dangling reference the Runner
 * reports as "command not found" rather than crashing the import.
 *
 * SECURITY (M2): an `inline` action's `runAsAdmin` is forced to `false`
 * (mirroring {@link toCommandInput}). The returned `demoted` count (1 when the
 * source action was armed, 0 otherwise) lets the caller sum the demotions so
 * the count is surfaced in the Settings status plaque. Counting per ACTION
 * (not per widget) matches the command-side granularity, where every armed
 * `runAsAdmin` flag is its own demotion — a toggle's two independent actions
 * count as two when both are armed.
 */
function remapAction(
  action: MiniAppAction,
  idMap: ReadonlyMap<string, string>,
): { action: MiniAppAction; demoted: number } {
  if (action.kind === "commandRef") {
    const mapped = idMap.get(action.commandId);
    if (mapped === undefined) return { action, demoted: 0 };
    return { action: { ...action, commandId: mapped }, demoted: 0 };
  }
  const wasAdmin = action.runAsAdmin === true;
  return { action: { ...action, runAsAdmin: false }, demoted: wasAdmin ? 1 : 0 };
}

/**
 * Remap a status source's `commandId` through the old→new id map. An inline
 * status source carries no command reference, so it is returned unchanged.
 */
function remapStatusSource(
  source: StatusSource,
  idMap: ReadonlyMap<string, string>,
): StatusSource {
  if (source.kind === "commandRef") {
    const mapped = idMap.get(source.commandId);
    if (mapped === undefined) return source;
    return { ...source, commandId: mapped };
  }
  return source;
}

/**
 * Remap every command reference inside a widget (its action(s) and any status
 * source) and force `runAsAdmin: false` on any inline action. `demoted` is the
 * NUMBER of armed inline actions that were disarmed in this widget — summed
 * into the import result so the safety change is never silent.
 */
function remapWidget(
  widget: MiniAppWidget,
  idMap: ReadonlyMap<string, string>,
): { widget: MiniAppWidget; demoted: number } {
  switch (widget.kind) {
    case "button": {
      const { action, demoted } = remapAction(widget.action, idMap);
      return { widget: { ...widget, action }, demoted };
    }
    case "toggle": {
      const on = remapAction(widget.onAction, idMap);
      const off = remapAction(widget.offAction, idMap);
      const status =
        widget.status === undefined
          ? undefined
          : {
              ...widget.status,
              source: remapStatusSource(widget.status.source, idMap),
            };
      return {
        widget: {
          ...widget,
          onAction: on.action,
          offAction: off.action,
          ...(status === undefined ? {} : { status }),
        },
        demoted: on.demoted + off.demoted,
      };
    }
    case "status": {
      return {
        widget: { ...widget, source: remapStatusSource(widget.source, idMap) },
        demoted: 0,
      };
    }
    case "artifact": {
      // An artifact is a static label/value — no action, no status source.
      return { widget, demoted: 0 };
    }
    default: {
      // Unknown widget kind — a hand-edited file, or one written by a NEWER
      // ProcMix that added a fifth kind. It carries no command reference we
      // know how to remap and no inline action we could disarm, so it passes
      // through verbatim. Returning it (rather than falling off the end of the
      // switch and yielding `undefined`) is what keeps the caller's destructure
      // safe: an unknown kind must never abort an import that has ALREADY
      // written commands and workflows to SQLite. Mirrors the graceful
      // `default` in `miniappRepository.recordToWidget`.
      return { widget, demoted: 0 };
    }
  }
}

/**
 * Upper bound applied to an imported `panelSize`. A mini-app authored on a
 * 2560px display can carry a 1800×1200 panel; the runner renders the panel at
 * exactly that size with no max-width constraint, so it would overflow a
 * smaller viewport with no way to recover. Clamping at import — the boundary
 * where untrusted geometry enters the app — keeps every persisted mini-app
 * renderable on a normal window.
 */
const MAX_PANEL_WIDTH = 1200;
const MAX_PANEL_HEIGHT = 900;

/**
 * Lower bound applied to an imported `panelSize`. Mirrors the editor's
 * `MIN_PANEL_WIDTH` / `MIN_PANEL_HEIGHT` (room for one widget) so an imported
 * panel is never smaller than one the editor would allow the user to create.
 */
const MIN_PANEL_WIDTH = 200;
const MIN_PANEL_HEIGHT = 160;

/** Fallback when the file carries a non-finite / absent panel dimension. */
const DEFAULT_PANEL_SIZE: PanelSize = { w: 400, h: 320 };

/** Clamp `value` into the inclusive `[lo, hi]` range. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(value, hi));
}

/**
 * Clamp an imported panel size into `[MIN, MAX]` per axis. A non-finite
 * dimension (a hand-edited `NaN`/`Infinity`, or an absent value from a
 * legacy file) falls back to the default rather than propagating a broken
 * number into the store.
 */
function clampPanelSize(size: PanelSize | undefined): PanelSize {
  const w =
    size !== undefined && Number.isFinite(size.w) ? size.w : DEFAULT_PANEL_SIZE.w;
  const h =
    size !== undefined && Number.isFinite(size.h) ? size.h : DEFAULT_PANEL_SIZE.h;
  return {
    w: clamp(w, MIN_PANEL_WIDTH, MAX_PANEL_WIDTH),
    h: clamp(h, MIN_PANEL_HEIGHT, MAX_PANEL_HEIGHT),
  };
}

/** Smallest widget box the editor lets a user resize to. */
const MIN_WIDGET_W = 48;
const MIN_WIDGET_H = 40;

/**
 * Clamp a widget's layout so it fits inside the (already-clamped) panel. The
 * editor enforces this during a drag but the import path had no clamp at all,
 * so a mini-app authored on a large panel — or one whose panel this import just
 * shrank — could place widgets outside the visible area, where the runner
 * clips or overflows them (`.miniapp-runner__panel` sets no `overflow`).
 *
 * The width/height are capped to the panel first, then the origin is clamped so
 * the whole box stays inside.
 *
 * This is a BOUNDARY validator: the file guard checks only the envelope shape,
 * so an import can carry a widget with no `layout` at all or with a non-finite
 * coordinate. Either falls back to a minimal box at the origin rather than
 * propagating `NaN` into the store (which would render an invisible widget the
 * user cannot select) or throwing (which would cost the whole mini-app).
 */
function clampWidgetLayout(
  layout: WidgetLayout | undefined,
  panel: PanelSize,
): WidgetLayout {
  const finite = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const w = clamp(finite(layout?.w, MIN_WIDGET_W), MIN_WIDGET_W, panel.w);
  const h = clamp(finite(layout?.h, MIN_WIDGET_H), MIN_WIDGET_H, panel.h);
  const x = clamp(finite(layout?.x, 0), 0, panel.w - w);
  const y = clamp(finite(layout?.y, 0), 0, panel.h - h);
  return { x, y, w, h };
}

/**
 * Build the `createMiniApp` input from an imported mini-app: drop the
 * store-materialised fields (the store mints a fresh id + timestamps), force
 * `favorite: false`, clamp the panel size and every widget layout into a
 * renderable range, remap every widget's command references to the freshly
 * imported command ids, and force `runAsAdmin: false` on every inline action.
 * The second tuple element reports how many inline actions were demoted.
 */
function toMiniAppInput(
  ma: ExportedMiniApp,
  idMap: ReadonlyMap<string, string>,
): [Parameters<typeof createMiniApp>[0], { demoted: number }] {
  const {
    id: _id,
    favorite: _favorite,
    runCount: _runCount,
    lastRunAt: _lastRunAt,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...rest
  } = ma as ExportedMiniApp & MiniAppCarriedState;
  // The panel is clamped FIRST so widget layouts are bounded by the size the
  // runner will actually render, not the (possibly oversized) authored one.
  const panelSize = clampPanelSize(rest.panelSize);
  let demoted = 0;
  const widgets = rest.widgets.map((w) => {
    const { widget, demoted: d } = remapWidget(w, idMap);
    demoted += d;
    return { ...widget, layout: clampWidgetLayout(widget.layout, panelSize) };
  });
  return [{ ...rest, favorite: false, panelSize, widgets }, { demoted }];
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
  miniapps: ExportedMiniApp[];
  rename: ReadonlyMap<string, string>;
} {
  // A v1 file has no `miniapps` key, so its absence means "no mini-apps".
  const allMiniApps = parsed.miniapps ?? [];
  if (selection === undefined) {
    return {
      commands: [...parsed.commands],
      workflows: [...parsed.workflows],
      miniapps: [...allMiniApps],
      rename: new Map(),
    };
  }
  return {
    commands: parsed.commands.filter((c) => selection.commandIds.has(c.id)),
    workflows: parsed.workflows.filter((w) => selection.workflowIds.has(w.id)),
    miniapps: allMiniApps.filter((m) => selection.miniappIds.has(m.id)),
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
  const { commands, workflows, miniapps, rename } = resolveSelection(
    parsed,
    selection,
  );

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

  // Mini-apps (v2+). Only the user's selected subset is created (a v1 file has
  // no `miniapps` key, so nothing is created — legacy behaviour preserved).
  // Each widget's command references are remapped through `commandIdMap`
  // (commands are created above, so their new ids are known); a reference to a
  // command that was not imported is left dangling (the Runner reports "command
  // not found"). Inline actions have `runAsAdmin` forced to `false` and count
  // toward `demotedAdmin`, and geometry is clamped into a renderable range.
  //
  // Each mini-app is created inside its own try/catch. The envelope guard only
  // validates the mini-app's SHAPE (id / name / widgets array), not the deep
  // discriminated widget union, so a malformed widget can still throw here —
  // and mini-apps are processed LAST, after commands and workflows have already
  // been written to SQLite. Containing the failure per entry means a single bad
  // mini-app costs only itself instead of leaving a partially-applied import
  // reported as a total failure. The count is returned so the UI can say so.
  let miniappsCreated = 0;
  let miniappsFailed = 0;
  for (const ma of miniapps) {
    try {
      const [input, { demoted }] = toMiniAppInput(ma, commandIdMap);
      createMiniApp(input);
      demotedAdmin += demoted;
      miniappsCreated += 1;
    } catch {
      // The entry is dropped, not fatal: the rest of the import proceeds and
      // the caller reports how many were lost.
      miniappsFailed += 1;
    }
  }

  return {
    commands: created,
    renamed,
    workflows: workflows.length,
    miniapps: miniappsCreated,
    demotedAdmin,
    clearedApiSlugs,
    miniappsFailed,
  };
}
