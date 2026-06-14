import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import ReactFlow, {
  Background,
  Controls,
  ControlButton,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
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
import type { WorkflowNodeKind } from "../../types";
import { getCommandName } from "../../utils/commandLabels";
import { nodeRunOutput } from "../../utils/nodePreviewData";
import {
  APPEND_GAP_X,
  applyRunStateToNodes,
  connectTailToNode,
  findEdgeNearPoint,
  findLastNode,
  findSinglePredecessor,
  insertPreviewPoint,
  isUnconnectedNode,
  makeGraphId,
  markDropTargetEdge,
  markInsertNeighbors,
  markTakenEdges,
  removeNodeReconnecting,
  spliceExistingNodeOnEdge,
  type WorkflowFlowNode,
  type WorkflowNodeData,
} from "../../utils/workflowGraph";

/**
 * Node kinds the palette can create. Every kind except `start` (which is
 * created once by `makeInitialFlow` and never added) can be placed.
 */
type PaletteNodeKind = Exclude<WorkflowNodeKind, "start">;
import { workflowNodeTypes } from "./nodes";
import { NodeInspector } from "./NodeInspector";
import { WorkflowMetaModal } from "./WorkflowMetaModal";
import { ConfirmDialog } from "../ConfirmDialog";
import {
  CancelIcon,
  FitViewIcon,
  FullscreenIcon,
  RunIcon,
  SaveIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "../icons";
import { useWorkflowCanvasPersistence } from "./useWorkflowCanvasPersistence";
import { useWorkflowCanvasDnD } from "./useWorkflowCanvasDnD";

interface WorkflowCanvasProps {
  /** Existing workflow id to edit, or `null` to start a new graph. */
  workflowId: string | null;
}

interface WorkflowControlsProps {
  interactive: boolean;
  onToggleInteractive: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}

/**
 * Canvas controls bar — a localized replacement for reactflow's default
 * `<Controls>` (whose button tooltips are hardcoded English). Reuses the
 * reactflow `Controls` shell (positioning + styling) but disables its built-in
 * buttons and renders our own `ControlButton`s with Russian labels + app
 * icons, plus a fullscreen toggle that expands the whole editor. Rendered
 * inside `<ReactFlow>` so `useReactFlow` (zoom / fit) has context.
 */
function WorkflowControls({
  interactive,
  onToggleInteractive,
  fullscreen,
  onToggleFullscreen,
}: WorkflowControlsProps): ReactElement {
  const { t } = useTranslation();
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  return (
    <Controls
      showZoom={false}
      showFitView={false}
      showInteractive={false}
    >
      <ControlButton
        onClick={() => zoomIn()}
        title={t("editor.controls.zoomIn")}
        aria-label={t("editor.controls.zoomIn")}
      >
        <ZoomInIcon />
      </ControlButton>
      <ControlButton
        onClick={() => zoomOut()}
        title={t("editor.controls.zoomOut")}
        aria-label={t("editor.controls.zoomOut")}
      >
        <ZoomOutIcon />
      </ControlButton>
      <ControlButton
        onClick={() => fitView()}
        title={t("editor.controls.fitView")}
        aria-label={t("editor.controls.fitView")}
      >
        <FitViewIcon />
      </ControlButton>
      <ControlButton
        onClick={onToggleInteractive}
        title={
          interactive
            ? t("editor.controls.lock")
            : t("editor.controls.unlock")
        }
        aria-label={
          interactive
            ? t("editor.controls.lock")
            : t("editor.controls.unlock")
        }
        aria-pressed={!interactive}
      >
        {/* Lock state reuses the eye-style affordance via text glyph kept by
            reactflow's own button styling; the title conveys the action. */}
        {interactive ? "🔓" : "🔒"}
      </ControlButton>
      <ControlButton
        onClick={onToggleFullscreen}
        title={
          fullscreen
            ? t("editor.controls.exitFullscreen")
            : t("editor.controls.fullscreen")
        }
        aria-label={
          fullscreen
            ? t("editor.controls.exitFullscreen")
            : t("editor.controls.fullscreen")
        }
        aria-pressed={fullscreen}
      >
        <FullscreenIcon active={fullscreen} />
      </ControlButton>
    </Controls>
  );
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
  // Canvas interactivity (the "pin"/lock control): when false, nodes can't be
  // dragged / selected / connected — useful while panning a finished graph.
  const [interactive, setInteractive] = useState(true);
  // Whether the editor (palette + canvas) is expanded to fill the app window.
  const [fullscreen, setFullscreen] = useState(false);
  // While the editor is fullscreen it covers the docked OutputPanel (the
  // fullscreen layer sits above it). Toggle a body class so the console is
  // lifted ABOVE the fullscreen editor (CSS-only; see `is-editor-fullscreen`),
  // letting the user watch a run's output without leaving fullscreen. Cleared
  // on unmount so leaving the editor view never strands the class.
  useEffect(() => {
    const cls = "is-editor-fullscreen";
    document.body.classList.toggle(cls, fullscreen);
    return () => document.body.classList.remove(cls);
  }, [fullscreen]);
  // The edge highlighted while an EXISTING free-floating node is dragged over
  // it (the "insert here" hint for canvas node-drag, distinct from the palette
  // drag hint owned by the DnD hook). Null when not over an insertable edge.
  const [nodeDragEdgeId, setNodeDragEdgeId] = useState<string | null>(null);
  // Screen-space (wrapper-relative) centre of the node-drag insert preview, so
  // the same "вставить сюда" label the palette drag shows appears here too.
  const [nodeDragPreviewPos, setNodeDragPreviewPos] = useState<{
    x: number;
    y: number;
  } | null>(null);
  // Manually-typed preview samples for the node modal, keyed by node id and
  // by side ("in" / "out"). Transient editor-session state: a sample is only
  // an authoring aid shown when a node has no live run data yet, so it is not
  // persisted to the workflow graph. Cleared with the editor on navigation.
  const [manualPreviews, setManualPreviews] = useState<
    Record<string, { in?: string; out?: string }>
  >({});
  const setManualPreviewSide = useCallback(
    (nodeId: string, side: "in" | "out", value: string): void => {
      setManualPreviews((prev) => ({
        ...prev,
        [nodeId]: { ...prev[nodeId], [side]: value },
      }));
    },
    [],
  );

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

  // The flow-coordinate centre of a dragged reactflow node. `position` is its
  // top-left; reactflow measures `width`/`height` after layout, so once known
  // we offset to the centre (falls back to the top-left before measurement).
  const nodeCenter = (node: Node<WorkflowNodeData>): { x: number; y: number } => ({
    x: node.position.x + (node.width ?? 0) / 2,
    y: node.position.y + (node.height ?? 0) / 2,
  });

  // While dragging an EXISTING free-floating node (one with no edges), show the
  // "insert here" hint on the nearest edge — mirroring the palette-drop hint —
  // so the user can splice it into the chain. Connected nodes just move.
  const clearNodeDragHint = useCallback((): void => {
    setNodeDragEdgeId(null);
    setNodeDragPreviewPos(null);
  }, []);

  const onNodeDrag = useCallback(
    (_event: unknown, node: Node<WorkflowNodeData>): void => {
      const { nodes: curNodes, edges: curEdges } =
        useEditorDraftStore.getState();
      if (!isUnconnectedNode(node.id, curEdges)) {
        clearNodeDragHint();
        return;
      }
      const edgeId = findEdgeNearPoint(curNodes, curEdges, nodeCenter(node));
      // Never target an edge that already touches the node (would self-loop).
      const valid =
        edgeId !== null &&
        !curEdges.some(
          (e) =>
            e.id === edgeId && (e.source === node.id || e.target === node.id),
        );
      if (!valid || edgeId === null) {
        clearNodeDragHint();
        return;
      }
      setNodeDragEdgeId(edgeId);
      // Position the "вставить сюда" label at the edge's midpoint, converted to
      // canvas-wrapper-relative screen coords (same maths as the palette hint).
      const instance = rfInstanceRef.current;
      const wrapper = flowWrapperRef.current;
      const flowPoint = insertPreviewPoint(curNodes, curEdges, edgeId);
      if (instance === null || wrapper === null || flowPoint === null) {
        setNodeDragPreviewPos(null);
        return;
      }
      const screen = instance.flowToScreenPosition(flowPoint);
      const rect = wrapper.getBoundingClientRect();
      setNodeDragPreviewPos({ x: screen.x - rect.left, y: screen.y - rect.top });
    },
    [clearNodeDragHint],
  );

  // On drop: if the dragged free node is over an edge, splice it in (A → node
  // → B). Otherwise the drag was a plain reposition — nothing to do.
  const onNodeDragStop = useCallback(
    (_event: unknown, node: Node<WorkflowNodeData>): void => {
      const targetEdgeId = nodeDragEdgeId;
      clearNodeDragHint();
      if (targetEdgeId === null) return;
      const { nodes: curNodes, edges: curEdges } =
        useEditorDraftStore.getState();
      const next = spliceExistingNodeOnEdge(
        curNodes,
        curEdges,
        node.id,
        targetEdgeId,
      );
      if (next === null) return;
      setNodes(next.nodes);
      setEdges(next.edges);
    },
    [nodeDragEdgeId, clearNodeDragHint, setNodes, setEdges],
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
      kind: PaletteNodeKind,
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
      kind: PaletteNodeKind,
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
    (kind: PaletteNodeKind, commandId: string | undefined) => {
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
    onPaletteNodeDragStart,
  } = useWorkflowCanvasDnD({
    flowWrapperRef,
    rfInstanceRef,
    makeNode,
    setNodes,
    setEdges,
  });

  // Save / run / meta-save lifecycle + the presentational `activeRunId`
  // highlight state.
  const { save, run, runNode, saveMeta, activeRunId, setActiveRunId } =
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
  // A run (full or node-scoped) is in flight while the active run is still
  // "running"; the node modal disables its per-node run action meanwhile.
  const isRunning = activeRun?.status === "running";

  // The single edge to highlight as an insertion target: a palette drag (DnD
  // hook) and a canvas node-drag are mutually exclusive, so either source can
  // drive the hint.
  const hintEdgeId = dropTargetEdgeId ?? nodeDragEdgeId;
  // The "insert here" label position: from the palette drag (DnD hook) or the
  // canvas node-drag, whichever is active (they are mutually exclusive).
  const insertHintPos = insertPreviewPos ?? nodeDragPreviewPos;
  const displayNodes = useMemo(() => {
    const decorated = markInsertNeighbors(
      applyRunStateToNodes(nodes, activeRun?.nodes, {
        loopIterations: activeRun?.loopIterations,
        retryAttempts: activeRun?.retryAttempts,
      }),
      edges,
      hintEdgeId,
    );
    // Flag the inspected node as reactflow-`selected` so the wrapper gets the
    // `.selected` class — CSS then highlights it (border + shadow) so the user
    // sees which node the inspector is editing. Only the matching node's object
    // identity changes, keeping the rest stable for reactflow.
    return decorated.map((n) =>
      n.selected === (n.id === selectedNodeId)
        ? n
        : { ...n, selected: n.id === selectedNodeId },
    );
  }, [nodes, edges, activeRun, hintEdgeId, selectedNodeId]);
  const displayEdges = useMemo(
    () =>
      markDropTargetEdge(
        markTakenEdges(edges, activeRun?.takenEdgeIds),
        hintEdgeId,
      ),
    [edges, activeRun, hintEdgeId],
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

  // The selected node's single predecessor (or null when 0/many), so the
  // inspector can offer a `data` node the right kind-specific value sources.
  const selectedPredecessor = useMemo(
    () =>
      selectedNode === null
        ? null
        : findSinglePredecessor(selectedNode.id, nodes, edges),
    [selectedNode, nodes, edges],
  );

  // Live preview data for the node modal, resolved from the active run: the
  // selected node's own output (the "result example") and its predecessor's
  // output (this node's "input example"). Null until a run has produced data
  // for that node, in which case the modal falls back to a manual sample.
  const selectedOutputPreview = useMemo(
    () =>
      selectedNode === null
        ? null
        : nodeRunOutput(activeRun?.nodeOutputs[selectedNode.id]),
    [selectedNode, activeRun],
  );
  const selectedInputPreview = useMemo(
    () =>
      selectedPredecessor === null
        ? null
        : nodeRunOutput(activeRun?.nodeOutputs[selectedPredecessor.id]),
    [selectedPredecessor, activeRun],
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

  // Generic per-node config patch used by the inspector's advanced-kind forms
  // (switch cases, loop, retry, data assignments, condition predicate). Merges
  // the patch into the node's `data`; `flowNodeToNode` persists those fields.
  const handleNodeDataChange = useCallback(
    (nodeId: string, patch: Partial<WorkflowNodeData>): void => {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n,
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

  // Dynamic header title: a fresh draft reads "New workflow"; editing an
  // existing one reads the generic "Editing workflow" (the name is shown in
  // the Properties dialog, not duplicated in the header).
  const headerTitle = isEditingExisting
    ? t("editor.editingTitle")
    : t("editor.newWorkflow");

  return (
    <>
      <header className="view-header wf-header">
        <div>
          <h1 className="view-title">{headerTitle}</h1>
          <p className="view-subtitle">{t("editor.subtitle")}</p>
        </div>
        <div className="wf-header__actions">
          <button
            type="button"
            className="btn command-form__action command-form__action--cancel"
            onClick={() => setView("library")}
          >
            <span className="command-form__action-icon--cancel">
              <CancelIcon />
            </span>
            {t("common.close")}
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
      </header>

      <div className={`wf-editor${fullscreen ? " wf-editor--fullscreen" : ""}`}>
      <aside className="wf-palette">
        <div className="wf-palette__section">
          <h3 className="wf-palette__title">{t("editor.palette.nodes")}</h3>
          <button
            type="button"
            className="btn btn--ghost wf-palette__btn"
            draggable
            onDragStart={(e) => onPaletteNodeDragStart(e, "condition")}
            onClick={() =>
              addNode("condition", undefined, { x: 240, y: 200 })
            }
            title={t("editor.palette.nodeDragHint")}
          >
            + {t("editor.nodes.condition")}
          </button>
          <button
            type="button"
            className="btn btn--ghost wf-palette__btn"
            draggable
            onDragStart={(e) => onPaletteNodeDragStart(e, "switch")}
            onClick={() => addNode("switch", undefined, { x: 240, y: 200 })}
            title={t("editor.palette.nodeDragHint")}
          >
            + {t("editor.nodes.switch")}
          </button>
          <button
            type="button"
            className="btn btn--ghost wf-palette__btn"
            draggable
            onDragStart={(e) => onPaletteNodeDragStart(e, "loop")}
            onClick={() => addNode("loop", undefined, { x: 240, y: 200 })}
            title={t("editor.palette.nodeDragHint")}
          >
            + {t("editor.nodes.loop")}
          </button>
          <button
            type="button"
            className="btn btn--ghost wf-palette__btn"
            draggable
            onDragStart={(e) => onPaletteNodeDragStart(e, "try")}
            onClick={() => addNode("try", undefined, { x: 240, y: 200 })}
            title={t("editor.palette.nodeDragHint")}
          >
            + {t("editor.nodes.try")}
          </button>
          <button
            type="button"
            className="btn btn--ghost wf-palette__btn"
            draggable
            onDragStart={(e) => onPaletteNodeDragStart(e, "data")}
            onClick={() => appendNodeToTail("data", undefined)}
            title={t("editor.palette.nodeDragHint")}
          >
            + {t("editor.nodes.data")}
          </button>
          <button
            type="button"
            className="btn btn--ghost wf-palette__btn"
            draggable
            onDragStart={(e) => onPaletteNodeDragStart(e, "parser")}
            onClick={() => appendNodeToTail("parser", undefined)}
            title={t("editor.palette.nodeDragHint")}
          >
            + {t("editor.nodes.parser")}
          </button>
          <button
            type="button"
            className="btn btn--ghost wf-palette__btn"
            draggable
            onDragStart={(e) => onPaletteNodeDragStart(e, "text")}
            onClick={() => appendNodeToTail("text", undefined)}
            title={t("editor.palette.nodeDragHint")}
          >
            + {t("editor.nodes.text")}
          </button>
          <button
            type="button"
            className="btn btn--ghost wf-palette__btn"
            draggable
            onDragStart={(e) => onPaletteNodeDragStart(e, "end")}
            onClick={() => appendNodeToTail("end", undefined)}
            title={t("editor.palette.nodeDragHint")}
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
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setMetaModalOpen(true)}
          >
            {t("editor.details")}
          </button>
          <div className="wf-toolbar__spacer" />
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
        </div>
        <ReactFlow
          nodes={displayNodes}
          edges={displayEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
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
          nodesDraggable={interactive}
          nodesConnectable={interactive}
          elementsSelectable={interactive}
          fitView
          fitViewOptions={{ maxZoom: 0.8 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <WorkflowControls
            interactive={interactive}
            onToggleInteractive={() => setInteractive((v) => !v)}
            fullscreen={fullscreen}
            onToggleFullscreen={() => setFullscreen((v) => !v)}
          />
        </ReactFlow>
        {insertHintPos !== null ? (
          <div
            className="wf-insert-hint"
            style={{
              left: insertHintPos.x,
              top: insertHintPos.y,
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
          predecessor={selectedPredecessor}
          allNodes={nodes}
          edges={edges}
          commands={commands}
          outputPreview={selectedOutputPreview}
          inputPreview={selectedInputPreview}
          manualInput={manualPreviews[selectedNode.id]?.in ?? ""}
          manualOutput={manualPreviews[selectedNode.id]?.out ?? ""}
          onManualInputChange={(nodeId, value) =>
            setManualPreviewSide(nodeId, "in", value)
          }
          onManualOutputChange={(nodeId, value) =>
            setManualPreviewSide(nodeId, "out", value)
          }
          onCommandChange={handleNodeCommandChange}
          onNodeDataChange={handleNodeDataChange}
          onDelete={handleDeleteNode}
          onRunNode={(nodeId, seedInput) => {
            void runNode(nodeId, seedInput);
          }}
          isRunning={isRunning}
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
    </>
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
