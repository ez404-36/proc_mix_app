import type { ChangeEvent, ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type {
  Command,
  ConditionOp,
  ConditionSubject,
  DataAssignment,
  DataSource,
  LoopConfig,
  RetryConfig,
  SwitchCase,
  WorkflowCondition,
} from "../../types";
import { getCommandName } from "../../utils/commandLabels";
import { dataSourceId, dataSourceOptions } from "../../utils/dataSourceOptions";
import type {
  WorkflowFlowNode,
  WorkflowNodeData,
} from "../../utils/workflowGraph";
import { Dropdown } from "../Dropdown";
import type { DropdownOption } from "../Dropdown";
import { NumberStepper } from "../NumberStepper";
import { CheckIcon, PlusIcon, TrashIcon } from "../icons";

interface NodeInspectorProps {
  node: WorkflowFlowNode;
  /** The selected node's single predecessor (or null when 0/many), used to
   * offer a `data` node its kind-specific value sources. */
  predecessor: WorkflowFlowNode | null;
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
  predecessor,
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
  // Value sources available to each assignment, derived from the data node's
  // single predecessor (kind-specific). Recomputed per render; cheap.
  const sourceOptions = dataSourceOptions(predecessor, commands);
  const sourceDropdownOptions: DropdownOption[] = sourceOptions.map((o) => ({
    value: o.id,
    label:
      o.field === undefined
        ? t(o.labelKey)
        : t(o.labelKey, { field: o.field }),
  }));
  // The effective source of an assignment (legacy records have no `source` →
  // treated as manual, mirroring the Rust `effective_source`).
  const effectiveSource = (a: DataAssignment): DataSource =>
    a.source ?? { kind: "manual", value: a.value };

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
            <NumberStepper
              value={loop?.count ?? 1}
              min={1}
              max={1_000_000}
              ariaLabel={t("editor.inspector.loop.count")}
              decrementLabel={t("common.decrement")}
              incrementLabel={t("common.increment")}
              onChange={(count) =>
                updateLoop({
                  count,
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
          <NumberStepper
            value={loop?.maxIterations ?? 1000}
            min={1}
            max={1_000_000}
            ariaLabel={t("editor.inspector.loop.maxIterations")}
            decrementLabel={t("common.decrement")}
            incrementLabel={t("common.increment")}
            onChange={(maxIterations) =>
              updateLoop({
                ...(loopMode === "while"
                  ? { while: loop?.while ?? { ...DEFAULT_CONDITION } }
                  : { count: loop?.count ?? 1 }),
                maxIterations,
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
          <NumberStepper
            value={retry.retries}
            min={0}
            max={100}
            ariaLabel={t("editor.inspector.try.retries")}
            decrementLabel={t("common.decrement")}
            incrementLabel={t("common.increment")}
            onChange={(retries) => updateRetry({ ...retry, retries })}
          />
          <label className="wf-inspector__label">
            {t("editor.inspector.try.backoffMs")}
          </label>
          <NumberStepper
            value={retry.backoffMs ?? 0}
            min={0}
            max={600_000}
            step={100}
            ariaLabel={t("editor.inspector.try.backoffMs")}
            decrementLabel={t("common.decrement")}
            incrementLabel={t("common.increment")}
            onChange={(backoffMs) =>
              updateRetry({
                retries: retry.retries,
                // 0 = no pause (the runner treats Some(0) like None).
                backoffMs: backoffMs === 0 ? undefined : backoffMs,
              })
            }
          />
        </div>
      ) : null}

      {kind === "data" ? (
        <div className="wf-inspector__field">
          {data.map((assignment, index) => {
            const source = effectiveSource(assignment);
            return (
              <div key={index} className="wf-inspector__list-item">
                <div className="wf-inspector__row">
                  <input
                    className="input"
                    type="text"
                    value={assignment.name}
                    placeholder={t("editor.inspector.data.name")}
                    aria-label={t("editor.inspector.data.name")}
                    onChange={(event) =>
                      updateData(
                        data.map((a, i) =>
                          i === index
                            ? { ...a, name: event.target.value }
                            : a,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="btn btn--icon"
                    aria-label={t("editor.inspector.remove")}
                    onClick={() =>
                      updateData(data.filter((_, i) => i !== index))
                    }
                  >
                    <TrashIcon />
                  </button>
                </div>
                <Dropdown
                  value={dataSourceId(source)}
                  options={sourceDropdownOptions}
                  ariaLabel={t("editor.inspector.data.source.label")}
                  onChange={(id) => {
                    const picked = sourceOptions.find((o) => o.id === id);
                    if (picked === undefined) return;
                    // Switching to manual keeps any text already typed.
                    const nextSource: DataSource =
                      picked.source.kind === "manual"
                        ? { kind: "manual", value: assignment.value }
                        : picked.source;
                    updateData(
                      data.map((a, i) =>
                        i === index ? { ...a, source: nextSource } : a,
                      ),
                    );
                  }}
                />
                {source.kind === "manual" ? (
                  <input
                    className="input"
                    type="text"
                    value={assignment.value}
                    placeholder={t("editor.inspector.data.value")}
                    aria-label={t("editor.inspector.data.value")}
                    onChange={(event) =>
                      updateData(
                        data.map((a, i) =>
                          i === index
                            ? {
                                ...a,
                                value: event.target.value,
                                source: {
                                  kind: "manual",
                                  value: event.target.value,
                                },
                              }
                            : a,
                        ),
                      )
                    }
                  />
                ) : null}
              </div>
            );
          })}
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() =>
              updateData([
                ...data,
                { name: "", value: "", source: { kind: "manual", value: "" } },
              ])
            }
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
