import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { Command } from "../../types";
import { getCommandName } from "../../utils/commandLabels";
import type { WorkflowFlowNode } from "../../utils/workflowGraph";
import { Dropdown } from "../Dropdown";
import type { DropdownOption } from "../Dropdown";
import { CheckIcon, TrashIcon } from "../icons";

interface NodeInspectorProps {
  node: WorkflowFlowNode;
  commands: ReadonlyArray<Command>;
  onCommandChange: (nodeId: string, commandId: string | undefined) => void;
  onDelete: (nodeId: string) => void;
  onClose: () => void;
}

/**
 * Right-hand panel for configuring the selected node. `command` and
 * `condition` nodes expose a command picker; `start` is non-deletable
 * (every workflow keeps exactly one start); `end` shows nothing to
 * configure beyond delete.
 */
export function NodeInspector({
  node,
  commands,
  onCommandChange,
  onDelete,
  onClose,
}: NodeInspectorProps): ReactElement {
  const { t } = useTranslation();
  const kind = node.data.kind;
  const needsCommand = kind === "command" || kind === "condition";
  const isStart = kind === "start";

  // Sentinel value for "no command picked" — Dropdown works on plain strings,
  // so the empty string maps to `undefined` on the way out.
  const NONE = "";
  const options: ReadonlyArray<DropdownOption> = [
    { value: NONE, label: t("editor.inspector.pickCommand") },
    ...commands.map((cmd) => ({ value: cmd.id, label: getCommandName(cmd, t) })),
  ];

  return (
    <aside className="wf-inspector">
      <div className="wf-inspector__head">
        <h3 className="wf-inspector__title">
          {t("editor.inspector.title")}
        </h3>
        <button
          type="button"
          className="wf-inspector__close"
          onClick={onClose}
          aria-label={t("common.close")}
        >
          ×
        </button>
      </div>

      {needsCommand ? (
        <div className="wf-inspector__field">
          <label className="wf-inspector__label">
            {t("editor.inspector.command")}
          </label>
          <Dropdown
            value={node.data.commandId ?? NONE}
            options={options}
            ariaLabel={t("editor.inspector.command")}
            onChange={(value) =>
              onCommandChange(node.id, value === NONE ? undefined : value)
            }
          />
        </div>
      ) : (
        <p className="wf-inspector__hint">
          {t(`editor.inspector.hint.${kind}`)}
        </p>
      )}

      <div className="wf-inspector__actions">
        {isStart ? null : (
          <button
            type="button"
          className="btn btn--danger wf-inspector__delete"
          onClick={() => onDelete(node.id)}
        >
          <TrashIcon />
          {t("editor.inspector.deleteNode")}
        </button>
        )}
        <button
          type="button"
          className="btn btn--run"
          onClick={onClose}
        >
          <CheckIcon />
          {t("common.apply")}
        </button>
      </div>
    </aside>
  );
}
