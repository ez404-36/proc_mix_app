// IPC wrapper around the Rust-side `workflows` table.
//
// The Rust handlers (`list_workflows`, `upsert_workflow`,
// `delete_workflow`, registered in Phase 2) speak `WorkflowRecord`, a
// wire-format struct that uses `null` for absent optional fields. The TS
// `Workflow` type uses `undefined` for the same fields, so this module
// owns the `null <-> undefined` translation as a single boundary — exactly
// like `commandRepository` does for `Command`. UI code only ever sees
// `Workflow` values.
//
// Phase 1 shipped the wire type + the pure record<->domain converters
// (consumed by `historyRepository` to translate embedded workflow
// snapshots). Phase 3 adds the `invoke`-backed list/upsert/delete wrappers
// below, alongside the workflow store.

import { invoke } from "@tauri-apps/api/core";
import type {
  DataAssignment,
  DataSource,
  EntitySoundConfig,
  LoopConfig,
  OutputSchema,
  RetryConfig,
  SwitchCase,
  Workflow,
  WorkflowCondition,
  WorkflowEdge,
  WorkflowEdgeBranch,
  WorkflowNode,
  WorkflowNodeKind,
} from "../types";
import {
  makeEnumGuard,
  nullToUndef,
  omitWhenUndefined,
  undefToNull,
} from "./repositoryHelpers";

/** Type-narrowing guard for the node kinds the runner understands. An unknown
 * value falls back to "command" so a malformed node never crashes the decoder;
 * the editor's validation surfaces the real problem to the user. Must stay in
 * lock-step with the Rust `NodeKind::parse`. */
const isNodeKind = makeEnumGuard<WorkflowNodeKind>([
  "start",
  "command",
  "condition",
  "switch",
  "loop",
  "try",
  "data",
  "parser",
  "text",
  "parallel",
  "join",
  "end",
]);

/** Static set of edge branches the runner understands. The `case:<id>`
 * (switch case) and `branch:<n>` (parallel fork exit) branches are dynamic —
 * the suffix is author/index derived — so they are matched by prefix in
 * {@link isBranch} rather than membership. Must stay in lock-step with the Rust
 * `Branch` mapping. */
const isStaticBranch = makeEnumGuard<WorkflowEdgeBranch>([
  "out",
  "then",
  "else",
  "default",
  "body",
  "done",
  "ok",
  "catch",
]);

/** Whether a decoded edge branch is one the runner understands. Dynamic
 * `case:<id>` / `branch:<n>` branches match by prefix; everything else by
 * membership. An unrecognised value falls back to "out". */
function isBranch(value: string): value is WorkflowEdgeBranch {
  if (value.startsWith("case:")) return true;
  if (value.startsWith("branch:")) return true;
  return isStaticBranch(value);
}

/** Wire format of a single node, matching the Rust `WorkflowNodeRecord`.
 * Optional fields are `T | null` because serde serialises `Option::None`
 * as JSON `null`; the advanced-node config vectors are omitted when empty
 * (Rust `skip_serializing_if`), so they are optional here too. */
export interface WorkflowNodeRecord {
  id: string;
  kind: string;
  commandId: string | null;
  label: string | null;
  condition?: WorkflowCondition | null;
  cases?: SwitchCase[];
  loop?: LoopConfig | null;
  retry?: RetryConfig | null;
  data?: DataAssignment[];
  /** Per-variable value sources, keyed by variable name. Omitted/empty when
   * the node has no overrides (Rust `#[serde(default)]`). */
  variableSources?: Record<string, DataSource>;
  /** Where this node's working directory draws its value; absent when the
   * node has no override (Rust `Option`, serialised `null`/omitted). */
  workingDirSource?: DataSource | null;
  /** Output-schema pipeline for a `parser` node; absent for other kinds
   * (Rust `Option`, serialised `null`/omitted). */
  parser?: OutputSchema | null;
  /** Template text for a `text` node; absent for other kinds (Rust `Option`). */
  text?: string | null;
  /** Bound join node id for a `parallel` (fork) node; absent for other kinds
   * and for a fork whose branches each end at their own `end` (Rust `Option`). */
  joinNodeId?: string | null;
  position: { x: number; y: number };
}

/** Wire format of a single edge, matching the Rust `WorkflowEdgeRecord`. */
export interface WorkflowEdgeRecord {
  id: string;
  source: string;
  target: string;
  branch: string;
}

/**
 * Wire format that matches the Rust `WorkflowRecord` struct exactly.
 * Optional fields are `T | null` (not `T | undefined`). `nodes` / `edges`
 * may be absent on the wire for legacy/minimal payloads (the Rust side
 * deserialises with `#[serde(default)]`).
 */
export interface WorkflowRecord {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  nodes?: WorkflowNodeRecord[];
  edges?: WorkflowEdgeRecord[];
  tags: string[];
  categoryId: string | null;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  runCount: number;
  /**
   * Mirror of the Rust `api_slug` field — the optional HTTP-API slug. `null` /
   * absent when the workflow has no slug. {@link workflowToRecord} omits it
   * when absent so the wire stays byte-identical to legacy payloads.
   */
  apiSlug?: string | null;
  /**
   * Mirror of the Rust `api_enabled` field. Optional/absent on the wire for
   * legacy records (Rust `#[serde(default)]` → `false`); decoded to `false`.
   */
  apiEnabled?: boolean;
  /**
   * Mirror of the Rust `sound` field — the optional per-workflow sound-
   * notification override, stored as a JSON column. Optional/absent on the
   * wire for legacy records (`#[serde(default)]` → `None`, serialised with
   * `skip_serializing_if = "Option::is_none"`). {@link workflowToRecord} omits
   * it when absent so the wire stays byte-identical to legacy payloads.
   */
  sound?: EntitySoundConfig | null;
}

function nodeToRecord(n: WorkflowNode): WorkflowNodeRecord {
  return {
    id: n.id,
    kind: n.kind,
    commandId: undefToNull(n.commandId),
    label: undefToNull(n.label),
    // Advanced-node config. Empty vectors are sent as-is (Rust drops them on
    // serialise); `undefined` collapses to `null` for the optional structs.
    condition: undefToNull(n.condition),
    cases: n.cases ?? [],
    loop: undefToNull(n.loop),
    retry: undefToNull(n.retry),
    data: n.data ?? [],
    // Empty object collapses to omitted on the wire (Rust drops a default
    // map); keep it minimal so nodes without overrides stay clean.
    variableSources: n.variableSources ?? {},
    workingDirSource: undefToNull(n.workingDirSource),
    parser: undefToNull(n.parser),
    text: undefToNull(n.text),
    joinNodeId: undefToNull(n.joinNodeId),
    position: { x: n.position.x, y: n.position.y },
  };
}

function recordToNode(r: WorkflowNodeRecord): WorkflowNode {
  return {
    id: r.id,
    kind: isNodeKind(r.kind) ? r.kind : "command",
    commandId: nullToUndef(r.commandId),
    label: nullToUndef(r.label),
    condition: nullToUndef(r.condition),
    // Absent / null vectors decode to `undefined` so the node stays minimal;
    // an empty array also collapses to `undefined` to avoid noise on the node.
    cases: r.cases && r.cases.length > 0 ? r.cases : undefined,
    loop: nullToUndef(r.loop),
    retry: nullToUndef(r.retry),
    data: r.data && r.data.length > 0 ? r.data : undefined,
    // An absent / empty map decodes to `undefined` so the node stays minimal.
    variableSources:
      r.variableSources && Object.keys(r.variableSources).length > 0
        ? r.variableSources
        : undefined,
    workingDirSource: nullToUndef(r.workingDirSource),
    parser: nullToUndef(r.parser),
    text: nullToUndef(r.text),
    joinNodeId: nullToUndef(r.joinNodeId),
    position: { x: r.position.x, y: r.position.y },
  };
}

function edgeToRecord(e: WorkflowEdge): WorkflowEdgeRecord {
  return { id: e.id, source: e.source, target: e.target, branch: e.branch };
}

function recordToEdge(r: WorkflowEdgeRecord): WorkflowEdge {
  return {
    id: r.id,
    source: r.source,
    target: r.target,
    branch: isBranch(r.branch) ? r.branch : "out",
  };
}

/**
 * Convert a UI `Workflow` into the wire-format record sent to Rust.
 * `undefined` fields collapse to `null` so the JSON payload always has an
 * explicit value for every column.
 */
export function workflowToRecord(w: Workflow): WorkflowRecord {
  return {
    id: w.id,
    name: w.name,
    description: undefToNull(w.description),
    icon: undefToNull(w.icon),
    nodes: w.nodes.map(nodeToRecord),
    edges: w.edges.map(edgeToRecord),
    tags: w.tags,
    categoryId: undefToNull(w.categoryId),
    favorite: w.favorite,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    lastRunAt: undefToNull(w.lastRunAt),
    runCount: w.runCount,
    // HTTP-API slug: omit when absent; an empty string normalises to `null`
    // (no slug) so the backend's partial unique index never sees a "" clash.
    ...omitWhenUndefined("apiSlug", w.apiSlug, (slug) =>
      slug.trim() === "" ? null : slug.trim(),
    ),
    // HTTP-API opt-in. Always sent so toggling it off persists.
    apiEnabled: w.apiEnabled ?? false,
    // Per-workflow sound override: pass through verbatim as a JSON column,
    // omitted when absent so the wire stays byte-identical to legacy payloads
    // for workflows that inherit the global sound settings.
    ...omitWhenUndefined("sound", w.sound),
  };
}

/**
 * Decode a wire-format record into a UI `Workflow`. Null collapses to
 * `undefined`; absent `nodes` / `edges` become empty arrays so consumers
 * can always iterate the graph without a guard.
 */
export function recordToWorkflow(r: WorkflowRecord): Workflow {
  return {
    id: r.id,
    name: r.name,
    description: nullToUndef(r.description),
    icon: nullToUndef(r.icon),
    nodes: (r.nodes ?? []).map(recordToNode),
    edges: (r.edges ?? []).map(recordToEdge),
    tags: r.tags,
    categoryId: nullToUndef(r.categoryId),
    favorite: r.favorite,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastRunAt: nullToUndef(r.lastRunAt),
    runCount: r.runCount,
    // HTTP-API slug; `undefined` when the workflow has none.
    apiSlug: nullToUndef(r.apiSlug),
    // Default to `false` for legacy rows (no column).
    apiEnabled: r.apiEnabled ?? false,
    // Per-workflow sound override; `undefined` (inherit global) when the
    // record carries no value or an explicit `null`.
    sound: nullToUndef(r.sound),
  };
}

/** Load every persisted workflow from SQLite, oldest first. */
export async function listWorkflowsFromDb(): Promise<Workflow[]> {
  const records = await invoke<WorkflowRecord[]>("list_workflows");
  return records.map(recordToWorkflow);
}

/** Insert-or-update a single workflow. */
export async function upsertWorkflowInDb(wf: Workflow): Promise<void> {
  await invoke("upsert_workflow", { workflow: workflowToRecord(wf) });
}

/** Remove a workflow by id. Idempotent — missing ids are not an error. */
export async function deleteWorkflowInDb(id: string): Promise<void> {
  await invoke("delete_workflow", { id });
}
