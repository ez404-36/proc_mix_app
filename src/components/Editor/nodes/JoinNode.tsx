import type { ReactElement } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import type { WorkflowNodeData } from "../../../utils/workflowGraph";
import { insertNeighborClass, runStatusClass } from "./runStatus";

/**
 * The synchronisation barrier paired with a `parallel` (fork) node. Unlike an
 * `end` node it is NOT terminal: it accepts the incoming edges of every fork
 * branch on its single `target` handle and continues the chain via one `out`
 * source handle once all branches have arrived.
 */
export function JoinNode({ data }: NodeProps<Node<WorkflowNodeData>>): ReactElement {
  const { t } = useTranslation();
  return (
    <div
      className={`wf-node wf-node--join${runStatusClass(
        data.runStatus,
      )}${insertNeighborClass(data.insertNeighbor)}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="wf-node__title">{t("editor.nodes.join")}</div>
      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}
