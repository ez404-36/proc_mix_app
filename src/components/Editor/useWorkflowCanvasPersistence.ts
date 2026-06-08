import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Message } from "@arco-design/web-react";
import type { TFunction } from "i18next";
import type { Edge } from "reactflow";
import { useEditorDraftStore } from "../../stores/editorDraftStore";
import {
  createWorkflow,
  updateWorkflow,
} from "../../services/workflowActions";
import { triggerWorkflowRun } from "../../services/workflowRunner";
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
  save: () => void;
  run: () => Promise<void>;
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

  const handleSave = useCallback((): void => {
    // Draft save is permitted even with warnings, but a name is required and
    // hard errors still surface so the user knows the graph won't run yet.
    if (meta.name.trim() === "") {
      setMetaModalOpen(true);
      return;
    }
    reportValidation();
    persist(meta.name.trim());
    Message.success(t("editor.saved"));
    onSaved();
  }, [meta.name, reportValidation, persist, t, setMetaModalOpen, onSaved]);

  const handleRun = useCallback(async (): Promise<void> => {
    // Running does NOT require saving. The Rust `execute_workflow` command
    // takes the full graph from the frontend and only resolves the
    // referenced *commands* from storage (handled inside
    // `triggerWorkflowRun`), so an unsaved draft runs verbatim. We still
    // validate — a structurally broken graph can't run — but we never force
    // a save or a name prompt here.
    // Auto-complete the graph: if the user never added an `end` node, append
    // one after the current tail before running, so a linear chain is
    // runnable without the manual final step. We mutate the live draft store
    // (so the canvas reflects it) AND read the augmented graph back from the
    // store for this run — building from stale closure `nodes`/`edges` would
    // miss the just-added end.
    const hasEnd = nodes.some((n) => (n.type ?? n.data.kind) === "end");
    if (!hasEnd) {
      appendNodeToTail("end", undefined);
    }

    // Validate the LIVE graph (read back from the store) so the just-added
    // end node is accounted for — `buildDraftWorkflow` reads stale closure
    // state that predates the append above.
    const live = useEditorDraftStore.getState();
    const draftGraph = flowToWorkflow(
      {
        name: meta.name,
        description: meta.description,
        icon: meta.icon,
        tags: meta.tags,
        categoryId: meta.categoryId,
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
    if (!runnable) return;

    const trimmedName = meta.name.trim();
    const now = new Date().toISOString();
    // Reuse the persisted id when this session was already saved so the
    // history `workflowRun` row links back to the stored workflow; otherwise
    // mint a transient id for this run. An unsaved name falls back to the
    // localized "Untitled" label used by the toolbar.
    const draft: Workflow = {
      ...draftGraph,
      name: trimmedName === "" ? t("editor.untitled") : trimmedName,
      id: currentId ?? makeGraphId("node"),
      favorite: false,
      createdAt: now,
      updatedAt: now,
      runCount: 0,
    };
    const runId = await triggerWorkflowRun(draft);
    if (runId !== null) {
      setActiveRunId(runId);
    }
  }, [nodes, meta, appendNodeToTail, currentId, t]);

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
      onSaved();
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
      onSaved,
      t,
    ],
  );

  return {
    save: handleSave,
    run: handleRun,
    saveMeta: handleMetaSave,
    activeRunId,
    setActiveRunId,
  };
}
