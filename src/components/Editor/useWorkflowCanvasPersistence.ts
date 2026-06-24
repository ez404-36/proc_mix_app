import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Message } from "@arco-design/web-react";
import type { TFunction } from "i18next";
import type { Edge } from "@xyflow/react";
import { useEditorDraftStore } from "../../stores/editorDraftStore";
import {
  createWorkflow,
  updateWorkflow,
} from "../../services/workflowActions";
import {
  triggerWorkflowRun,
  triggerWorkflowRunFromNode,
} from "../../services/workflowRunner";
import {
  flowToWorkflow,
  makeGraphId,
  type WorkflowFlowNode,
} from "../../utils/workflowGraph";
import { validateWorkflow } from "../../utils/workflowValidation";
import type { Workflow } from "../../types";
import type { WorkflowMeta } from "./WorkflowMetaModal";

interface UseWorkflowCanvasPersistenceArgs {
  meta: WorkflowMeta;
  nodes: WorkflowFlowNode[];
  edges: Edge[];
  currentId: string | null;
  setCurrentId: (id: string | null) => void;
  setMeta: (meta: WorkflowMeta) => void;
  setEditorWorkflowId: (id: string | null) => void;
  setMetaModalOpen: Dispatch<SetStateAction<boolean>>;
  appendNodeToTail: (
    kind: "command" | "condition" | "end",
    commandId: string | undefined,
  ) => void;
  onSaved: () => void;
  t: TFunction;
}

interface UseWorkflowCanvasPersistence {
  /**
   * Persist the draft and stay in the editor (clears the dirty baseline).
   * Used by the header "Save" button.
   */
  save: () => void;
  /**
   * Persist the draft and navigate away (to the workflow list). Used by the
   * header "Save & Exit" button.
   */
  saveAndExit: () => void;
  run: () => Promise<void>;
  /** Run a single node and everything downstream of it (the editor's per-node
   * run action), seeding the node's input with `seedInput`. */
  runNode: (nodeId: string, seedInput: string | null) => Promise<void>;
  saveMeta: (next: WorkflowMeta) => void;
  activeRunId: string | null;
  setActiveRunId: Dispatch<SetStateAction<string | null>>;
}

/**
 * Persistence and run lifecycle for the workflow canvas. Owns the
 * presentational `activeRunId` highlight state and the save/run/meta-save
 * handlers, all extracted verbatim from `WorkflowCanvas` to keep that
 * component a thin composition point.
 */
export function useWorkflowCanvasPersistence({
  meta,
  nodes,
  edges,
  currentId,
  setCurrentId,
  setMeta,
  setEditorWorkflowId,
  setMetaModalOpen,
  appendNodeToTail,
  onSaved,
  t,
}: UseWorkflowCanvasPersistenceArgs): UseWorkflowCanvasPersistence {
  // The active run id for THIS workflow, used to read live progress. Kept as
  // local component state: it is purely presentational (graph highlighting),
  // and resetting it when the editor remounts after navigation is acceptable
  // — the run itself continues in the background and is unaffected.
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const buildDraftWorkflow = useCallback((): ReturnType<typeof flowToWorkflow> => {
    return flowToWorkflow(
      {
        name: meta.name,
        description: meta.description,
        icon: meta.icon,
        tags: meta.tags,
        categoryId: meta.categoryId,
        apiEnabled: meta.apiEnabled,
        apiSlug: meta.apiSlug,
      },
      nodes,
      edges,
    );
  }, [meta, nodes, edges]);

  // Surface every validation problem as one toast. Errors are shown as error
  // toasts, warnings as warning toasts. Returns whether the graph is runnable.
  const reportValidation = useCallback((): boolean => {
    const draft = buildDraftWorkflow();
    const { problems, runnable } = validateWorkflow(draft);
    for (const problem of problems) {
      const text = t(problem.key, problem.params);
      if (problem.severity === "error") {
        Message.error(text);
      } else {
        Message.warning(text);
      }
    }
    return runnable;
  }, [buildDraftWorkflow, t]);

  const persist = useCallback(
    (name: string): string => {
      const draft = buildDraftWorkflow();
      const withName = { ...draft, name };
      if (currentId === null) {
        const created = createWorkflow({
          ...withName,
          favorite: false,
        });
        setCurrentId(created.id);
        setEditorWorkflowId(created.id);
        return created.id;
      }
      updateWorkflow(currentId, withName);
      return currentId;
    },
    [buildDraftWorkflow, currentId, setCurrentId, setEditorWorkflowId],
  );

  // Shared save body. `navigate` decides whether to leave the editor after a
  // successful save ("Save & Exit") or stay with a freshly-marked baseline
  // ("Save"). A blank name routes to the Properties modal in both cases.
  const saveDraft = useCallback(
    (navigate: boolean): void => {
      // Draft save is permitted even with warnings, but a name is required and
      // hard errors still surface so the user knows the graph won't run yet.
      if (meta.name.trim() === "") {
        setMetaModalOpen(true);
        return;
      }
      reportValidation();
      persist(meta.name.trim());
      Message.success(t("editor.saved"));
      if (navigate) {
        onSaved();
      } else {
        // Stay in the editor: the just-saved graph becomes the dirty baseline
        // so the unsaved-changes guard no longer flags it.
        useEditorDraftStore.getState().markSaved();
      }
    },
    [meta.name, reportValidation, persist, t, setMetaModalOpen, onSaved],
  );

  const handleSave = useCallback((): void => {
    saveDraft(false);
  }, [saveDraft]);

  const handleSaveAndExit = useCallback((): void => {
    saveDraft(true);
  }, [saveDraft]);

  // Build a runnable `Workflow` draft from the LIVE editor graph, validating
  // it and surfacing problems as toasts. Auto-appends an `end` node when the
  // user never added one so a linear chain is runnable. Returns `null` when
  // the graph has a blocking error (the caller aborts). Shared by the full-run
  // and the per-node run paths.
  const buildRunnableDraft = useCallback((): Workflow | null => {
    const hasEnd = nodes.some((n) => (n.type ?? n.data.kind) === "end");
    if (!hasEnd) {
      appendNodeToTail("end", undefined);
    }

    // Validate the LIVE graph (read back from the store) so the just-added
    // end node is accounted for.
    const live = useEditorDraftStore.getState();
    const draftGraph = flowToWorkflow(
      {
        name: meta.name,
        description: meta.description,
        icon: meta.icon,
        tags: meta.tags,
        categoryId: meta.categoryId,
        apiEnabled: meta.apiEnabled,
        apiSlug: meta.apiSlug,
      },
      live.nodes,
      live.edges,
    );
    const { problems, runnable } = validateWorkflow(draftGraph);
    for (const problem of problems) {
      const text = t(problem.key, problem.params);
      if (problem.severity === "error") {
        Message.error(text);
      } else {
        Message.warning(text);
      }
    }
    if (!runnable) return null;

    const trimmedName = meta.name.trim();
    const now = new Date().toISOString();
    // Reuse the persisted id when this session was already saved so the
    // history `workflowRun` row links back to the stored workflow; otherwise
    // mint a transient id for this run.
    return {
      ...draftGraph,
      name: trimmedName === "" ? t("editor.untitled") : trimmedName,
      id: currentId ?? makeGraphId("node"),
      favorite: false,
      createdAt: now,
      updatedAt: now,
      runCount: 0,
    };
  }, [nodes, meta, appendNodeToTail, currentId, t]);

  const handleRun = useCallback(async (): Promise<void> => {
    // Running does NOT require saving — the engine takes the full graph from
    // the frontend and resolves only the referenced commands from storage.
    const draft = buildRunnableDraft();
    if (draft === null) return;
    const runId = await triggerWorkflowRun(draft);
    if (runId !== null) {
      setActiveRunId(runId);
    }
  }, [buildRunnableDraft, setActiveRunId]);

  // Run a single node and everything downstream of it, seeding the node's
  // input with `seedInput` (its example-input text, or `null` when empty).
  // Reuses the same validate/auto-end-append pipeline as a full run.
  const handleRunNode = useCallback(
    async (nodeId: string, seedInput: string | null): Promise<void> => {
      const draft = buildRunnableDraft();
      if (draft === null) return;
      const runId = await triggerWorkflowRunFromNode(draft, nodeId, seedInput);
      if (runId !== null) {
        setActiveRunId(runId);
      }
    },
    [buildRunnableDraft, setActiveRunId],
  );

  const handleMetaSave = useCallback(
    (next: WorkflowMeta): void => {
      setMeta(next);
      setMetaModalOpen(false);
      // Persist immediately so the just-entered name/description are not lost
      // if the user navigates away before clicking Save again.
      reportValidation();
      const draft = flowToWorkflow(
        {
          name: next.name,
          description: next.description,
          icon: next.icon,
          tags: next.tags,
          categoryId: next.categoryId,
        },
        nodes,
        edges,
      );
      if (currentId === null) {
        const created = createWorkflow({ ...draft, favorite: false });
        setCurrentId(created.id);
        setEditorWorkflowId(created.id);
      } else {
        updateWorkflow(currentId, draft);
      }
      Message.success(t("editor.saved"));
      // Saving from the Properties modal keeps the user in the editor (the
      // name they just entered lets them continue). Mark the saved baseline so
      // the unsaved-changes guard reflects the persisted state.
      useEditorDraftStore.getState().markSaved();
    },
    [
      nodes,
      edges,
      currentId,
      reportValidation,
      setMeta,
      setCurrentId,
      setEditorWorkflowId,
      setMetaModalOpen,
      t,
    ],
  );

  return {
    save: handleSave,
    saveAndExit: handleSaveAndExit,
    run: handleRun,
    runNode: handleRunNode,
    saveMeta: handleMetaSave,
    activeRunId,
    setActiveRunId,
  };
}
