import type { ChangeEvent, ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type {
  Command,
  ConditionOp,
  ConditionSubject,
  DataAssignment,
  LoopConfig,
  RetryConfig,
  SwitchCase,
  WorkflowCondition,
} from "../../types";
import { getCommandName } from "../../utils/commandLabels";
import type {
  WorkflowFlowNode,
  WorkflowNodeData,
} from "../../utils/workflowGraph";
import { Dropdown } from "../Dropdown";
import type { DropdownOption } from "../Dropdown";
import { CheckIcon, PlusIcon, TrashIcon } from "../icons";

interface NodeInspectorProps {
  node: WorkflowFlowNode;
  commands: ReadonlyArray<Command>;
  onCommandChange: (nodeId: string, commandId: string | undefined) => void;
  onNodeDataChange: (nodeId: string, patch: Partial<WorkflowNodeData>) => void;
  onDelete: (nodeId: string) => void;
  onClose: () => void;
}

const SUBJECT_KINDS: ReadonlyArray<ConditionSubject["kind"]> = [
  "exitCode",
  "variable",
  "stdout",
];

const OPS: ReadonlyArray<ConditionOp> = [
  "eq",
  "ne",
  "contains",
  "regex",
  "gt",
  "lt",
];

/** A predicate the inspector defaults to when a control is first enabled. */
const DEFAULT_CONDITION: WorkflowCondition = {
  subject: { kind: "exitCode" },
  op: "eq",
  value: "0",
};

/** Parse a number input into a non-negative integer, or `undefined` when blank/invalid. */
function parseOptionalInt(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Narrow a dropdown string back to a {@link ConditionOp} (options come from OPS). */
function isConditionOp(value: string): value is ConditionOp {
  return OPS.some((op) => op === value);
}

interface ConditionEditorProps {
  condition: WorkflowCondition;
  onChange: (condition: WorkflowCondition) => void;
  label: string;
}

/**
 * Reusable three-control editor for a {@link WorkflowCondition}: subject
 * selector (+ variable-name input when `variable`), operator selector, and a
 * value input. Every change reports the full updated condition.
 */
function ConditionEditor({
  condition,
  onChange,
  label,
}: ConditionEditorProps): ReactElement {
  const { t } = useTranslation();

  const subjectOptions: ReadonlyArray<DropdownOption> = SUBJECT_KINDS.map(
    (kind) => ({ value: kind, label: t(`editor.inspector.subject.${kind}`) }),
  );
  const opOptions: ReadonlyArray<DropdownOption> = OPS.map((op) => ({
    value: op,
    label: t(`editor.inspector.op.${op}`),
  }));

  const handleSubjectKind = (kind: string): void => {
    const subject: ConditionSubject =
      kind === "variable"
        ? { kind: "variable", name: condition.subject.kind === "variable" ? condition.subject.name : "" }
        : kind === "stdout"
          ? { kind: "stdout" }
          : { kind: "exitCode" };
    onChange({ ...condition, subject });
  };

  const handleVariableName = (event: ChangeEvent<HTMLInputElement>): void => {
    onChange({
      ...condition,
      subject: { kind: "variable", name: event.target.value },
    });
  };

  return (
    <div className="wf-inspector__field">
      <label className="wf-inspector__label">{label}</label>
      <Dropdown
        value={condition.subject.kind}
        options={subjectOptions}
        ariaLabel={label}
        onChange={handleSubjectKind}
      />
      {condition.subject.kind === "variable" ? (
        <input
          className="input"
          type="text"
          value={condition.subject.name}
          placeholder={t("editor.inspector.variableName")}
          aria-label={t("editor.inspector.variableName")}
          onChange={handleVariableName}
        />
      ) : null}
      <Dropdown
        value={condition.op}
        options={opOptions}
        ariaLabel={t("editor.inspector.op.eq")}
        onChange={(op) => {
          if (isConditionOp(op)) onChange({ ...condition, op });
        }}
      />
      <input
        className="input"
        type="text"
        value={condition.value}
        placeholder={t("editor.inspector.value")}
        aria-label={t("editor.inspector.value")}
        onChange={(event) =>
          onChange({ ...condition, value: event.target.value })
        }
      />
    </div>
  );
}

/**
 * Right-hand panel for configuring the selected node. Command-running kinds
 * (`command` / `condition` / `switch` / `try`) expose a command picker; below
 * it each kind renders its own config form (predicate, cases, loop, retry,
 * data assignments). `start` is non-deletable (every workflow keeps exactly
 * one start); `end` shows only the hint.
 */
export function NodeInspector({
  node,
  commands,
  onCommandChange,
  onNodeDataChange,
  onDelete,
  onClose,
}: NodeInspectorProps): ReactElement {
  const { t } = useTranslation();
  const kind = node.data.kind;
  const needsCommand =
    kind === "command" ||
    kind === "condition" ||
    kind === "switch" ||
    kind === "try";
  const isStart = kind === "start";

  // Sentinel value for "no command picked" — Dropdown works on plain strings,
  // so the empty string maps to `undefined` on the way out.
  const NONE = "";
  const options: ReadonlyArray<DropdownOption> = [
    { value: NONE, label: t("editor.inspector.pickCommand") },
    ...commands.map((cmd) => ({ value: cmd.id, label: getCommandName(cmd, t) })),
  ];

  // --- condition ---------------------------------------------------------
  const usePredicate = node.data.condition !== undefined;
  const togglePredicate = (event: ChangeEvent<HTMLInputElement>): void => {
    onNodeDataChange(node.id, {
      condition: event.target.checked ? DEFAULT_CONDITION : undefined,
    });
  };

  // --- switch ------------------------------------------------------------
  const cases = node.data.cases ?? [];
  const updateCases = (next: SwitchCase[]): void => {
    onNodeDataChange(node.id, { cases: next });
  };
  const addCase = (): void => {
    updateCases([
      ...cases,
      { id: `case${cases.length + 1}`, condition: { ...DEFAULT_CONDITION } },
    ]);
  };

  // --- loop --------------------------------------------------------------
  const loop = node.data.loop;
  const loopMode: "count" | "while" = loop?.while !== undefined ? "while" : "count";
  const updateLoop = (next: LoopConfig): void => {
    onNodeDataChange(node.id, { loop: next });
  };
  const setLoopMode = (mode: "count" | "while"): void => {
    const maxIterations = loop?.maxIterations ?? 1000;
    if (mode === "while") {
      updateLoop({ while: { ...DEFAULT_CONDITION }, maxIterations });
    } else {
      updateLoop({ count: loop?.count ?? 1, maxIterations });
    }
  };

  // --- try ---------------------------------------------------------------
  const retry: RetryConfig = node.data.retry ?? { retries: 0 };
  const updateRetry = (next: RetryConfig): void => {
    onNodeDataChange(node.id, { retry: next });
  };

  // --- data --------------------------------------------------------------
  const data = node.data.data ?? [];
  const updateData = (next: DataAssignment[]): void => {
    onNodeDataChange(node.id, { data: next });
  };

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

      {kind === "condition" ? (
        <>
          <div className="wf-inspector__field">
            <label className="wf-inspector__label">
              <input
                type="checkbox"
                checked={usePredicate}
                onChange={togglePredicate}
              />{" "}
              {t("editor.inspector.condition.usePredicate")}
            </label>
          </div>
          {node.data.condition ? (
            <ConditionEditor
              condition={node.data.condition}
              label={t("editor.inspector.value")}
              onChange={(condition) =>
                onNodeDataChange(node.id, { condition })
              }
            />
          ) : null}
        </>
      ) : null}

      {kind === "switch" ? (
        <div className="wf-inspector__field">
          {cases.map((switchCase, index) => (
            <div key={index} className="wf-inspector__list-item">
              <div className="wf-inspector__row">
                <input
                  className="input"
                  type="text"
                  value={switchCase.id}
                  placeholder={t("editor.inspector.switch.caseId")}
                  aria-label={t("editor.inspector.switch.caseId")}
                  onChange={(event) =>
                    updateCases(
                      cases.map((c, i) =>
                        i === index ? { ...c, id: event.target.value } : c,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="btn btn--icon"
                  aria-label={t("editor.inspector.remove")}
                  onClick={() =>
                    updateCases(cases.filter((_, i) => i !== index))
                  }
                >
                  <TrashIcon />
                </button>
              </div>
              <ConditionEditor
                condition={switchCase.condition}
                label={t("editor.inspector.value")}
                onChange={(condition) =>
                  updateCases(
                    cases.map((c, i) =>
                      i === index ? { ...c, condition } : c,
                    ),
                  )
                }
              />
            </div>
          ))}
          <button type="button" className="btn btn--ghost" onClick={addCase}>
            <PlusIcon />
            {t("editor.inspector.switch.addCase")}
          </button>
          <p className="wf-inspector__hint">
            {t("editor.inspector.switch.defaultHint")}
          </p>
        </div>
      ) : null}

      {kind === "loop" ? (
        <div className="wf-inspector__field">
          <label className="wf-inspector__label">
            {t("editor.inspector.loop.mode")}
          </label>
          <Dropdown
            value={loopMode}
            options={[
              { value: "count", label: t("editor.inspector.loop.count") },
              { value: "while", label: t("editor.inspector.loop.while") },
            ]}
            ariaLabel={t("editor.inspector.loop.mode")}
            onChange={(mode) => setLoopMode(mode === "while" ? "while" : "count")}
          />
          {loopMode === "count" ? (
            <input
              className="input"
              type="number"
              min={0}
              value={loop?.count ?? ""}
              placeholder={t("editor.inspector.loop.count")}
              aria-label={t("editor.inspector.loop.count")}
              onChange={(event) =>
                updateLoop({
                  count: parseOptionalInt(event.target.value) ?? 0,
                  maxIterations: loop?.maxIterations ?? 1000,
                })
              }
            />
          ) : (
            <ConditionEditor
              condition={loop?.while ?? { ...DEFAULT_CONDITION }}
              label={t("editor.inspector.loop.while")}
              onChange={(whileCondition) =>
                updateLoop({
                  while: whileCondition,
                  maxIterations: loop?.maxIterations ?? 1000,
                })
              }
            />
          )}
          <label className="wf-inspector__label">
            {t("editor.inspector.loop.maxIterations")}
          </label>
          <input
            className="input"
            type="number"
            min={1}
            value={loop?.maxIterations ?? 1000}
            aria-label={t("editor.inspector.loop.maxIterations")}
            onChange={(event) =>
              updateLoop({
                ...(loopMode === "while"
                  ? { while: loop?.while ?? { ...DEFAULT_CONDITION } }
                  : { count: loop?.count ?? 0 }),
                maxIterations: parseOptionalInt(event.target.value) ?? 1000,
              })
            }
          />
        </div>
      ) : null}

      {kind === "try" ? (
        <div className="wf-inspector__field">
          <label className="wf-inspector__label">
            {t("editor.inspector.try.retries")}
          </label>
          <input
            className="input"
            type="number"
            min={0}
            value={retry.retries}
            aria-label={t("editor.inspector.try.retries")}
            onChange={(event) =>
              updateRetry({
                ...retry,
                retries: parseOptionalInt(event.target.value) ?? 0,
              })
            }
          />
          <label className="wf-inspector__label">
            {t("editor.inspector.try.backoffMs")}
          </label>
          <input
            className="input"
            type="number"
            min={0}
            value={retry.backoffMs ?? ""}
            aria-label={t("editor.inspector.try.backoffMs")}
            onChange={(event) =>
              updateRetry({
                retries: retry.retries,
                backoffMs: parseOptionalInt(event.target.value),
              })
            }
          />
        </div>
      ) : null}

      {kind === "data" ? (
        <div className="wf-inspector__field">
          {data.map((assignment, index) => (
            <div key={index} className="wf-inspector__row">
              <input
                className="input"
                type="text"
                value={assignment.name}
                placeholder={t("editor.inspector.data.name")}
                aria-label={t("editor.inspector.data.name")}
                onChange={(event) =>
                  updateData(
                    data.map((a, i) =>
                      i === index ? { ...a, name: event.target.value } : a,
                    ),
                  )
                }
              />
              <input
                className="input"
                type="text"
                value={assignment.value}
                placeholder={t("editor.inspector.data.value")}
                aria-label={t("editor.inspector.data.value")}
                onChange={(event) =>
                  updateData(
                    data.map((a, i) =>
                      i === index ? { ...a, value: event.target.value } : a,
                    ),
                  )
                }
              />
              <button
                type="button"
                className="btn btn--icon"
                aria-label={t("editor.inspector.remove")}
                onClick={() => updateData(data.filter((_, i) => i !== index))}
              >
                <TrashIcon />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => updateData([...data, { name: "", value: "" }])}
          >
            <PlusIcon />
            {t("editor.inspector.data.addAssignment")}
          </button>
        </div>
      ) : null}

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
