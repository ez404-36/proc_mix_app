import { useCallback, useState } from "react";
import type { DragEvent as ReactDragEvent, RefObject } from "react";
import type { ReactFlowInstance } from "@xyflow/react";
import type { WorkflowNodeKind } from "../../types";
import { useEditorDraftStore } from "../../stores/editorDraftStore";
import {
  connectTailToNode,
  findAttachTail,
  findEdgeNearPoint,
  findNearestFreeHandle,
  insertNodeOnEdge,
  insertPreviewPoint,
  type MeasuredSourceHandle,
  type WorkflowFlowNode,
} from "../../utils/workflowGraph";

/** MIME type used for the palette drag payload. */
export const DRAG_MIME = "application/procmix-node";

/**
 * What a palette drag carries: the node `kind` to create, plus a `commandId`
 * for command-bearing kinds dragged from the command list. Serialised as JSON
 * in the drag `dataTransfer` (HTML5 DnD only exposes the payload on `drop`).
 */
interface PaletteDragPayload {
  kind: Exclude<WorkflowNodeKind, "start">;
  commandId?: string;
}

function parsePayload(raw: string): PaletteDragPayload | null {
  if (raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "kind" in parsed &&
      typeof (parsed as { kind: unknown }).kind === "string"
    ) {
      const { kind, commandId } = parsed as {
        kind: string;
        commandId?: unknown;
      };
      return {
        kind: kind as Exclude<WorkflowNodeKind, "start">,
        commandId: typeof commandId === "string" ? commandId : undefined,
      };
    }
  } catch {
    // Malformed payload (e.g. a foreign drag) — ignore.
  }
  return null;
}

/**
 * Read every SOURCE handle currently rendered on the canvas with its TRUE
 * on-screen center converted to flow coordinates. @xyflow/react renders each
 * handle as `.react-flow__handle.source[data-nodeid][data-handleid]`, so the
 * real position is read straight from the DOM — immune to a node's dynamic
 * height (variable rows, branch labels, …) that breaks a fixed-height estimate.
 * `screenToFlow` is the instance's `screenToFlowPosition`, applied to each
 * handle's bounding-box center.
 */
function readMeasuredSourceHandles(
  wrapper: HTMLElement,
  screenToFlow: (p: { x: number; y: number }) => { x: number; y: number },
): MeasuredSourceHandle[] {
  const result: MeasuredSourceHandle[] = [];
  const els = wrapper.querySelectorAll<HTMLElement>(
    ".react-flow__handle.source[data-nodeid][data-handleid]",
  );
  els.forEach((el) => {
    const nodeId = el.getAttribute("data-nodeid");
    const sourceHandle = el.getAttribute("data-handleid");
    if (nodeId === null || sourceHandle === null) return;
    const rect = el.getBoundingClientRect();
    const anchor = screenToFlow({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
    result.push({ nodeId, sourceHandle, anchor });
  });
  return result;
}

interface InsertPreviewPos {
  x: number;
  y: number;
}

interface UseWorkflowCanvasDnDArgs {
  flowWrapperRef: RefObject<HTMLDivElement | null>;
  rfInstanceRef: RefObject<ReactFlowInstance<WorkflowFlowNode> | null>;
  makeNode: (
    kind: Exclude<WorkflowNodeKind, "start">,
    commandId: string | undefined,
    position: { x: number; y: number },
  ) => WorkflowFlowNode;
  setNodes: EditorDraftStore["setNodes"];
  setEdges: EditorDraftStore["setEdges"];
  /**
   * Invoked once, right before a successful drop mutates the graph, so the
   * host can record an undo snapshot. Not called when a drop is a no-op
   * (foreign payload / no reactflow instance).
   */
  onBeforeMutate: () => void;
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
  /** Drag-start for a command palette item (creates a `command` node). */
  onPaletteDragStart: (event: ReactDragEvent, commandId: string) => void;
  /** Drag-start for a node-kind palette button (condition / switch / …). */
  onPaletteNodeDragStart: (
    event: ReactDragEvent,
    kind: Exclude<WorkflowNodeKind, "start">,
  ) => void;
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
  onBeforeMutate,
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
      const payload = parsePayload(event.dataTransfer.getData(DRAG_MIME));
      if (payload === null) return;
      const instance = rfInstanceRef.current;
      if (instance === null) return;
      const point = instance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      const newNode = makeNode(payload.kind, payload.commandId, point);
      const { nodes: curNodes, edges: curEdges } =
        useEditorDraftStore.getState();

      const edgeId = findEdgeNearPoint(curNodes, curEdges, point);
      if (edgeId !== null) {
        const next = insertNodeOnEdge(curNodes, curEdges, newNode, edgeId);
        // Placement mutates the graph — record one undo snapshot first.
        onBeforeMutate();
        setNodes(next.nodes);
        setEdges(next.edges);
        return;
      }
      // Auto-attach to the nearest FREE source handle. Prefer real measured
      // handle positions from the DOM (exact regardless of a node's dynamic
      // height); fall back to the estimated geometry when the wrapper / DOM
      // handles are unavailable (e.g. in tests without a live canvas).
      const wrapper = flowWrapperRef.current;
      const measured =
        wrapper === null
          ? []
          : readMeasuredSourceHandles(wrapper, (p) =>
              instance.screenToFlowPosition(p),
            );
      const tail =
        measured.length > 0
          ? findNearestFreeHandle(measured, curEdges, point)
          : findAttachTail(curNodes, curEdges, point);
      const next = connectTailToNode(
        curNodes,
        curEdges,
        tail?.id ?? null,
        newNode,
        tail?.sourceHandle ?? "out",
      );
      onBeforeMutate();
      setNodes(next.nodes);
      setEdges(next.edges);
    },
    [
      makeNode,
      setNodes,
      setEdges,
      clearInsertHint,
      rfInstanceRef,
      flowWrapperRef,
      onBeforeMutate,
    ],
  );

  const onPaletteDragStart = useCallback(
    (event: ReactDragEvent, commandId: string): void => {
      const payload: PaletteDragPayload = { kind: "command", commandId };
      event.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
      event.dataTransfer.effectAllowed = "move";
    },
    [],
  );

  const onPaletteNodeDragStart = useCallback(
    (event: ReactDragEvent, kind: Exclude<WorkflowNodeKind, "start">): void => {
      const payload: PaletteDragPayload = { kind };
      event.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
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
    onPaletteNodeDragStart,
  };
}
