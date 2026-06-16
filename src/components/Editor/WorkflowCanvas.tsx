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
import {
  deleteCommand as deleteCommandWithHistory,
  promoteCommandToGlobal,
} from "../../services/commandActions";
import { triggerCommandRun } from "../../services/commandRunner";
import { useUIStore } from "../../stores/uiStore";
import { useWorkflowStore } from "../../stores/workflowStore";
import { useWorkflowRunStore } from "../../stores/workflowRunStore";
import {
  buildDraftForTarget,
  fingerprintDraft,
  isDraftDirty,
  useEditorDraftStore,
  type EditorSnapshot,
} from "../../stores/editorDraftStore";
import type { Command, WorkflowNodeKind } from "../../types";
import { getCommandName } from "../../utils/commandLabels";
import {
  commandsForWorkflowScope,
  localCommandsForWorkflow,
} from "../../utils/commandFilters";
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
import { CommandView } from "../CommandView";
import {
  CancelIcon,
  FitViewIcon,
  FullscreenIcon,
  RedoIcon,
  RunIcon,
  SaveIcon,
  UndoIcon,
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
  const allCommands = useCommandStore((s) => s.commands);
  const workflows = useWorkflowStore((s) => s.workflows);
  const setEditorWorkflowId = useUIStore((s) => s.setEditorWorkflowId);
  const setView = useUIStore((s) => s.setView);
  const setCommandEditorTarget = useUIStore((s) => s.setCommandEditorTarget);
  const setCommandEditorDirty = useUIStore((s) => s.setCommandEditorDirty);

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
  // Undo/redo history + dirty tracking (action-grained; see `pushHistory`).
  const pushHistory = useEditorDraftStore((s) => s.pushHistory);
  const captureSnapshot = useEditorDraftStore((s) => s.captureSnapshot);
  const commitHistory = useEditorDraftStore((s) => s.commitHistory);
  const undo = useEditorDraftStore((s) => s.undo);
  const redo = useEditorDraftStore((s) => s.redo);
  const canUndo = useEditorDraftStore((s) => s.past.length > 0);
  const canRedo = useEditorDraftStore((s) => s.future.length > 0);
  const baseline = useEditorDraftStore((s) => s.baseline);
  const lastSavedAt = useEditorDraftStore((s) => s.lastSavedAt);
  const isDirty = useMemo(
    () => isDraftDirty({ nodes, edges, meta, baseline }),
    [nodes, edges, meta, baseline],
  );

  // \"Last saved: <datetime>\" header indicator. Always rendered: when there is
  // no save data (new workflow, or a legacy/unmigrated value that parses as an
  // invalid date) it shows an em-dash placeholder instead of hiding.
  const savedAtLabel = useMemo((): string => {
    const placeholder = "—";
    if (lastSavedAt === null) {
      return t("editor.lastSavedAt", { datetime: placeholder });
    }
    const d = new Date(lastSavedAt);
    const datetime = Number.isNaN(d.getTime()) ? placeholder : d.toLocaleString();
    return t("editor.lastSavedAt", { datetime });
  }, [lastSavedAt, t]);

  // Commands available to THIS workflow's nodes: every global command plus
  // this workflow's own `local` commands. Other workflows' locals are hidden.
  // Scoped once here and threaded into the palette and the node inspector so
  // both pickers stay consistent. A brand-new (unsaved) workflow has
  // `currentId === null` → only globals (a local can't be owned yet).
  const commands = useMemo(
    () => commandsForWorkflowScope(allCommands, currentId),
    [allCommands, currentId],
  );

  // The palette's "Local commands" section lists ONLY this workflow's own
  // `local` commands (globals are added to the canvas via the empty "Command"
  // node + its picker instead). Empty for an unsaved workflow.
  const localCommands = useMemo(
    () => localCommandsForWorkflow(allCommands, currentId),
    [allCommands, currentId],
  );

  const [metaModalOpen, setMetaModalOpen] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  // Unsaved-changes guard shown when Close is clicked with a dirty draft.
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  // The local command shown in the read-only CommandView modal (opened by
  // clicking an item in the palette's "Local commands" list), or `null`.
  const [viewCommand, setViewCommand] = useState<Command | null>(null);
  // A command staged for promotion to global: the promote confirm dialog is
  // open while this is non-null (set from the CommandView "Make global" button
  // or the node inspector promote action). `null` when no confirm is pending.
  const [promotePendingId, setPromotePendingId] = useState<string | null>(null);
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

  // Node-modal edit session for undo grouping: the draft snapshot taken when a
  // node modal opens, and its fingerprint, so the many incremental config
  // edits inside the modal collapse into ONE undo step committed on close.
  // `skipNextModalCommit` suppresses that commit when the modal closes because
  // the node was DELETED (delete records its own discrete history entry).
  const modalOpenSnapshotRef = useRef<EditorSnapshot | null>(null);
  const modalOpenFingerprintRef = useRef<string | null>(null);
  const skipNextModalCommitRef = useRef(false);

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
      // Splicing a node into an edge is one discrete, undoable action.
      pushHistory();
      setNodes(next.nodes);
      setEdges(next.edges);
    },
    [nodeDragEdgeId, clearNodeDragHint, setNodes, setEdges, pushHistory],
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
      // Connecting two ports is one discrete, undoable action.
      pushHistory();
      setEdges((eds) => addEdge(edge, eds));
    },
    [setEdges, pushHistory],
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
      // Removing a connection is one discrete, undoable action.
      pushHistory();
      setEdges((eds) => eds.filter((e) => e.id !== edge.id));
    },
    [setEdges, pushHistory],
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

  // Create a workflow-LOCAL command from within the editor: open the
  // full-screen command form pre-scoped to this workflow. Gated on the
  // workflow having been saved (`currentId !== null`) so the new command has
  // an owner to attach to. After creation the command appears only in THIS
  // workflow's palette/picker (it is hidden from the global library).
  const onCreateLocalCommand = useCallback((): void => {
    if (currentId === null) return;
    setCommandEditorDirty(false);
    setCommandEditorTarget({
      mode: "create",
      commandId: null,
      initialScope: "local",
      initialWorkflowId: currentId,
    });
    setView("command-editor");
  }, [currentId, setCommandEditorDirty, setCommandEditorTarget, setView]);

  // Request promotion of a local command to global ("make global"): opens the
  // confirm dialog. The actual promote happens on confirm. Used by the
  // CommandView "Make global" button (opened from the Local commands list).
  const onPromoteCommand = useCallback((commandId: string): void => {
    setPromotePendingId(commandId);
  }, []);

  // Confirm/cancel the promote. On confirm the command leaves this workflow's
  // private scope and joins the shared library (renamed on name conflict — see
  // `promoteCommandToGlobal`); it then disappears from the "Local commands"
  // list and the open CommandView (no longer local) is closed.
  const confirmPromote = useCallback((): void => {
    if (promotePendingId !== null) {
      promoteCommandToGlobal(promotePendingId);
    }
    setPromotePendingId(null);
    setViewCommand(null);
  }, [promotePendingId]);
  const cancelPromote = useCallback((): void => {
    setPromotePendingId(null);
  }, []);

  // Open a local command in the read-only CommandView modal (clicking an item
  // in the "Local commands" list). These items do not add a node — that is
  // done via the empty "Command" node + its picker.
  const onViewLocalCommand = useCallback((command: Command): void => {
    setViewCommand(command);
  }, []);

  // Edit a local command from its CommandView: open the full-screen command
  // editor, returning to THIS workflow editor on close (so the user lands back
  // on the workflow). Mirrors the Library edit flow plus the `returnTo` hint.
  const onEditViewedCommand = useCallback(
    (command: Command): void => {
      setViewCommand(null);
      setCommandEditorDirty(false);
      setCommandEditorTarget({
        mode: "edit",
        commandId: command.id,
        returnTo: "editor",
      });
      setView("command-editor");
    },
    [setCommandEditorDirty, setCommandEditorTarget, setView],
  );

  // Delete a local command from its CommandView (history-logged, restorable).
  const onDeleteViewedCommand = useCallback((command: Command): void => {
    setViewCommand(null);
    deleteCommandWithHistory(command.id);
  }, []);

  // Palette drag-and-drop (drag-over insert hint + drop placement). The hint
  // state (`dropTargetEdgeId`, `insertPreviewPos`) lives in the hook and is
  // read by the display memos below.
  const {
    dropTargetEdgeId,
    insertPreviewPos,
    onDragOver,
    onDragLeave,
    onDrop,
    onPaletteNodeDragStart,
  } = useWorkflowCanvasDnD({
    flowWrapperRef,
    rfInstanceRef,
    makeNode,
    setNodes,
    setEdges,
    onBeforeMutate: pushHistory,
  });

  // History-aware palette add helpers: record one undo snapshot, then place
  // the node. Used by the palette CLICK affordances (drag-drop records its own
  // snapshot via the DnD hook's `onBeforeMutate`).
  const paletteAddNode = useCallback(
    (
      kind: PaletteNodeKind,
      commandId: string | undefined,
      position: { x: number; y: number },
    ): void => {
      pushHistory();
      addNode(kind, commandId, position);
    },
    [pushHistory, addNode],
  );
  const paletteAppendNode = useCallback(
    (kind: PaletteNodeKind, commandId: string | undefined): void => {
      pushHistory();
      appendNodeToTail(kind, commandId);
    },
    [pushHistory, appendNodeToTail],
  );

  // Save / run / meta-save lifecycle + the presentational `activeRunId`
  // highlight state.
  const { save, saveAndExit, run, runNode, saveMeta, activeRunId, setActiveRunId } =
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

  // Undo/redo are guarded against firing while a node modal is open: the modal
  // groups its edits into a single history step on close, and an undo/redo
  // mid-session would desync that grouping. The toolbar buttons sit behind the
  // modal backdrop anyway, so this only matters for the keyboard shortcuts.
  const handleUndo = useCallback((): void => {
    if (selectedNodeId !== null) return;
    undo();
  }, [selectedNodeId, undo]);
  const handleRedo = useCallback((): void => {
    if (selectedNodeId !== null) return;
    redo();
  }, [selectedNodeId, redo]);

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

  // Group a node-modal edit session into ONE undo step. When the modal opens
  // (selectedNodeId transitions null → id) capture the pre-edit snapshot; when
  // it closes (id → null) commit that snapshot iff the draft actually changed,
  // unless a delete already recorded its own discrete entry. Tracks the prior
  // selection in a ref so we only act on genuine open/close transitions (not
  // node-to-node switches, which both close the old session and open a new
  // one).
  const prevSelectedRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSelectedRef.current;
    if (prev === selectedNodeId) return;

    // Closing the previous session (the modal for `prev` is going away).
    if (prev !== null) {
      if (skipNextModalCommitRef.current) {
        skipNextModalCommitRef.current = false;
      } else if (
        modalOpenSnapshotRef.current !== null &&
        modalOpenFingerprintRef.current !== null
      ) {
        const current = fingerprintDraft({ nodes, edges, meta });
        if (current !== modalOpenFingerprintRef.current) {
          commitHistory(modalOpenSnapshotRef.current);
        }
      }
      modalOpenSnapshotRef.current = null;
      modalOpenFingerprintRef.current = null;
    }

    // Opening a new session: snapshot the current draft as the pre-edit state.
    if (selectedNodeId !== null) {
      const snapshot = captureSnapshot();
      modalOpenSnapshotRef.current = snapshot;
      modalOpenFingerprintRef.current = fingerprintDraft(snapshot);
    }

    prevSelectedRef.current = selectedNodeId;
    // `nodes`/`edges`/`meta` are read only inside the close branch to compute
    // the closing fingerprint; including them would re-run this effect on every
    // edit. The transition is driven solely by `selectedNodeId`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodeId, captureSnapshot, commitHistory]);

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
      // Deleting a node is one discrete, undoable action. The modal closes as
      // a side effect — suppress the modal-session commit so we don't record
      // the same change twice.
      skipNextModalCommitRef.current = true;
      pushHistory();
      setNodes(next.nodes);
      setEdges(next.edges);
      setSelectedNodeId(null);
    },
    [setNodes, setEdges, setSelectedNodeId, pushHistory],
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

  // Leave the editor for the workflow list. A bare navigate; the dirty guard
  // (below) decides whether to confirm first.
  const leaveEditor = useCallback((): void => {
    setView("library");
  }, [setView]);

  // Close button: warn about unsaved changes before leaving. A clean draft
  // navigates immediately; a dirty one opens the discard confirmation.
  const requestClose = useCallback((): void => {
    if (isDirty) {
      setCloseConfirmOpen(true);
      return;
    }
    leaveEditor();
  }, [isDirty, leaveEditor]);

  const confirmDiscardAndClose = useCallback((): void => {
    setCloseConfirmOpen(false);
    leaveEditor();
  }, [leaveEditor]);

  // Editor-scoped keyboard shortcuts: Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z (or
  // Ctrl+Y) = redo. Suppressed while typing in an input/textarea/select or a
  // contenteditable so the shortcuts don't hijack text editing, and while a
  // node modal is open (the modal owns its own keyboard handling and the
  // history grouping). Bound on the document so the canvas need not be
  // focused.
  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      return target.isContentEditable;
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key !== "z" && event.key !== "Z" && event.key !== "y" && event.key !== "Y") {
        return;
      }
      if (isEditableTarget(event.target)) return;
      const wantRedo =
        event.key === "y" ||
        event.key === "Y" ||
        ((event.key === "z" || event.key === "Z") && event.shiftKey);
      event.preventDefault();
      if (wantRedo) {
        handleRedo();
      } else {
        handleUndo();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [handleUndo, handleRedo]);

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
          <span className="wf-header__saved-at">{savedAtLabel}</span>
          <button
            type="button"
            className="btn command-form__action command-form__action--cancel"
            onClick={requestClose}
          >
            <span className="command-form__action-icon--cancel">
              <CancelIcon />
            </span>
            {t("common.close")}
          </button>
          <button
            type="button"
            className="btn btn--ghost command-form__action"
            onClick={save}
          >
            <SaveIcon />
            {t("common.save")}
          </button>
          <button
            type="button"
            className="btn btn--primary command-form__action"
            onClick={saveAndExit}
          >
            <SaveIcon />
            {t("editor.saveAndExit")}
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
            onDragStart={(e) => onPaletteNodeDragStart(e, "command")}
            onClick={() => paletteAppendNode("command", undefined)}
            title={t("editor.palette.nodeDragHint")}
          >
            + {t("editor.nodes.command")}
          </button>
          <button
            type="button"
            className="btn btn--ghost wf-palette__btn"
            draggable
            onDragStart={(e) => onPaletteNodeDragStart(e, "condition")}
            onClick={() =>
              paletteAddNode("condition", undefined, { x: 240, y: 200 })
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
            onClick={() => paletteAddNode("switch", undefined, { x: 240, y: 200 })}
            title={t("editor.palette.nodeDragHint")}
          >
            + {t("editor.nodes.switch")}
          </button>
          <button
            type="button"
            className="btn btn--ghost wf-palette__btn"
            draggable
            onDragStart={(e) => onPaletteNodeDragStart(e, "loop")}
            onClick={() => paletteAddNode("loop", undefined, { x: 240, y: 200 })}
            title={t("editor.palette.nodeDragHint")}
          >
            + {t("editor.nodes.loop")}
          </button>
          <button
            type="button"
            className="btn btn--ghost wf-palette__btn"
            draggable
            onDragStart={(e) => onPaletteNodeDragStart(e, "try")}
            onClick={() => paletteAddNode("try", undefined, { x: 240, y: 200 })}
            title={t("editor.palette.nodeDragHint")}
          >
            + {t("editor.nodes.try")}
          </button>
          <button
            type="button"
            className="btn btn--ghost wf-palette__btn"
            draggable
            onDragStart={(e) => onPaletteNodeDragStart(e, "data")}
            onClick={() => paletteAppendNode("data", undefined)}
            title={t("editor.palette.nodeDragHint")}
          >
            + {t("editor.nodes.data")}
          </button>
          <button
            type="button"
            className="btn btn--ghost wf-palette__btn"
            draggable
            onDragStart={(e) => onPaletteNodeDragStart(e, "parser")}
            onClick={() => paletteAppendNode("parser", undefined)}
            title={t("editor.palette.nodeDragHint")}
          >
            + {t("editor.nodes.parser")}
          </button>
          <button
            type="button"
            className="btn btn--ghost wf-palette__btn"
            draggable
            onDragStart={(e) => onPaletteNodeDragStart(e, "text")}
            onClick={() => paletteAppendNode("text", undefined)}
            title={t("editor.palette.nodeDragHint")}
          >
            + {t("editor.nodes.text")}
          </button>
          <button
            type="button"
            className="btn btn--ghost wf-palette__btn"
            draggable
            onDragStart={(e) => onPaletteNodeDragStart(e, "end")}
            onClick={() => paletteAppendNode("end", undefined)}
            title={t("editor.palette.nodeDragHint")}
          >
            + {t("editor.nodes.end")}
          </button>
        </div>
        <div className="wf-palette__section">
          <h3 className="wf-palette__title">
            {t("editor.palette.localCommands")}
          </h3>
          <button
            type="button"
            className="btn btn--ghost wf-palette__btn"
            onClick={onCreateLocalCommand}
            disabled={currentId === null}
            title={
              currentId === null
                ? t("editor.palette.newLocalCommandHint")
                : t("editor.palette.newLocalCommand")
            }
          >
            + {t("editor.palette.newLocalCommand")}
          </button>
          {currentId === null ? (
            <p className="wf-palette__hint">
              {t("editor.palette.newLocalCommandHint")}
            </p>
          ) : null}
          <div className="wf-palette__list">
            {localCommands.map((cmd) => (
              <button
                key={cmd.id}
                type="button"
                className="wf-palette__item"
                onClick={() => onViewLocalCommand(cmd)}
                title={t("editor.palette.openLocalCommandHint")}
              >
                {getCommandName(cmd, t)}
              </button>
            ))}
            {currentId !== null && localCommands.length === 0 ? (
              <p className="wf-palette__hint">
                {t("editor.palette.noLocalCommands")}
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
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={handleUndo}
            disabled={!canUndo}
            aria-label={t("editor.undo")}
            title={t("editor.undo")}
          >
            <UndoIcon />
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={handleRedo}
            disabled={!canRedo}
            aria-label={t("editor.redo")}
            title={t("editor.redo")}
          >
            <RedoIcon />
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

      <ConfirmDialog
        open={closeConfirmOpen}
        title={t("editor.closeConfirmTitle")}
        message={t("editor.closeConfirm")}
        confirmLabel={t("editor.discard")}
        danger
        onConfirm={confirmDiscardAndClose}
        onCancel={() => setCloseConfirmOpen(false)}
      />

      <CommandView
        command={viewCommand}
        onClose={() => setViewCommand(null)}
        onEdit={onEditViewedCommand}
        onRun={(cmd) => void triggerCommandRun(cmd)}
        onDelete={onDeleteViewedCommand}
        onPromote={(cmd) => onPromoteCommand(cmd.id)}
      />

      <ConfirmDialog
        open={promotePendingId !== null}
        title={t("editor.promoteConfirm.title")}
        message={t("editor.promoteConfirm.message")}
        confirmLabel={t("common.yes")}
        cancelLabel={t("common.no")}
        onConfirm={confirmPromote}
        onCancel={cancelPromote}
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
