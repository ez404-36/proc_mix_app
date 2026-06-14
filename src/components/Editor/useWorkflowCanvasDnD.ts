import { useCallback, useState } from "react";
import type { DragEvent as ReactDragEvent, RefObject } from "react";
import type { ReactFlowInstance } from "reactflow";
import type { WorkflowNodeKind } from "../../types";
import { useEditorDraftStore } from "../../stores/editorDraftStore";
import {
  connectTailToNode,
  findAttachTail,
  findEdgeNearPoint,
  insertNodeOnEdge,
  insertPreviewPoint,
  type WorkflowFlowNode,
  type WorkflowNodeData,
} from "../../utils/workflowGraph";

/** MIME type used for the palette drag payload (a command id). */
export const DRAG_MIME = "application/procmix-command";

interface InsertPreviewPos {
  x: number;
  y: number;
}

interface UseWorkflowCanvasDnDArgs {
  flowWrapperRef: RefObject<HTMLDivElement | null>;
  rfInstanceRef: RefObject<ReactFlowInstance<
    WorkflowNodeData,
    unknown
  > | null>;
  makeNode: (
    kind: Exclude<WorkflowNodeKind, "start">,
    commandId: string | undefined,
    position: { x: number; y: number },
  ) => WorkflowFlowNode;
  setNodes: EditorDraftStore["setNodes"];
  setEdges: EditorDraftStore["setEdges"];
}

// The store setters accept either a value or a reactflow-style updater fn.
// Reuse their exact signatures so callers don't drift from the store.
type EditorDraftStore = ReturnType<typeof useEditorDraftStore.getState>;

interface UseWorkflowCanvasDnD {
  /** The edge currently highlighted as the palette-drop insertion target. */
  dropTargetEdgeId: string | null;
  /** Screen-space centre of the translucent insert preview, or `null`. */
  insertPreviewPos: InsertPreviewPos | null;
  onDragOver: (event: ReactDragEvent) => void;
  onDragLeave: () => void;
  onDrop: (event: ReactDragEvent) => void;
  onPaletteDragStart: (event: ReactDragEvent, commandId: string) => void;
}

/**
 * Palette drag-and-drop for the workflow canvas: the drag-over insertion
 * hint, drop placement (splice-on-edge → attach-to-tail → unconnected) and
 * the palette drag-start payload. Extracted verbatim from `WorkflowCanvas`.
 */
export function useWorkflowCanvasDnD({
  flowWrapperRef,
  rfInstanceRef,
  makeNode,
  setNodes,
  setEdges,
}: UseWorkflowCanvasDnDArgs): UseWorkflowCanvasDnD {
  // The edge currently under a palette drag, highlighted as the insertion
  // target ("the node will be inserted here"). Null when the drag is not over
  // any edge. Cleared on drop / drag-leave.
  const [dropTargetEdgeId, setDropTargetEdgeId] = useState<string | null>(null);
  // Screen-space (canvas-wrapper-relative) centre of the translucent insert
  // preview shown while dragging a command over an edge. Null when there is no
  // insertion target. Kept separate from `dropTargetEdgeId` so the overlay can
  // be positioned without re-deriving geometry on every render.
  const [insertPreviewPos, setInsertPreviewPos] =
    useState<InsertPreviewPos | null>(null);

  // During a palette drag, highlight the edge nearest the cursor so the user
  // sees where the dropped command will be inserted. We cannot read the drag
  // payload here (HTML5 DnD only exposes `getData` on drop), but the hint
  // only needs the point, not the command id.
  const onDragOver = useCallback(
    (event: ReactDragEvent): void => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const instance = rfInstanceRef.current;
      if (instance === null) return;
      const point = instance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      const { nodes: curNodes, edges: curEdges } =
        useEditorDraftStore.getState();
      const edgeId = findEdgeNearPoint(curNodes, curEdges, point);
      setDropTargetEdgeId(edgeId);
      // Position the translucent preview at the midpoint between the two
      // neighbour nodes, converted to canvas-wrapper-relative screen coords.
      const flowPoint = insertPreviewPoint(curNodes, curEdges, edgeId);
      const wrapper = flowWrapperRef.current;
      if (flowPoint === null || wrapper === null) {
        setInsertPreviewPos(null);
        return;
      }
      const screen = instance.flowToScreenPosition(flowPoint);
      const rect = wrapper.getBoundingClientRect();
      setInsertPreviewPos({ x: screen.x - rect.left, y: screen.y - rect.top });
    },
    [rfInstanceRef, flowWrapperRef],
  );

  const clearInsertHint = useCallback((): void => {
    setDropTargetEdgeId(null);
    setInsertPreviewPos(null);
  }, []);

  const onDragLeave = useCallback((): void => {
    clearInsertHint();
  }, [clearInsertHint]);

  // Drop a palette command onto the canvas. Three placements, in priority:
  //   1. Over an existing edge → splice the new node into that path
  //      (A → new → B), preserving the edge's source branch.
  //   2. Otherwise, auto-attach to the nearest tail with a free `out` port
  //      (e.g. a lone `start`, or the end of a linear chain).
  //   3. Otherwise, drop it unconnected at the cursor.
  const onDrop = useCallback(
    (event: ReactDragEvent): void => {
      event.preventDefault();
      clearInsertHint();
      const commandId = event.dataTransfer.getData(DRAG_MIME);
      if (commandId === "") return;
      const instance = rfInstanceRef.current;
      if (instance === null) return;
      const point = instance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      const newNode = makeNode("command", commandId, point);
      const { nodes: curNodes, edges: curEdges } =
        useEditorDraftStore.getState();

      const edgeId = findEdgeNearPoint(curNodes, curEdges, point);
      if (edgeId !== null) {
        const next = insertNodeOnEdge(curNodes, curEdges, newNode, edgeId);
        setNodes(next.nodes);
        setEdges(next.edges);
        return;
      }
      const tailId = findAttachTail(curNodes, curEdges, point);
      const next = connectTailToNode(curNodes, curEdges, tailId, newNode);
      setNodes(next.nodes);
      setEdges(next.edges);
    },
    [makeNode, setNodes, setEdges, clearInsertHint, rfInstanceRef],
  );

  const onPaletteDragStart = useCallback(
    (event: ReactDragEvent, commandId: string): void => {
      event.dataTransfer.setData(DRAG_MIME, commandId);
      event.dataTransfer.effectAllowed = "move";
    },
    [],
  );

  return {
    dropTargetEdgeId,
    insertPreviewPos,
    onDragOver,
    onDragLeave,
    onDrop,
    onPaletteDragStart,
  };
}
