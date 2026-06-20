import type { ReactElement } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import { useCommandStore } from "../../../stores/commandStore";
import { conditionSummary } from "../../../utils/conditionSummary";
import { getCommandName } from "../../../utils/commandLabels";
import type { WorkflowNodeData } from "../../../utils/workflowGraph";
import { insertNeighborClass, runStatusClass } from "./runStatus";

/**
 * A node that runs its referenced `Command` and branches. Without a predicate
 * it branches on the exit code (`then` = success / `else` = failure). WITH a
 * predicate (`data.condition`) the branch labels become да/нет (the predicate
 * either held or not), each prefixed with a short summary of the predicate
 * (e.g. `> 80`). Two source handles, stacked vertically, whose ids ARE the
 * branch names — so the graph converter reads `sourceHandle` directly as the
 * `WorkflowEdge.branch`.
 */
export function ConditionNode({
  data,
}: NodeProps<Node<WorkflowNodeData>>): ReactElement {
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

  // With a predicate, the branches read да/нет and carry the predicate summary;
  // without one, they keep the exit-code success/error wording.
  const predicate = data.condition;
  const summary =
    predicate !== undefined ? conditionSummary(predicate, t) : null;
  const thenText = summary !== null ? t("editor.nodes.yes") : t("editor.nodes.then");
  const elseText = summary !== null ? t("editor.nodes.no") : t("editor.nodes.else");

  return (
    <div
      className={`wf-node wf-node--condition${runStatusClass(data.runStatus)}${
        command === undefined ? " is-unbound" : ""
      }${insertNeighborClass(data.insertNeighbor)}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="wf-node__kind">{t("editor.nodes.condition")}</div>
      <div className="wf-node__title">{label}</div>
      <div className="wf-node__branches-row">
        {summary !== null ? (
          <span className="wf-node__predicate" title={summary}>
            {summary}
          </span>
        ) : null}
        <div className="wf-node__branches">
          <span className="wf-branch-label wf-branch-label--then">
            {thenText}
          </span>
          <span className="wf-branch-label wf-branch-label--else">
            {elseText}
          </span>
        </div>
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
