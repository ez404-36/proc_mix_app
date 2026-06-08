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
      };
    }
  }
  const initial = makeInitialFlow();
  return {
    nodes: initial.nodes,
    edges: initial.edges,
    meta: EMPTY_META,
    currentId: null,
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

  /** Replace the whole draft for a navigation target. */
  hydrate: (targetId: string | null, draft: EditorDraft) => void;
  setNodes: (arg: SetterArg<WorkflowFlowNode[]>) => void;
  setEdges: (arg: SetterArg<WorkflowFlowEdge[]>) => void;
  setMeta: (meta: WorkflowMeta) => void;
  setCurrentId: (id: string | null) => void;
  setSelectedNodeId: (id: string | null) => void;
  /** Replace the draft with a fresh build for `targetId` (used by Clear). */
  reset: (targetId: string | null, draft: EditorDraft) => void;
}

export const useEditorDraftStore = create<EditorDraftState>()((set) => ({
  targetId: null,
  hydrated: false,
  nodes: [],
  edges: [],
  meta: EMPTY_META,
  currentId: null,
  selectedNodeId: null,

  hydrate: (targetId, draft) =>
    set({
      targetId,
      hydrated: true,
      nodes: draft.nodes,
      edges: draft.edges,
      meta: draft.meta,
      currentId: draft.currentId,
      selectedNodeId: null,
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
    }),
}));
