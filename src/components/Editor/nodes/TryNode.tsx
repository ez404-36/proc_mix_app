import type { ReactElement } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import { useCommandStore } from "../../../stores/commandStore";
import { getCommandName } from "../../../utils/commandLabels";
import type { WorkflowNodeData } from "../../../utils/workflowGraph";
import { insertNeighborClass, runStatusClass } from "./runStatus";
import { VariableSourceList } from "./VariableSourceList";

/**
 * A command-running node that retries its command on failure: `ok` once it
 * succeeds, `catch` once retries are exhausted. Two source handles whose ids
 * ARE the branch names (`ok` / `catch`), so the graph converter reads
 * `sourceHandle` directly as the `WorkflowEdge.branch`. The title shows the
 * command name, plus the live retry attempt during a run.
 */
export function TryNode({ data }: NodeProps<Node<WorkflowNodeData>>): ReactElement {
  const { t } = useTranslation();
  const command = useCommandStore((s) =>
    data.commandId === undefined
      ? undefined
      : s.commands.find((c) => c.id === data.commandId),
  );

  const name =
    command !== undefined
      ? getCommandName(command, t)
      : t("editor.nodes.unboundCommand");

  const title =
    data.retryAttempt !== undefined
      ? `${name} ${t("editor.nodes.retryProgress", { n: data.retryAttempt })}`
      : name;

  return (
    <div
      className={`wf-node wf-node--try${runStatusClass(data.runStatus)}${
        command === undefined ? " is-unbound" : ""
      }${insertNeighborClass(data.insertNeighbor)}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="wf-node__kind">{t("editor.nodes.try")}</div>
      <div className="wf-node__title">{title}</div>
      <VariableSourceList variableSources={data.variableSources} />
      <div className="wf-node__branches">
        <span className="wf-branch-label wf-branch-label--ok">
          {t("editor.nodes.ok")}
        </span>
        <span className="wf-branch-label wf-branch-label--catch">
          {t("editor.nodes.catch")}
        </span>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        id="ok"
        style={{ top: "60%" }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="catch"
        style={{ top: "85%" }}
      />
    </div>
  );
}
