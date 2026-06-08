import type { ReactElement } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { useTranslation } from "react-i18next";
import { useCommandStore } from "../../../stores/commandStore";
import { getCommandName } from "../../../utils/commandLabels";
import type { WorkflowNodeData } from "../../../utils/workflowGraph";
import { insertNeighborClass, runStatusClass } from "./runStatus";

/**
 * A node that runs its referenced `Command` and branches on the exit code:
 * exit 0 follows the `then` handle, any non-zero follows `else`. Two source
 * handles, stacked vertically, whose ids ARE the branch names — so the graph
 * converter reads `sourceHandle` directly as the `WorkflowEdge.branch`.
 */
export function ConditionNode({
  data,
}: NodeProps<WorkflowNodeData>): ReactElement {
  const { t } = useTranslation();
  const command = useCommandStore((s) =>
    data.commandId === undefined
      ? undefined
      : s.commands.find((c) => c.id === data.commandId),
  );

  const label =
    command !== undefined
      ? getCommandName(command, t)
      : t("editor.nodes.unboundCommand");

  return (
    <div
      className={`wf-node wf-node--condition${runStatusClass(data.runStatus)}${
        command === undefined ? " is-unbound" : ""
      }${insertNeighborClass(data.insertNeighbor)}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="wf-node__kind">{t("editor.nodes.condition")}</div>
      <div className="wf-node__title">{label}</div>
      <div className="wf-node__branches">
        <span className="wf-branch-label wf-branch-label--then">
          {t("editor.nodes.then")}
        </span>
        <span className="wf-branch-label wf-branch-label--else">
          {t("editor.nodes.else")}
        </span>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        id="then"
        style={{ top: "60%" }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="else"
        style={{ top: "85%" }}
      />
    </div>
  );
}
