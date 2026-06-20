import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { DataSource } from "../../../types";

/**
 * The display value for a command variable's source on the node card: the
 * literal for a `manual` source, or the localized `<source>` placeholder
 * otherwise (the real value is only known at run time). Reuses the same
 * placeholder keys as the `data` node and the node modal's variable block.
 */
function sourceDisplayValue(
  source: DataSource,
  t: ReturnType<typeof useTranslation>["t"],
): string {
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

interface VariableSourceListProps {
  /** Per-variable value sources keyed by the command's variable name. */
  variableSources: Record<string, DataSource> | undefined;
}

/**
 * Lists a command-bearing node's explicitly-bound command variables as
 * `$name = <source>` rows, mirroring the `data` node's assignment list.
 * Variables left at their implicit "prompt at run time" default (absent from
 * `variableSources`) are NOT shown, so the card stays compact. Renders nothing
 * when no variable has a bound source.
 */
export function VariableSourceList({
  variableSources,
}: VariableSourceListProps): ReactElement | null {
  const { t } = useTranslation();
  const rows = Object.entries(variableSources ?? {}).filter(
    ([name]) => name.trim() !== "",
  );
  if (rows.length === 0) return null;

  return (
    <dl className="wf-node__assignments">
      {rows.map(([name, source]) => (
        <div key={name} className="wf-node__assignment">
          <span className="wf-node__assignment-key">${name}</span>
          <span className="wf-node__assignment-eq">=</span>
          <span className="wf-node__assignment-val">
            {sourceDisplayValue(source, t)}
          </span>
        </div>
      ))}
    </dl>
  );
}
