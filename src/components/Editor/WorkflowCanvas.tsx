import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import ReactFlow, {
  Background,
  Controls,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type ReactFlowInstance,
} from "reactflow";
import "reactflow/dist/style.css";
import { useCommandStore } from "../../stores/commandStore";
import { useUIStore } from "../../stores/uiStore";
import { useWorkflowStore } from "../../stores/workflowStore";
import { useWorkflowRunStore } from "../../stores/workflowRunStore";
import {
  buildDraftForTarget,
  useEditorDraftStore,
} from "../../stores/editorDraftStore";
import { getCommandName } from "../../utils/commandLabels";
import {
  APPEND_GAP_X,
  applyRunStateToNodes,
  connectTailToNode,
  findLastNode,
  makeGraphId,
  markDropTargetEdge,
  markInsertNeighbors,
  markTakenEdges,
  removeNodeReconnecting,
  type WorkflowFlowNode,
  type WorkflowNodeData,
} from "../../utils/workflowGraph";
import { workflowNodeTypes } from "./nodes";
import { NodeInspector } from "./NodeInspector";
import { WorkflowMetaModal } from "./WorkflowMetaModal";
import { ConfirmDialog } from "../ConfirmDialog";
import { CancelIcon, RunIcon, SaveIcon } from "../icons";
import { useWorkflowCanvasPersistence } from "./useWorkflowCanvasPersistence";
import { useWorkflowCanvasDnD } from "./useWorkflowCanvasDnD";

interface WorkflowCanvasProps {
  /** Existing workflow id to edit, or `null` to start a new graph. */
  workflowId: string | null;
}

function InnerCanvas({ workflowId }: WorkflowCanvasProps): ReactElement {
  const { t } = useTranslation();
  const commands = useCommandStore((s) => s.commands);
  const workflows = useWorkflowStore((s) => s.workflows);
  const setEditorWorkflowId = useUIStore((s) => s.setEditorWorkflowId);
  const setView = useUIStore((s) => s.setView);

  // The working draft lives in the editor-draft store (not local state) so it
  // survives the editor unmounting when the user navigates to another menu
  // item and back. Store actions have stable identities, so the reactflow
  // change handlers below can depend on them without re-firing effects.
  const nodes = useEditorDraftStore((s) => s.nodes);
  const edges = useEditorDraftStore((s) => s.edges);
  const meta = useEditorDraftStore((s) => s.meta);
  const currentId = useEditorDraftStore((s) => s.currentId);
  const selectedNodeId = useEditorDraftStore((s) => s.selectedNodeId);
  const setNodes = useEditorDraftStore((s) => s.setNodes);
  const setEdges = useEditorDraftStore((s) => s.setEdges);
  const setMeta = useEditorDraftStore((s) => s.setMeta);
  const setCurrentId = useEditorDraftStore((s) => s.setCurrentId);
  const setSelectedNodeId = useEditorDraftStore((s) => s.setSelectedNodeId);
  const hydrate = useEditorDraftStore((s) => s.hydrate);
  const reset = useEditorDraftStore((s) => s.reset);

  const [metaModalOpen, setMetaModalOpen] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

  const flowWrapperRef = useRef<HTMLDivElement | null>(null);
  const rfInstanceRef = useRef<ReactFlowInstance<
    WorkflowNodeData,
    unknown
  > | null>(null);

  // Reimplement reactflow's change handlers against the store setters. The
  // setters accept an updater fn (matching reactflow's `useNodesState`
  // contract), so `applyNodeChanges` / `applyEdgeChanges` fold each batch of
  // changes onto the previous draft. Stable identities (store actions +
  // useCallback) keep these out of any effect re-fire loop.
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((nds) => applyNodeChanges(changes, nds));
    },
    [setNodes],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges((eds) => applyEdgeChanges(changes, eds));
    },
    [setEdges],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      // reactflow's Connection carries nullable source/target, but onConnect
      // only fires for a completed handle-to-handle drag, so both are present.
      // Guard explicitly rather than asserting non-null.
      if (connection.source === null || connection.target === null) return;
      // Stamp a stable edge id so the graph converter and run-store edge ids
      // line up. reactflow would otherwise synthesise its own id.
      const edge: Edge = {
        id: makeGraphId("edge"),
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle,
        targetHandle: connection.targetHandle,
      };
      setEdges((eds) => addEdge(edge, eds));
    },
    [setEdges],
  );

  const onNodeClick = useCallback(
    (_event: unknown, node: Node<WorkflowNodeData>) => {
      setSelectedNodeId(node.id);
    },
    [setSelectedNodeId],
  );

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, [setSelectedNodeId]);

  // Delete a connection by clicking it. reactflow's `applyEdgeChanges`
  // (wired into `onEdgesChange`) also handles removal via the Delete /
  // Backspace keys when an edge is selected, but click-to-remove is the
  // most discoverable affordance, so we expose it directly.
  const onEdgeClick = useCallback(
    (_event: unknown, edge: Edge) => {
      setEdges((eds) => eds.filter((e) => e.id !== edge.id));
    },
    [setEdges],
  );

  const makeNode = useCallback(
    (
      kind: "command" | "condition" | "end",
      commandId: string | undefined,
      position: { x: number; y: number },
    ): WorkflowFlowNode => ({
      id: makeGraphId("node"),
      type: kind,
      position,
      data: { kind, commandId },
    }),
    [],
  );

  const addNode = useCallback(
    (
      kind: "command" | "condition" | "end",
      commandId: string | undefined,
      position: { x: number; y: number },
    ) => {
      setNodes((nds) => [...nds, makeNode(kind, commandId, position)]);
    },
    [setNodes, makeNode],
  );

  // Append a node to the right of the current tail, connected via the tail's
  // `out` port — the shared placement used by palette click-to-add and the
  // "+ End" button. Falls back to a fixed spot + unconnected when there is no
  // attachable tail (shouldn't happen — there is always a `start`).
  const appendNodeToTail = useCallback(
    (kind: "command" | "condition" | "end", commandId: string | undefined) => {
      const { nodes: curNodes, edges: curEdges } =
        useEditorDraftStore.getState();
      const tailId = findLastNode(curNodes, curEdges);
      const anchor =
        tailId === null
          ? undefined
          : curNodes.find((n) => n.id === tailId)?.position;
      const position =
        anchor === undefined
          ? { x: 240, y: 120 }
          : { x: anchor.x + APPEND_GAP_X, y: anchor.y };
      const newNode = makeNode(kind, commandId, position);
      const next = connectTailToNode(curNodes, curEdges, tailId, newNode);
      setNodes(next.nodes);
      setEdges(next.edges);
    },
    [makeNode, setNodes, setEdges],
  );

  // Click a palette command (instead of dragging) to append it after the
  // current tail. A drag never fires click, so the two affordances do not
  // conflict.
  const onPaletteCommandClick = useCallback(
    (commandId: string): void => {
      appendNodeToTail("command", commandId);
    },
    [appendNodeToTail],
  );

  // Palette drag-and-drop (drag-over insert hint + drop placement). The hint
  // state (`dropTargetEdgeId`, `insertPreviewPos`) lives in the hook and is
  // read by the display memos below.
  const {
    dropTargetEdgeId,
    insertPreviewPos,
    onDragOver,
    onDragLeave,
    onDrop,
    onPaletteDragStart,
  } = useWorkflowCanvasDnD({
    flowWrapperRef,
    rfInstanceRef,
    makeNode,
    setNodes,
    setEdges,
  });

  // Save / run / meta-save lifecycle + the presentational `activeRunId`
  // highlight state.
  const { save, run, saveMeta, activeRunId, setActiveRunId } =
    useWorkflowCanvasPersistence({
      meta,
      nodes,
      edges,
      currentId,
      setCurrentId,
      setMeta,
      setEditorWorkflowId,
      setMetaModalOpen,
      appendNodeToTail,
      onSaved: () => setView("library"),
      t,
    });

  // Hydrate the canvas only on a genuine TARGET switch — a navigation to a
  // different workflow id (or new ↔ existing). When the draft store already
  // holds this same `workflowId` (the remount-after-navigation case), the
  // in-progress draft is preserved verbatim. An unknown id (the workflow was
  // deleted out from under us) falls back to a fresh graph, owned by
  // `buildDraftForTarget`.
  useEffect(() => {
    const { hydrated, targetId } = useEditorDraftStore.getState();
    if (hydrated && targetId === workflowId) {
      // Same target remount: preserve the existing draft (including unsaved
      // edits). Reset only the transient highlighting.
      setActiveRunId(null);
      return;
    }
    hydrate(workflowId, buildDraftForTarget(workflowId, workflows));
    setActiveRunId(null);
    // `workflows` intentionally excluded: re-hydrating on every store write
    // (e.g. our own save) would clobber in-progress canvas edits. We only
    // reload when the navigation target id changes. `buildDraftForTarget`
    // reads the latest `workflows` at call time regardless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId, hydrate]);

  // Live highlighting: subscribe to the active run and overlay node/edge
  // state. Reading a single run by id keeps the selector stable.
  const activeRun = useWorkflowRunStore((s) =>
    activeRunId === null ? undefined : s.runs[activeRunId],
  );

  const displayNodes = useMemo(
    () =>
      markInsertNeighbors(
        applyRunStateToNodes(nodes, activeRun?.nodes),
        edges,
        dropTargetEdgeId,
      ),
    [nodes, edges, activeRun, dropTargetEdgeId],
  );
  const displayEdges = useMemo(
    () =>
      markDropTargetEdge(
        markTakenEdges(edges, activeRun?.takenEdgeIds),
        dropTargetEdgeId,
      ),
    [edges, activeRun, dropTargetEdgeId],
  );

  // A workflow is runnable only once it has at least one real step beyond the
  // mandatory `start` node. The Run button is disabled until then.
  const hasSteps = useMemo(
    () => nodes.some((n) => (n.type ?? n.data.kind) !== "start"),
    [nodes],
  );

  // When editing an EXISTING workflow, the destructive toolbar action reverts
  // to the saved version — that reads as "Cancel" (discard edits). For a NEW
  // draft it empties the canvas — that reads as "Clear". The behaviour is the
  // same `confirmClear`; only the label + confirm copy differ.
  const isEditingExisting = currentId !== null;

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );

  const handleNodeCommandChange = useCallback(
    (nodeId: string, commandId: string | undefined): void => {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...n.data, commandId } }
            : n,
        ),
      );
    },
    [setNodes],
  );

  const handleDeleteNode = useCallback(
    (nodeId: string): void => {
      // Re-stitch the deleted node's neighbours: bridge each predecessor to
      // each successor so a node removed from the middle of a chain leaves
      // `A → B` connected rather than two dangling ends. Reads the live graph
      // from the store and applies nodes + edges together so the bridge edges
      // are computed against a consistent snapshot.
      const { nodes: curNodes, edges: curEdges } =
        useEditorDraftStore.getState();
      const next = removeNodeReconnecting(curNodes, curEdges, nodeId);
      setNodes(next.nodes);
      setEdges(next.edges);
      setSelectedNodeId(null);
    },
    [setNodes, setEdges, setSelectedNodeId],
  );

  // Reset the canvas to its initial state, discarding unsaved edits. For an
  // existing workflow (`currentId !== null`) "initial" means the SAVED
  // version reloaded from the workflow store; for a new workflow it means a
  // fresh single `start`-node graph with empty metadata — both handled by
  // `buildDraftForTarget(currentId, …)`. A destructive action, so it is
  // gated behind the app-styled `ConfirmDialog`. `activeRunId` is cleared so
  // stale highlighting does not linger.
  const confirmClear = useCallback((): void => {
    reset(currentId, buildDraftForTarget(currentId, workflows));
    setActiveRunId(null);
    setClearConfirmOpen(false);
  }, [reset, currentId, workflows, setActiveRunId]);

  return (
    <div className="wf-editor">
      <aside className="wf-palette">
        <div className="wf-palette__section">
          <h3 className="wf-palette__title">{t("editor.palette.nodes")}</h3>
          <button
            type="button"
            className="btn btn--ghost wf-palette__btn"
            onClick={() =>
              addNode("condition", undefined, { x: 240, y: 200 })
            }
          >
            + {t("editor.nodes.condition")}
          </button>
          <button
            type="button"
            className="btn btn--ghost wf-palette__btn"
            onClick={() => appendNodeToTail("end", undefined)}
          >
            + {t("editor.nodes.end")}
          </button>
        </div>
        <div className="wf-palette__section">
          <h3 className="wf-palette__title">{t("editor.palette.commands")}</h3>
          <p className="wf-palette__hint">{t("editor.palette.dragHint")}</p>
          <div className="wf-palette__list">
            {commands.map((cmd) => (
              <button
                key={cmd.id}
                type="button"
                className="wf-palette__item"
                draggable
                onDragStart={(e) => onPaletteDragStart(e, cmd.id)}
                onClick={() => onPaletteCommandClick(cmd.id)}
                title={t("editor.palette.clickHint")}
              >
                {getCommandName(cmd, t)}
              </button>
            ))}
            {commands.length === 0 ? (
              <p className="wf-palette__hint">
                {t("editor.palette.noCommands")}
              </p>
            ) : null}
          </div>
        </div>
      </aside>

      <div className="wf-canvas" ref={flowWrapperRef}>
        <div className="wf-toolbar">
          <span className="wf-toolbar__name">
            {meta.name.trim() === ""
              ? t("editor.untitled")
              : meta.name}
          </span>
          <div className="wf-toolbar__spacer" />
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setMetaModalOpen(true)}
          >
            {t("editor.details")}
          </button>
          <button
            type="button"
            className="btn command-form__action command-form__action--run"
            disabled={!hasSteps}
            onClick={() => {
              void run();
            }}
          >
            <span className="command-form__action-icon--run">
              <RunIcon />
            </span>
            {t("common.run")}
          </button>
          <button
            type="button"
            className="btn command-form__action command-form__action--cancel"
            onClick={() => setClearConfirmOpen(true)}
          >
            <span className="command-form__action-icon--cancel">
              <CancelIcon />
            </span>
            {isEditingExisting ? t("editor.cancel") : t("editor.clear")}
          </button>
          <button
            type="button"
            className="btn btn--primary command-form__action"
            onClick={save}
          >
            <SaveIcon />
            {t("common.save")}
          </button>
        </div>
        <ReactFlow
          nodes={displayNodes}
          edges={displayEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          onEdgeClick={onEdgeClick}
          onInit={(instance) => {
            rfInstanceRef.current = instance;
          }}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          nodeTypes={workflowNodeTypes}
          deleteKeyCode={["Backspace", "Delete"]}
          fitView
          fitViewOptions={{ maxZoom: 0.8 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
        </ReactFlow>
        {insertPreviewPos !== null ? (
          <div
            className="wf-insert-hint"
            style={{
              left: insertPreviewPos.x,
              top: insertPreviewPos.y,
            }}
            aria-hidden="true"
          >
            <div className="wf-insert-hint__label">
              {t("editor.insertPreview")}
            </div>
            <div className="wf-node wf-node--insert-preview" />
          </div>
        ) : null}
      </div>

      {selectedNode !== null ? (
        <NodeInspector
          node={selectedNode}
          commands={commands}
          onCommandChange={handleNodeCommandChange}
          onDelete={handleDeleteNode}
          onClose={() => setSelectedNodeId(null)}
        />
      ) : null}

      {metaModalOpen ? (
        <WorkflowMetaModal
          initial={meta}
          onSave={saveMeta}
          onClose={() => setMetaModalOpen(false)}
        />
      ) : null}

      <ConfirmDialog
        open={clearConfirmOpen}
        title={
          isEditingExisting
            ? t("editor.cancelConfirmTitle")
            : t("editor.clearConfirmTitle")
        }
        message={
          isEditingExisting
            ? t("editor.cancelConfirm")
            : t("editor.clearConfirm")
        }
        confirmLabel={isEditingExisting ? t("editor.discard") : t("common.clear")}
        danger
        onConfirm={confirmClear}
        onCancel={() => setClearConfirmOpen(false)}
      />
    </div>
  );
}

/**
 * Visual workflow editor. Wraps the canvas in a `ReactFlowProvider` so hooks
 * like `useReactFlow` work inside the tree. `workflowId` is the navigation
 * contract from Phase 4 (`null` = new). Keyed by `workflowId` in the parent
 * so switching targets fully remounts the canvas state.
 */
export function WorkflowCanvas(props: WorkflowCanvasProps): ReactElement {
  return (
    <ReactFlowProvider>
      <InnerCanvas {...props} />
    </ReactFlowProvider>
  );
}
