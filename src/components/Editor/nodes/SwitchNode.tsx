import type { ReactElement } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import { useCommandStore } from "../../../stores/commandStore";
import { getCommandName } from "../../../utils/commandLabels";
import type { WorkflowNodeData } from "../../../utils/workflowGraph";
import { insertNeighborClass, runStatusClass } from "./runStatus";
import { VariableSourceList } from "./VariableSourceList";

/**
 * A command-running node that branches on the first matching `case`: one
 * source handle per `data.cases` entry (id `case:<id>`) plus a trailing
 * `default` handle, stacked vertically and evenly distributed. The handle
 * ids ARE the branch names, so the graph converter reads `sourceHandle`
 * directly as the `WorkflowEdge.branch`.
 */
export function SwitchNode({ data }: NodeProps<Node<WorkflowNodeData>>): ReactElement {
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

  const cases = data.cases ?? [];
  const slots = cases.length + 1;

  return (
    <div
      className={`wf-node wf-node--switch${runStatusClass(data.runStatus)}${
        command === undefined ? " is-unbound" : ""
      }${insertNeighborClass(data.insertNeighbor)}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="wf-node__kind">{t("editor.nodes.switch")}</div>
      <div className="wf-node__title">{label}</div>
      <VariableSourceList variableSources={data.variableSources} />
      <div className="wf-node__branches">
        {cases.map((c) => (
          <span key={c.id} className="wf-branch-label">
            {c.id}
          </span>
        ))}
        <span className="wf-branch-label wf-branch-label--default">
          {t("editor.nodes.default")}
        </span>
      </div>
      {cases.map((c, index) => (
        <Handle
          key={c.id}
          type="source"
          position={Position.Right}
          id={`case:${c.id}`}
          style={{ top: `${((index + 1) / (slots + 1)) * 100}%` }}
        />
      ))}
      <Handle
        type="source"
        position={Position.Right}
        id="default"
        style={{ top: `${((cases.length + 1) / (slots + 1)) * 100}%` }}
      />
    </div>
  );
}
