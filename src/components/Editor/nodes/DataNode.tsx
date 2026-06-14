import type { ReactElement } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { useTranslation } from "react-i18next";
import type { WorkflowNodeData } from "../../../utils/workflowGraph";
import { insertNeighborClass, runStatusClass } from "./runStatus";

/**
 * A non-command node that derives data-flow variables without spawning a
 * process. Target handle on the left, single `out` source handle on the
 * right. The title summarises how many assignments it performs.
 */
export function DataNode({ data }: NodeProps<WorkflowNodeData>): ReactElement {
  const { t } = useTranslation();

  return (
    <div
      className={`wf-node wf-node--data${runStatusClass(
        data.runStatus,
      )}${insertNeighborClass(data.insertNeighbor)}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="wf-node__kind">{t("editor.nodes.data")}</div>
      <div className="wf-node__title">
        {t("editor.nodes.dataSummary", { count: data.data?.length ?? 0 })}
      </div>
      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}
