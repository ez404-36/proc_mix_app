import type { ReactElement } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import type { WorkflowNodeData } from "../../../utils/workflowGraph";
import { insertNeighborClass, runStatusClass } from "./runStatus";

/**
 * A non-command node that repeats its `body` subgraph a bounded number of
 * times, then leaves via `done`. Two source handles whose ids ARE the branch
 * names (`body` / `done`), so the graph converter reads `sourceHandle`
 * directly as the `WorkflowEdge.branch`. The title summarises the loop's
 * bound, or the live iteration counter during a run.
 */
export function LoopNode({ data }: NodeProps<Node<WorkflowNodeData>>): ReactElement {
  const { t } = useTranslation();

  const title =
    data.loopIteration !== undefined
      ? t("editor.nodes.loopProgress", { n: data.loopIteration })
      : data.loop?.count !== undefined
        ? t("editor.nodes.loopCount", { count: data.loop.count })
        : data.loop?.while !== undefined
          ? t("editor.nodes.loopWhile")
          : t("editor.nodes.loop");

  return (
    <div
      className={`wf-node wf-node--loop${runStatusClass(
        data.runStatus,
      )}${insertNeighborClass(data.insertNeighbor)}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="wf-node__kind">{t("editor.nodes.loop")}</div>
      <div className="wf-node__title">{title}</div>
      <div className="wf-node__branches">
        <span className="wf-branch-label wf-branch-label--body">
          {t("editor.nodes.body")}
        </span>
        <span className="wf-branch-label wf-branch-label--done">
          {t("editor.nodes.done")}
        </span>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        id="body"
        style={{ top: "60%" }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="done"
        style={{ top: "85%" }}
      />
    </div>
  );
}
