import type { ReactElement } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import type { WorkflowNodeData } from "../../../utils/workflowGraph";
import { insertNeighborClass, runStatusClass } from "./runStatus";

/**
 * A non-command node that re-parses the previous node's raw output through its
 * own output-schema pipeline (same engine as a command's output schema).
 * Target handle on the left, single `out` source handle on the right. The
 * title summarises how many pipeline steps the parser runs.
 */
export function ParserNode({
  data,
}: NodeProps<Node<WorkflowNodeData>>): ReactElement {
  const { t } = useTranslation();
  const steps = data.parser?.pipeline?.length ?? 0;

  return (
    <div
      className={`wf-node wf-node--parser${runStatusClass(
        data.runStatus,
      )}${insertNeighborClass(data.insertNeighbor)}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="wf-node__kind">{t("editor.nodes.parser")}</div>
      <div className="wf-node__title">
        {t("editor.nodes.parserSummary", { count: steps })}
      </div>
      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}
