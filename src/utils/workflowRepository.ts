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
  Workflow,
  WorkflowEdge,
  WorkflowEdgeBranch,
  WorkflowNode,
  WorkflowNodeKind,
} from "../types";

/** Set of node kinds the runner understands — used as a type-narrowing
 * guard when decoding a record whose `kind` column is an arbitrary string.
 * An unknown value falls back to "command" so a malformed node never
 * crashes the decoder; the editor's validation (Phase 5) surfaces the
 * real problem to the user. */
const KNOWN_NODE_KINDS: ReadonlySet<WorkflowNodeKind> =
  new Set<WorkflowNodeKind>(["start", "command", "condition", "end"]);

function isNodeKind(value: string): value is WorkflowNodeKind {
  return KNOWN_NODE_KINDS.has(value as WorkflowNodeKind);
}

const KNOWN_BRANCHES: ReadonlySet<WorkflowEdgeBranch> =
  new Set<WorkflowEdgeBranch>(["out", "then", "else"]);

function isBranch(value: string): value is WorkflowEdgeBranch {
  return KNOWN_BRANCHES.has(value as WorkflowEdgeBranch);
}

/** Wire format of a single node, matching the Rust `WorkflowNodeRecord`.
 * Optional fields are `T | null` because serde serialises `Option::None`
 * as JSON `null`. */
export interface WorkflowNodeRecord {
  id: string;
  kind: string;
  commandId: string | null;
  label: string | null;
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
}

function nodeToRecord(n: WorkflowNode): WorkflowNodeRecord {
  return {
    id: n.id,
    kind: n.kind,
    commandId: n.commandId ?? null,
    label: n.label ?? null,
    position: { x: n.position.x, y: n.position.y },
  };
}

function recordToNode(r: WorkflowNodeRecord): WorkflowNode {
  return {
    id: r.id,
    kind: isNodeKind(r.kind) ? r.kind : "command",
    commandId: r.commandId ?? undefined,
    label: r.label ?? undefined,
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
    description: w.description ?? null,
    icon: w.icon ?? null,
    nodes: w.nodes.map(nodeToRecord),
    edges: w.edges.map(edgeToRecord),
    tags: w.tags,
    categoryId: w.categoryId ?? null,
    favorite: w.favorite,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    lastRunAt: w.lastRunAt ?? null,
    runCount: w.runCount,
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
    description: r.description ?? undefined,
    icon: r.icon ?? undefined,
    nodes: (r.nodes ?? []).map(recordToNode),
    edges: (r.edges ?? []).map(recordToEdge),
    tags: r.tags,
    categoryId: r.categoryId ?? undefined,
    favorite: r.favorite,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastRunAt: r.lastRunAt ?? undefined,
    runCount: r.runCount,
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
