import type { ReactElement } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import type { DataAssignment } from "../../../types";
import type { WorkflowNodeData } from "../../../utils/workflowGraph";
import { insertNeighborClass, runStatusClass } from "./runStatus";

/**
 * The display value for a `data` assignment on the node card: the literal for a
 * `manual` source, or the localized `<source>` placeholder otherwise (the real
 * value is only known at run time). Uses the same placeholder keys as the node
 * modal's "saved variables" block.
 */
function assignmentDisplayValue(
  a: DataAssignment,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const source = a.source ?? { kind: "manual", value: a.value };
  if (source.kind === "manual") return source.value;
  const field =
    source.kind === "field"
      ? source.field
      : source.kind === "dataVar"
        ? source.name
        : undefined;
  return t(`editor.inspector.preview.dataVarSource.${source.kind}`, {
    field,
    defaultValue: source.kind,
  });
}

/**
 * A non-command node that derives data-flow variables without spawning a
 * process. Target handle on the left, single `out` source handle on the
 * right. The card lists each assignment as `$name = <source>`.
 */
export function DataNode({ data }: NodeProps<Node<WorkflowNodeData>>): ReactElement {
  const { t } = useTranslation();
  const rows = (data.data ?? []).filter((a) => a.name.trim() !== "");

  return (
    <div
      className={`wf-node wf-node--data${runStatusClass(
        data.runStatus,
      )}${insertNeighborClass(data.insertNeighbor)}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="wf-node__kind">{t("editor.nodes.data")}</div>
      {rows.length === 0 ? (
        <div className="wf-node__title">{t("editor.nodes.dataEmpty")}</div>
      ) : (
        <dl className="wf-node__assignments">
          {rows.map((a, i) => (
            <div key={i} className="wf-node__assignment">
              <span className="wf-node__assignment-key">${a.name}</span>
              <span className="wf-node__assignment-eq">=</span>
              <span className="wf-node__assignment-val">
                {assignmentDisplayValue(a, t)}
              </span>
            </div>
          ))}
        </dl>
      )}
      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}
