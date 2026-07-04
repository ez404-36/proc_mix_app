import { create } from "zustand";
import type { Workflow } from "../types";
import {
  makeInitialFlow,
  workflowToFlow,
  type WorkflowFlowEdge,
  type WorkflowFlowNode,
} from "../utils/workflowGraph";
import type { WorkflowMeta } from "../components/Editor/WorkflowMetaModal";

/**
 * Empty metadata for a brand-new, unnamed workflow draft.
 */
const EMPTY_META: WorkflowMeta = { name: "", tags: [] };

/**
 * Maximum number of undo snapshots kept per editing session. Bounds memory
 * for long sessions; the oldest snapshot is dropped once the cap is reached.
 */
const MAX_HISTORY = 50;

/**
 * A setter argument that is either the next value or an updater function
 * applied to the previous value — mirrors reactflow's `useNodesState` /
 * `useEdgesState` setter contract (reactflow calls the setter with an
 * updater from `applyNodeChanges` / `addEdge`, and the canvas calls it with
 * a plain array elsewhere). Modelling both keeps the store a drop-in
 * replacement for those hooks' setters.
 */
type SetterArg<T> = T | ((prev: T) => T);

function resolveSetter<T>(arg: SetterArg<T>, prev: T): T {
  return typeof arg === "function" ? (arg as (p: T) => T)(prev) : arg;
}

/**
 * Project the editable metadata fields off a persisted `Workflow`.
 */
function metaFromWorkflow(wf: Workflow): WorkflowMeta {
  return {
    name: wf.name,
    description: wf.description,
    tags: wf.tags,
    categoryId: wf.categoryId,
    icon: wf.icon,
    apiEnabled: wf.apiEnabled,
    apiSlug: wf.apiSlug,
    sound: wf.sound,
  };
}

/**
 * The materialised graph + metadata for a single editing session, built
 * either from a saved workflow or from a fresh initial graph.
 */
export interface EditorDraft {
  nodes: WorkflowFlowNode[];
  edges: WorkflowFlowEdge[];
  meta: WorkflowMeta;
  /**
   * Persisted id for the draft. Equals the saved workflow's id when editing
   * an existing workflow; `null` for a new workflow until its first save.
   */
  currentId: string | null;
  /**
   * The persisted workflow's last-saved time (its `updatedAt`) when editing
   * an existing workflow, or `null` for a brand-new draft. Seeds the
   * editor header's "Saved at …" indicator so an existing workflow shows
   * its real last-saved time on entering edit mode (not a dash until the
   * first in-session save).
   */
  lastSavedAt: string | null;
}

/**
 * A point-in-time copy of the editable graph + metadata, used as one entry
 * on the undo/redo stacks. Snapshots are deep-cloned at capture time so a
 * later in-place mutation of the live draft can never corrupt history.
 */
export interface EditorSnapshot {
  nodes: WorkflowFlowNode[];
  edges: WorkflowFlowEdge[];
  meta: WorkflowMeta;
}

/**
 * Deep-clone a snapshot so undo/redo entries are isolated from the live
 * draft. `structuredClone` is available in the app's runtime (modern webview)
 * and handles the plain-data node/edge/meta shapes here.
 */
function cloneSnapshot(snapshot: EditorSnapshot): EditorSnapshot {
  return structuredClone(snapshot);
}

/**
 * Stable string projection of the draft used for dirty detection. Mirrors
 * `fingerprintForm` in the command form: it excludes reactflow's transient,
 * presentation-only node fields (selection highlight, measured width/height)
 * and rounds positions so a sub-pixel layout jitter is not treated as an
 * edit. Everything that is persisted to the saved workflow participates so a
 * genuine change is detected.
 */
export function fingerprintDraft(draft: EditorSnapshot): string {
  return JSON.stringify({
    meta: {
      name: draft.meta.name,
      description: draft.meta.description ?? null,
      tags: draft.meta.tags,
      categoryId: draft.meta.categoryId ?? null,
      icon: draft.meta.icon ?? null,
      apiEnabled: draft.meta.apiEnabled ?? false,
      apiSlug: draft.meta.apiSlug ?? null,
      sound: draft.meta.sound ?? null,
    },
    nodes: draft.nodes.map((n) => ({
      id: n.id,
      type: n.type ?? n.data.kind,
      x: Math.round(n.position.x),
      y: Math.round(n.position.y),
      data: n.data,
    })),
    edges: draft.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? null,
      targetHandle: e.targetHandle ?? null,
    })),
  });
}

/**
 * Build the draft for a navigation target. A known `workflowId` present in
 * `workflows` loads the saved graph; `null` (or an unknown id — e.g. the
 * workflow was deleted out from under the editor) yields a fresh single
 * `start` node graph with empty metadata.
 */
export function buildDraftForTarget(
  targetId: string | null,
  workflows: Workflow[],
): EditorDraft {
  if (targetId !== null) {
    const wf = workflows.find((w) => w.id === targetId);
    if (wf !== undefined) {
      const flow = workflowToFlow(wf);
      return {
        nodes: flow.nodes,
        edges: flow.edges,
        meta: metaFromWorkflow(wf),
        currentId: wf.id,
        lastSavedAt: wf.updatedAt,
      };
    }
  }
  const initial = makeInitialFlow();
  return {
    nodes: initial.nodes,
    edges: initial.edges,
    meta: EMPTY_META,
    currentId: null,
    lastSavedAt: null,
  };
}

interface EditorDraftState {
  /**
   * The navigation target this draft was hydrated from (`null` = a brand-new
   * workflow). Used to decide whether a canvas (re)mount should re-hydrate
   * from the workflow store or preserve the in-progress draft: a remount for
   * the SAME target preserves; a switch to a DIFFERENT target re-hydrates.
   */
  targetId: string | null;
  /** Whether a draft is currently loaded. `false` before first hydration. */
  hydrated: boolean;
  nodes: WorkflowFlowNode[];
  edges: WorkflowFlowEdge[];
  meta: WorkflowMeta;
  currentId: string | null;
  selectedNodeId: string | null;

  /**
   * Fingerprint of the last SAVED (or freshly loaded) draft. Compared against
   * the live draft to decide whether there are unsaved changes — drives the
   * editor's Close confirmation.
   */
  baseline: string;
  /** Undo stack: snapshots taken BEFORE each discrete action, newest last. */
  past: EditorSnapshot[];
  /** Redo stack: snapshots popped by undo, awaiting redo. Newest last. */
  future: EditorSnapshot[];

  /**
   * ISO timestamp of the last in-editor save (the \"Save\" button or the
   * Properties modal save), or `null` when the draft has not been saved in
   * this editing session yet. Drives the header's \"Saved at …\" indicator.
   * Cleared on hydrate/reset so a freshly-loaded workflow shows no stale time.
   */
  lastSavedAt: string | null;

  /** Replace the whole draft for a navigation target. Resets history + baseline. */
  hydrate: (targetId: string | null, draft: EditorDraft) => void;
  setNodes: (arg: SetterArg<WorkflowFlowNode[]>) => void;
  setEdges: (arg: SetterArg<WorkflowFlowEdge[]>) => void;
  setMeta: (meta: WorkflowMeta) => void;
  setCurrentId: (id: string | null) => void;
  setSelectedNodeId: (id: string | null) => void;
  /** Replace the draft with a fresh build for `targetId`. Resets history + baseline. */
  reset: (targetId: string | null, draft: EditorDraft) => void;

  /**
   * Capture the CURRENT draft onto the undo stack as one discrete action.
   * Call this at an action boundary (before applying a node/edge change that
   * should be undoable in a single step). Clears the redo stack — a fresh
   * action invalidates any previously-undone future.
   */
  pushHistory: () => void;
  /**
   * Snapshot the current draft and return it WITHOUT recording it. Pair with
   * {@link commitHistory} for actions whose change is applied incrementally
   * (e.g. the node modal's many keystrokes): take the snapshot when the modal
   * opens, then commit it on close only if the draft actually changed — so the
   * whole modal session collapses into ONE undo step.
   */
  captureSnapshot: () => EditorSnapshot;
  /**
   * Record a previously-{@link captureSnapshot}d draft onto the undo stack as
   * one discrete action. Clears the redo stack. Used to collapse an
   * incremental edit session (node modal) into a single undo step.
   */
  commitHistory: (snapshot: EditorSnapshot) => void;
  /** Restore the most recent snapshot from the undo stack, if any. */
  undo: () => void;
  /** Re-apply the most recently undone snapshot, if any. */
  redo: () => void;
  /**
   * Mark the current draft as the saved baseline (no longer dirty) and stamp
   * `lastSavedAt` with the current time. Called after a successful Save that
   * keeps the editor open.
   */
  markSaved: () => void;
}

function snapshotOf(state: {
  nodes: WorkflowFlowNode[];
  edges: WorkflowFlowEdge[];
  meta: WorkflowMeta;
}): EditorSnapshot {
  return cloneSnapshot({
    nodes: state.nodes,
    edges: state.edges,
    meta: state.meta,
  });
}

export const useEditorDraftStore = create<EditorDraftState>()((set, get) => ({
  targetId: null,
  hydrated: false,
  nodes: [],
  edges: [],
  meta: EMPTY_META,
  currentId: null,
  selectedNodeId: null,
  baseline: fingerprintDraft({ nodes: [], edges: [], meta: EMPTY_META }),
  past: [],
  future: [],
  lastSavedAt: null,

  hydrate: (targetId, draft) =>
    set({
      targetId,
      hydrated: true,
      nodes: draft.nodes,
      edges: draft.edges,
      meta: draft.meta,
      currentId: draft.currentId,
      selectedNodeId: null,
      baseline: fingerprintDraft({
        nodes: draft.nodes,
        edges: draft.edges,
        meta: draft.meta,
      }),
      past: [],
      future: [],
      // Seed from the loaded workflow's last-saved time so an existing
      // workflow shows it immediately (null for a brand-new draft).
      lastSavedAt: draft.lastSavedAt,
    }),

  setNodes: (arg) => set((state) => ({ nodes: resolveSetter(arg, state.nodes) })),
  setEdges: (arg) => set((state) => ({ edges: resolveSetter(arg, state.edges) })),
  setMeta: (meta) => set({ meta }),
  setCurrentId: (id) => set({ currentId: id }),
  setSelectedNodeId: (id) => set({ selectedNodeId: id }),

  reset: (targetId, draft) =>
    set({
      targetId,
      hydrated: true,
      nodes: draft.nodes,
      edges: draft.edges,
      meta: draft.meta,
      currentId: draft.currentId,
      selectedNodeId: null,
      baseline: fingerprintDraft({
        nodes: draft.nodes,
        edges: draft.edges,
        meta: draft.meta,
      }),
      past: [],
      future: [],
      lastSavedAt: draft.lastSavedAt,
    }),

  pushHistory: () =>
    set((state) => {
      const entry = snapshotOf(state);
      const past = [...state.past, entry];
      // Bound memory: drop the oldest snapshots beyond the cap.
      if (past.length > MAX_HISTORY) {
        past.splice(0, past.length - MAX_HISTORY);
      }
      return { past, future: [] };
    }),

  captureSnapshot: (): EditorSnapshot => {
    const state = get();
    return snapshotOf(state);
  },

  commitHistory: (snapshot) =>
    set((state) => {
      const past = [...state.past, cloneSnapshot(snapshot)];
      if (past.length > MAX_HISTORY) {
        past.splice(0, past.length - MAX_HISTORY);
      }
      return { past, future: [] };
    }),

  undo: () =>
    set((state) => {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1];
      if (previous === undefined) return state;
      const current = snapshotOf(state);
      const restored = cloneSnapshot(previous);
      return {
        past: state.past.slice(0, -1),
        future: [...state.future, current],
        nodes: restored.nodes,
        edges: restored.edges,
        meta: restored.meta,
        // The restored node may no longer exist; clear any stale selection.
        selectedNodeId: null,
      };
    }),

  redo: () =>
    set((state) => {
      if (state.future.length === 0) return state;
      const next = state.future[state.future.length - 1];
      if (next === undefined) return state;
      const current = snapshotOf(state);
      const restored = cloneSnapshot(next);
      return {
        future: state.future.slice(0, -1),
        past: [...state.past, current],
        nodes: restored.nodes,
        edges: restored.edges,
        meta: restored.meta,
        selectedNodeId: null,
      };
    }),

  markSaved: () =>
    set((state) => ({
      baseline: fingerprintDraft({
        nodes: state.nodes,
        edges: state.edges,
        meta: state.meta,
      }),
      lastSavedAt: new Date().toISOString(),
    })),
}));

/**
 * Whether the live draft differs from the last saved/loaded baseline. Read by
 * the editor's Close guard to decide whether to warn about unsaved changes.
 * Computed from the current store state so callers can read it imperatively
 * (`isDraftDirty(useEditorDraftStore.getState())`) or via a selector.
 */
export function isDraftDirty(state: {
  nodes: WorkflowFlowNode[];
  edges: WorkflowFlowEdge[];
  meta: WorkflowMeta;
  baseline: string;
}): boolean {
  return (
    fingerprintDraft({
      nodes: state.nodes,
      edges: state.edges,
      meta: state.meta,
    }) !== state.baseline
  );
}
