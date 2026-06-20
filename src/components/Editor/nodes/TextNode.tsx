import type { ReactElement } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import type { WorkflowNodeData } from "../../../utils/workflowGraph";
import { insertNeighborClass, runStatusClass } from "./runStatus";

/**
 * A non-command node that composes a template string (expanding `${var}`
 * references to earlier variables) and makes the result its output. Target
 * handle on the left, single `out` source handle on the right. The title shows
 * a short preview of the template, or an empty-state hint.
 */
export function TextNode({ data }: NodeProps<Node<WorkflowNodeData>>): ReactElement {
  const { t } = useTranslation();
  const text = (data.text ?? "").trim();
  // One-line preview, truncated, so a multi-line template stays compact.
  const firstLine = text.split("\n")[0] ?? "";
  const preview =
    firstLine.length > 28 ? `${firstLine.slice(0, 28)}…` : firstLine;

  return (
    <div
      className={`wf-node wf-node--text${runStatusClass(
        data.runStatus,
      )}${insertNeighborClass(data.insertNeighbor)}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="wf-node__kind">{t("editor.nodes.text")}</div>
      <div className="wf-node__title">
        {preview === "" ? t("editor.nodes.textEmpty") : preview}
      </div>
      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}
