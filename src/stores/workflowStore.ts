import { Message } from "@arco-design/web-react";
import { create } from "zustand";
import type { Workflow } from "../types";
import {
  deleteWorkflowInDb,
  listWorkflowsFromDb,
  upsertWorkflowInDb,
} from "../utils/workflowRepository";

/**
 * Public shape for `addWorkflow` input. The store materialises `id`,
 * timestamps, and `runCount`, so callers only supply the editable fields.
 */
type NewWorkflowInput = Omit<
  Workflow,
  "id" | "createdAt" | "updatedAt" | "runCount"
>;

interface WorkflowState {
  workflows: Workflow[];
  /**
   * Whether the store has finished its initial load from SQLite. The UI
   * can show a brief placeholder until this flips to `true`; after that
   * point `workflows` reflects the persisted state.
   */
  hydrated: boolean;
  /**
   * Load every workflow from the Rust-backed SQLite store and replace the
   * in-memory state. Idempotent: calling twice yields the same result.
   */
  hydrateFromDb: () => Promise<void>;
  /**
   * Persist a new workflow and return its concrete materialised form
   * (with generated id + timestamps). Returning the value lets the
   * `workflowActions` history wrapper record a `workflowCreated` event
   * carrying the exact snapshot that landed in the store.
   */
  addWorkflow: (w: NewWorkflowInput) => Workflow;
  /**
   * Apply a patch to the workflow identified by `id`. Returns
   * `{ before, after }` for the history wrapper, or `null` when the id
   * was not found (the wrapper skips history in that case).
   */
  updateWorkflow: (
    id: string,
    patch: Partial<Workflow>,
  ) => { before: Workflow; after: Workflow } | null;
  /**
   * Remove the workflow and return the snapshot that was deleted (so the
   * history wrapper can persist it for restore). Returns `null` when the
   * id did not exist.
   */
  deleteWorkflow: (id: string) => Workflow | null;
  toggleFavorite: (id: string) => void;
  markWorkflowRun: (id: string) => void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `wf-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/**
 * Fire-and-forget persistence helper. The store updates state
 * optimistically, then writes through to SQLite in the background. On
 * failure we surface an Arco toast and log the error; the in-memory state
 * is left as-is so the user does not lose their edit (the next mutation
 * will retry the upsert).
 */
function persistUpsert(wf: Workflow): void {
  void upsertWorkflowInDb(wf).catch((err: unknown) => {
    console.error("failed to persist workflow", wf.id, err);
    Message.error("Failed to save workflow");
  });
}

function persistDelete(id: string): void {
  void deleteWorkflowInDb(id).catch((err: unknown) => {
    console.error("failed to delete workflow", id, err);
    Message.error("Failed to delete workflow");
  });
}

export const useWorkflowStore = create<WorkflowState>()((set) => ({
  workflows: [],
  hydrated: false,
  hydrateFromDb: async () => {
    try {
      const workflows = await listWorkflowsFromDb();
      set({ workflows, hydrated: true });
    } catch (err: unknown) {
      console.error("failed to hydrate workflows from db", err);
      // Still flip `hydrated` so the UI does not stay blank forever if the
      // first IPC call ever fails.
      set({ hydrated: true });
    }
  },
  addWorkflow: (input) => {
    const ts = nowIso();
    const newWorkflow: Workflow = {
      ...input,
      id: makeId(),
      createdAt: ts,
      updatedAt: ts,
      runCount: 0,
    };
    set((state) => ({
      workflows: [...state.workflows, newWorkflow],
    }));
    persistUpsert(newWorkflow);
    return newWorkflow;
  },
  updateWorkflow: (id, patch) => {
    let before: Workflow | undefined;
    let after: Workflow | undefined;
    set((state) => ({
      workflows: state.workflows.map((w) => {
        if (w.id !== id) return w;
        before = w;
        const next: Workflow = { ...w, ...patch, updatedAt: nowIso() };
        after = next;
        return next;
      }),
    }));
    if (before && after) {
      persistUpsert(after);
      return { before, after };
    }
    return null;
  },
  deleteWorkflow: (id) => {
    let removed: Workflow | undefined;
    set((state) => {
      const target = state.workflows.find((w) => w.id === id);
      if (target) {
        removed = target;
      }
      return {
        workflows: state.workflows.filter((w) => w.id !== id),
      };
    });
    // Always issue the delete IPC — SQLite treats a missing id as a no-op.
    // Only the *return value* is conditional on whether the workflow was
    // present in-memory: the history wrapper needs the actual snapshot to
    // record `workflowDeleted`, and there's nothing to record when the id
    // was unknown.
    persistDelete(id);
    return removed ?? null;
  },
  toggleFavorite: (id) => {
    let updated: Workflow | undefined;
    set((state) => ({
      workflows: state.workflows.map((w) => {
        if (w.id !== id) return w;
        const next: Workflow = {
          ...w,
          favorite: !w.favorite,
          updatedAt: nowIso(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) persistUpsert(updated);
  },
  markWorkflowRun: (id) => {
    let updated: Workflow | undefined;
    set((state) => ({
      workflows: state.workflows.map((w) => {
        if (w.id !== id) return w;
        const next: Workflow = {
          ...w,
          runCount: w.runCount + 1,
          lastRunAt: nowIso(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) persistUpsert(updated);
  },
}));
