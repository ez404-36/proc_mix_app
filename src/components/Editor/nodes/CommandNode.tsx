import type { ReactElement } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import { useCommandStore } from "../../../stores/commandStore";
import { getCommandName } from "../../../utils/commandLabels";
import type { WorkflowNodeData } from "../../../utils/workflowGraph";
import { insertNeighborClass, runStatusClass } from "./runStatus";
import { VariableSourceList } from "./VariableSourceList";

/**
 * A node that runs a referenced `Command`. Target handle on the left, single
 * `out` source handle on the right. Shows the referenced command's localized
 * name, or a clear "pick a command" placeholder when unbound (which the
 * validator flags as an error before Run).
 */
export function CommandNode({
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

  return (
    <div
      className={`wf-node wf-node--command${runStatusClass(data.runStatus)}${
        command === undefined ? " is-unbound" : ""
      }${insertNeighborClass(data.insertNeighbor)}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="wf-node__kind">{t("editor.nodes.command")}</div>
      <div className="wf-node__title">{label}</div>
      <VariableSourceList variableSources={data.variableSources} />
      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}
