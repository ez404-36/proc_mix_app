import type { ReactElement } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import type { WorkflowNodeData } from "../../../utils/workflowGraph";
import { insertNeighborClass, runStatusClass } from "./runStatus";

/**
 * Entry node of the graph. Has a single `out` source handle and no target
 * handle — nothing connects INTO start.
 */
export function StartNode({ data }: NodeProps<Node<WorkflowNodeData>>): ReactElement {
  const { t } = useTranslation();
  return (
    <div
      className={`wf-node wf-node--start${runStatusClass(
        data.runStatus,
      )}${insertNeighborClass(data.insertNeighbor)}`}
    >
      <div className="wf-node__title">{t("editor.nodes.start")}</div>
      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}
