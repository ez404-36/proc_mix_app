import { useMemo } from "react";
import type { ReactElement } from "react";
import ReactFlow, {
  Background,
  Controls,
  ReactFlowProvider,
} from "reactflow";
import "reactflow/dist/style.css";
import { workflowToFlow } from "../../utils/workflowGraph";
import { workflowNodeTypes } from "../Editor/nodes";
import type { Workflow } from "../../types";

interface WorkflowPreviewCanvasProps {
  workflow: Workflow;
}

/**
 * Read-only reactflow canvas that renders a workflow exactly like the editor
 * (same `workflowToFlow` converter + the shared `workflowNodeTypes` custom
 * nodes) but with every graph mutation disabled:
 *   - nodes cannot be dragged, connected, or deleted
 *   - no palette, no toolbar, no change handlers
 * Pan + zoom stay enabled so large graphs can still be explored.
 *
 * It derives entirely from the `workflow` prop and NEVER touches
 * `useEditorDraftStore`, so previewing a workflow leaves any in-progress
 * editing draft untouched. Idle nodes only — no run/insert state is injected.
 */
function PreviewCanvas({ workflow }: WorkflowPreviewCanvasProps): ReactElement {
  const { nodes, edges } = useMemo(() => workflowToFlow(workflow), [workflow]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={workflowNodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      nodesFocusable={false}
      elementsSelectable={false}
      edgesFocusable={false}
      deleteKeyCode={null}
      fitView
      fitViewOptions={{ maxZoom: 0.8 }}
      proOptions={{ hideAttribution: true }}
    >
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

export function WorkflowPreviewCanvas(
  props: WorkflowPreviewCanvasProps,
): ReactElement {
  return (
    <ReactFlowProvider>
      <PreviewCanvas {...props} />
    </ReactFlowProvider>
  );
}
