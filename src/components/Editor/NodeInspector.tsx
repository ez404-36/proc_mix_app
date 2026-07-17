import { useEffect, useRef, useState } from "react";
import type {
  ChangeEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type {
  Command,
  ConditionOp,
  ConditionSubject,
  DataAssignment,
  DataSource,
  ExtractedResult,
  LoopConfig,
  RetryConfig,
  SwitchCase,
  VariableSpec,
  WorkflowCondition,
} from "../../types";
import { getCommandDescription, getCommandName } from "../../utils/commandLabels";
import { isRemoteTarget } from "../../utils/targetLabel";
import { dataSourceId, dataSourceOptions } from "../../utils/dataSourceOptions";
import {
  dominatingDataNodeVariableNames,
  variableSourceId,
  variableSourceOptions,
  workingDirSourceId,
  workingDirSourceOptions,
} from "../../utils/variableSourceOptions";
import type { NodeRunOutput } from "../../utils/nodePreviewData";
import {
  hasRaw,
  hasStructured,
  predecessorOutputSchema,
  previewText,
  rawText,
  resolveAssignmentDisplayValue,
  structuredText,
} from "../../utils/nodePreviewData";
import { useDerivedExtraction } from "./useDerivedExtraction";
import type {
  WorkflowFlowEdge,
  WorkflowFlowNode,
  WorkflowNodeData,
} from "../../utils/workflowGraph";
import { Dropdown } from "../Dropdown";
import type { DropdownOption } from "../Dropdown";
import { NumberStepper } from "../NumberStepper";
import { OutputSchemaEditor } from "../CommandForm/OutputSchemaEditor";
import { TargetBadge } from "../TargetBadge";
import { TextNodeEditor } from "./TextNodeEditor";
import { ToggleSwitch } from "../ToggleSwitch";
import {
  ArrowRightIcon,
  CheckIcon,
  PlusIcon,
  RunIcon,
  TrashIcon,
} from "../icons";

interface NodeInspectorProps {
  node: WorkflowFlowNode;
  /** The selected node's single predecessor (or null when 0/many), used to
   * offer a `data` node its kind-specific value sources. */
  predecessor: WorkflowFlowNode | null;
  /** Every node in the graph, for the per-variable source picker's
   * `data`-node enumeration. */
  allNodes: ReadonlyArray<WorkflowFlowNode>;
  /** Every edge in the graph, for the per-variable source picker's dominance
   * analysis (which `data` nodes are guaranteed to run before this one). */
  edges: ReadonlyArray<WorkflowFlowEdge>;
  commands: ReadonlyArray<Command>;
  /** This node's resolved run output (the "result example"), or null when it
   * has not produced capturable output in the active run. */
  outputPreview: NodeRunOutput | null;
  /** The predecessor's resolved run output — this node's "input example" — or
   * null when there is no resolvable predecessor output yet. */
  inputPreview: NodeRunOutput | null;
  /** Transient, manually-typed input sample (editor session only), shown when
   * there is no live run input. */
  manualInput: string;
  /** Transient, manually-typed result sample, shown when there is no live run
   * output. */
  manualOutput: string;
  onManualInputChange: (nodeId: string, value: string) => void;
  onManualOutputChange: (nodeId: string, value: string) => void;
  onCommandChange: (nodeId: string, commandId: string | undefined) => void;
  onNodeDataChange: (nodeId: string, patch: Partial<WorkflowNodeData>) => void;
  onDelete: (nodeId: string) => void;
  /**
   * Run this node and every node downstream of it, seeding the node's input
   * with `seedInput` (its current example-input text, or `null` when empty).
   * Absent for the `start` node (which has no meaningful per-node run).
   */
  onRunNode: (nodeId: string, seedInput: string | null) => void;
  /** Whether a run is already in flight (disables the run action). */
  isRunning: boolean;
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

interface VariableSourcesEditorProps {
  /** The variable specs declared by the node's referenced command. */
  specs: ReadonlyArray<VariableSpec>;
  /** Current per-variable sources on the node (by variable name). */
  variableSources: Record<string, DataSource>;
  /** The node whose variables are being edited (for dominance analysis). */
  nodeId: string;
  predecessor: WorkflowFlowNode | null;
  commands: ReadonlyArray<Command>;
  allNodes: ReadonlyArray<WorkflowFlowNode>;
  edges: ReadonlyArray<WorkflowFlowEdge>;
  onChange: (next: Record<string, DataSource>) => void;
}

/**
 * Per-variable value-source editor shown when the node's selected command
 * declares variables. One row per variable: the `$name` (read-only, with the
 * spec description as a tooltip), a source selector, and — only for the
 * `manual` source — a literal value input.
 *
 * The default (no entry in `variableSources`) is "ввести при запуске": a
 * variable the author hasn't bound is prompted at run time / falls back to its
 * spec default, exactly as before this feature.
 */
function VariableSourcesEditor({
  specs,
  variableSources,
  nodeId,
  predecessor,
  commands,
  allNodes,
  edges,
  onChange,
}: VariableSourcesEditorProps): ReactElement {
  const { t } = useTranslation();
  const options = variableSourceOptions(
    predecessor,
    commands,
    allNodes,
    edges,
    nodeId,
  );
  const dropdownOptions: DropdownOption[] = options.map((o) => ({
    value: o.id,
    label:
      o.field === undefined ? t(o.labelKey) : t(o.labelKey, { field: o.field }),
  }));

  // The effective source for a spec: explicit entry, else the implicit
  // "prompt at run time" default.
  const effectiveSource = (name: string): DataSource =>
    variableSources[name] ?? { kind: "atRun" };

  const setSource = (name: string, source: DataSource): void => {
    onChange({ ...variableSources, [name]: source });
  };

  return (
    <div className="wf-inspector__field">
      <label className="wf-inspector__label">
        {t("editor.inspector.variables.title")}
      </label>
      {specs.map((spec) => {
        const source = effectiveSource(spec.name);
        return (
          <div key={spec.name} className="wf-inspector__list-item">
            <div className="wf-inspector__row">
              <span
                className="wf-node-modal__var-name"
                title={spec.description ?? spec.name}
              >
                ${spec.name}
              </span>
            </div>
            <Dropdown
              value={variableSourceId(source)}
              options={dropdownOptions}
              ariaLabel={t("editor.inspector.variables.sourceLabel", {
                name: spec.name,
              })}
              onChange={(id) => {
                const picked = options.find((o) => o.id === id);
                if (picked === undefined) return;
                // Switching to manual keeps any literal already typed.
                const next: DataSource =
                  picked.source.kind === "manual"
                    ? {
                        kind: "manual",
                        value: source.kind === "manual" ? source.value : "",
                      }
                    : picked.source;
                setSource(spec.name, next);
              }}
            />
            {source.kind === "manual" ? (
              <input
                className="input"
                type="text"
                value={source.value}
                placeholder={t("editor.inspector.variables.valuePlaceholder")}
                aria-label={t("editor.inspector.variables.valueLabel", {
                  name: spec.name,
                })}
                onChange={(event) =>
                  setSource(spec.name, {
                    kind: "manual",
                    value: event.target.value,
                  })
                }
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

interface WorkingDirSourceEditorProps {
  /** Current working-dir source on the node, or `undefined` (no override). */
  workingDirSource: DataSource | undefined;
  /** The node whose working directory is being edited (for dominance analysis). */
  nodeId: string;
  allNodes: ReadonlyArray<WorkflowFlowNode>;
  edges: ReadonlyArray<WorkflowFlowEdge>;
  onChange: (next: DataSource | undefined) => void;
}

/**
 * Value-source editor for a command-bearing node's working directory,
 * mirroring {@link VariableSourcesEditor}'s dropdown + conditional
 * manual-value pattern. Only rendered when the node's selected command has
 * `promptWorkingDir: true` (see `NodeConfigForm`).
 */
function WorkingDirSourceEditor({
  workingDirSource,
  nodeId,
  allNodes,
  edges,
  onChange,
}: WorkingDirSourceEditorProps): ReactElement {
  const { t } = useTranslation();
  const options = workingDirSourceOptions(allNodes, edges, nodeId);
  const dropdownOptions: DropdownOption[] = options.map((o) => ({
    value: o.id,
    label:
      o.field === undefined ? t(o.labelKey) : t(o.labelKey, { field: o.field }),
  }));

  return (
    <div className="wf-inspector__field">
      <label className="wf-inspector__label">
        {t("editor.inspector.workingDir.title")}
      </label>
      <Dropdown
        value={workingDirSourceId(workingDirSource)}
        options={dropdownOptions}
        ariaLabel={t("editor.inspector.workingDir.title")}
        onChange={(id) => {
          const picked = options.find((o) => o.id === id);
          if (picked === undefined) return;
          if (picked.id === "none") {
            onChange(undefined);
            return;
          }
          // Switching to manual keeps any literal already typed.
          const next: DataSource =
            picked.source.kind === "manual"
              ? {
                  kind: "manual",
                  value:
                    workingDirSource?.kind === "manual"
                      ? workingDirSource.value
                      : "",
                }
              : picked.source;
          onChange(next);
        }}
      />
      {workingDirSource?.kind === "manual" ? (
        <input
          className="input"
          type="text"
          value={workingDirSource.value}
          placeholder={t("editor.inspector.workingDir.valuePlaceholder")}
          aria-label={t("editor.inspector.workingDir.valueLabel")}
          onChange={(event) =>
            onChange({ kind: "manual", value: event.target.value })
          }
        />
      ) : null}
    </div>
  );
}

interface NodeConfigFormProps {
  node: WorkflowFlowNode;
  predecessor: WorkflowFlowNode | null;
  commands: ReadonlyArray<Command>;
  /** Every node in the graph, to enumerate upstream `data`-node variables for
   * the per-variable source picker. */
  allNodes: ReadonlyArray<WorkflowFlowNode>;
  /** Every edge in the graph, for dominance analysis (which `data` nodes are
   * guaranteed to run before this one). */
  edges: ReadonlyArray<WorkflowFlowEdge>;
  /** Raw text of the predecessor's last-run output, used to preview a
   * `parser` node's extraction against real upstream output. */
  parserSampleInput: string;
  onCommandChange: (nodeId: string, commandId: string | undefined) => void;
  onNodeDataChange: (nodeId: string, patch: Partial<WorkflowNodeData>) => void;
}

/**
 * The per-kind configuration controls for the selected node — the centre
 * column of the node modal. Command-running kinds (`command` / `condition` /
 * `switch` / `try`) expose a command picker; below it each kind renders its
 * own config form (predicate, cases, loop, retry, data assignments). `start` /
 * `end` show only a hint.
 */
function NodeConfigForm({
  node,
  predecessor,
  commands,
  allNodes,
  edges,
  parserSampleInput,
  onCommandChange,
  onNodeDataChange,
}: NodeConfigFormProps): ReactElement {
  const { t } = useTranslation();
  const kind = node.data.kind;
  const needsCommand =
    kind === "command" ||
    kind === "condition" ||
    kind === "switch" ||
    kind === "try";

  // Variable specs of the node's selected command, to drive the per-variable
  // source editor. Empty when no command is picked or it declares none.
  const selectedCommand =
    node.data.commandId === undefined
      ? undefined
      : commands.find((c) => c.id === node.data.commandId);
  const variableSpecs = selectedCommand?.variables ?? [];
  const variableSources = node.data.variableSources ?? {};

  // Sentinel value for "no command picked" — Dropdown works on plain strings,
  // so the empty string maps to `undefined` on the way out.
  const NONE = "";
  // Command options carry the localized description as the dropdown
  // subtitle so the picker's built-in search matches on name AND
  // description — the same fields the Library command search uses.
  const options: ReadonlyArray<DropdownOption> = [
    { value: NONE, label: t("editor.inspector.pickCommand") },
    ...commands.map((cmd) => ({
      value: cmd.id,
      label:
        cmd.scope === "local"
          ? `${getCommandName(cmd, t)} ${t("editor.inspector.localSuffix")}`
          : getCommandName(cmd, t),
      // Closed trigger shows the plain name only — the "local" badge below the
      // picker is the single scope indicator for the selected command, so the
      // suffix would duplicate it.
      triggerLabel: getCommandName(cmd, t),
      description: getCommandDescription(cmd, t),
    })),
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
    if (mode === "while") {
      // `items` is meaningful only in count mode; dropped on switching away.
      updateLoop({
        while: { ...DEFAULT_CONDITION },
        maxIterations: loop?.maxIterations ?? 1000,
      });
    } else {
      // `count` mode has no separate "max iterations" field in the UI —
      // maxIterations tracks count so the safety cap never fires early.
      const count = loop?.count ?? 1;
      updateLoop({ count, maxIterations: count, items: loop?.items });
    }
  };

  // Per-iteration items (count mode only): a plain list of strings, always
  // exactly `count` long. Default to an empty list when unset.
  const loopItems: string[] = loop?.items ?? [];
  // Whether "pass data into each iteration" is on — gates the entire items
  // block. Its state is simply the presence/absence of `loop.items`.
  const passItems = loop?.items !== undefined;
  const togglePassItems = (next: boolean): void => {
    // On first open of a fresh "loop" node, `node.data.loop` is `undefined`
    // until the user touches `count`/mode via `updateLoop` — this toggle must
    // still work from that state instead of silently no-op'ing, so it
    // materializes the same `count: 1` default `NumberStepper` shows.
    if (loop === undefined) {
      if (!next) return;
      onNodeDataChange(node.id, {
        loop: { count: 1, maxIterations: 1, items: Array(1).fill("") },
      });
      return;
    }
    if (!next) {
      onNodeDataChange(node.id, { loop: { ...loop, items: undefined } });
      return;
    }
    if (loop.items !== undefined) return;
    const count = loop.count ?? 1;
    onNodeDataChange(node.id, {
      loop: { ...loop, items: Array(count).fill("") },
    });
  };
  const updateLoopItems = (values: string[]): void => {
    if (loop === undefined) return;
    onNodeDataChange(node.id, { loop: { ...loop, items: values } });
  };
  // Manual item values always track `count` in length — no add/remove UI;
  // truncate or pad with empty strings when `count` changes.
  const resizeManualItems = (values: string[], count: number): string[] => {
    if (values.length === count) return values;
    if (values.length > count) return values.slice(0, count);
    return [...values, ...Array(count - values.length).fill("")];
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

  // --- parallel ----------------------------------------------------------
  // A fork's branch count is dynamic — it equals the number of wired
  // `branch:<n>` edges (the node renders one extra free handle to drag the next
  // branch from). There is no manual count, so the inspector only configures
  // the bound join.
  // Join nodes the user can bind this fork to (the explicit barrier). Empty
  // value = no bound join (each branch terminates at its own end).
  const JOIN_NONE = "";
  const joinOptions: ReadonlyArray<DropdownOption> = [
    { value: JOIN_NONE, label: t("editor.inspector.parallel.noJoin") },
    ...allNodes
      .filter((n) => (n.type ?? n.data.kind) === "join")
      .map((n) => ({
        value: n.id,
        label: n.data.label ?? t("editor.nodes.join"),
      })),
  ];

  return (
    <>
      {needsCommand ? (
        <div className="wf-inspector__field">
          <label className="wf-inspector__label">
            {t("editor.inspector.command")}
          </label>
          <Dropdown
            value={node.data.commandId ?? NONE}
            options={options}
            ariaLabel={t("editor.inspector.command")}
            searchable
            searchPlaceholder={t("editor.inspector.searchCommand")}
            onChange={(value) =>
              onCommandChange(node.id, value === NONE ? undefined : value)
            }
          />
          {selectedCommand?.scope === "local" ? (
            <div className="wf-inspector__local-row">
              <span className="wf-palette__local-badge">
                {t("editor.palette.localBadge")}
              </span>
            </div>
          ) : null}
          {/* Read-only: a workflow command node inherits the command's
              execution target, so a remote-targeted command runs over SSH as
              a step too. Surfaced here so it's visible without opening the
              command form. */}
          {selectedCommand && isRemoteTarget(selectedCommand.target) ? (
            <div className="wf-inspector__local-row">
              <TargetBadge target={selectedCommand.target} />
            </div>
          ) : null}
        </div>
      ) : (
        <p className="wf-inspector__hint">
          {t(`editor.inspector.hint.${kind}`)}
        </p>
      )}

      {needsCommand && variableSpecs.length > 0 ? (
        <VariableSourcesEditor
          specs={variableSpecs}
          variableSources={variableSources}
          nodeId={node.id}
          predecessor={predecessor}
          commands={commands}
          allNodes={allNodes}
          edges={edges}
          onChange={(next) =>
            onNodeDataChange(node.id, { variableSources: next })
          }
        />
      ) : null}

      {needsCommand && selectedCommand?.promptWorkingDir ? (
        <WorkingDirSourceEditor
          workingDirSource={node.data.workingDirSource}
          nodeId={node.id}
          allNodes={allNodes}
          edges={edges}
          onChange={(next) =>
            onNodeDataChange(node.id, { workingDirSource: next })
          }
        />
      ) : null}

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
            <>
              <NumberStepper
                value={loop?.count ?? 1}
                min={1}
                max={1_000_000}
                ariaLabel={t("editor.inspector.loop.count")}
                decrementLabel={t("common.decrement")}
                incrementLabel={t("common.increment")}
                onChange={(count) => {
                  // `maxIterations` tracks `count` under the hood — there is
                  // no separate "max iterations" field in this mode.
                  const items =
                    loop?.items !== undefined
                      ? resizeManualItems(loop.items, count)
                      : undefined;
                  updateLoop({ count, maxIterations: count, items });
                }}
              />
              <div className="wf-inspector__field wf-inspector__row">
                <ToggleSwitch
                  checked={passItems}
                  onChange={togglePassItems}
                  ariaLabel={t("editor.inspector.loop.passItems")}
                />
                <span>{t("editor.inspector.loop.passItems")}</span>
              </div>
              {passItems ? (
                <>
                  <label className="wf-inspector__label">
                    {t("editor.inspector.loop.items")}
                  </label>
                  {loopItems.map((value, index) => (
                    <div key={index} className="wf-inspector__row">
                      <span className="wf-inspector__row-index">
                        {index + 1}
                      </span>
                      <input
                        className="input"
                        type="text"
                        value={value}
                        placeholder={t(
                          "editor.inspector.loop.itemsValuePlaceholder",
                        )}
                        aria-label={t(
                          "editor.inspector.loop.itemsValuePlaceholder",
                        )}
                        onChange={(event) =>
                          updateLoopItems(
                            loopItems.map((v, i) =>
                              i === index ? event.target.value : v,
                            ),
                          )
                        }
                      />
                    </div>
                  ))}
                </>
              ) : null}
            </>
          ) : (
            <>
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
                    while: loop?.while ?? { ...DEFAULT_CONDITION },
                    maxIterations,
                  })
                }
              />
            </>
          )}
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

      {kind === "parser" ? (
        <div className="wf-inspector__field">
          <OutputSchemaEditor
            value={node.data.parser}
            sampleOutput={parserSampleInput}
            hideSample
            onChange={(parser) => onNodeDataChange(node.id, { parser })}
            t={t}
          />
        </div>
      ) : null}

      {kind === "text" ? (
        <TextNodeEditor
          value={node.data.text ?? ""}
          variableNames={dominatingDataNodeVariableNames(
            allNodes,
            edges,
            node.id,
          )}
          hasSchemaInput={
            predecessorOutputSchema(predecessor, commands) !== undefined
          }
          onChange={(text) => onNodeDataChange(node.id, { text })}
        />
      ) : null}

      {kind === "parallel" ? (
        <div className="wf-inspector__field">
          <p className="wf-inspector__hint">
            {t("editor.inspector.parallel.branchesHint")}
          </p>
          <label className="wf-inspector__label">
            {t("editor.inspector.parallel.join")}
          </label>
          <Dropdown
            value={node.data.joinNodeId ?? JOIN_NONE}
            options={joinOptions}
            ariaLabel={t("editor.inspector.parallel.join")}
            onChange={(value) =>
              onNodeDataChange(node.id, {
                joinNodeId: value === JOIN_NONE ? undefined : value,
              })
            }
          />
          <p className="wf-inspector__hint">
            {t("editor.inspector.parallel.joinHint")}
          </p>
        </div>
      ) : null}
    </>
  );
}

interface PreviewColumnProps {
  /** Localized column heading ("Пример входящих данных" / "Пример результата"). */
  title: string;
  /** Live run output for this side, or null when none is available yet. */
  live: NodeRunOutput | null;
  /** The manually-typed sample, used when there is no live run output. */
  manualValue: string;
  manualAriaLabel: string;
  manualPlaceholder: string;
  onManualChange: (value: string) => void;
}

/** Which representation a preview column is showing. `raw` = stdout text,
 * `schema` = the structured output-schema extraction. */
type PreviewTab = "raw" | "schema";

/**
 * One preview column of the node modal. Shows the actual data the last editor
 * run produced for this side when present (read-only), otherwise an editable
 * textarea so the author can supply a sample by hand. When the run produced
 * BOTH a raw stdout and a structured (schema) result, a console-style tab
 * strip lets the user switch between the two views.
 */
function PreviewColumn({
  title,
  live,
  manualValue,
  manualAriaLabel,
  manualPlaceholder,
  onManualChange,
}: PreviewColumnProps): ReactElement {
  const { t } = useTranslation();
  const showRaw = hasRaw(live);
  const showSchema = hasStructured(live);
  const showTabs = showRaw && showSchema;
  // Default to the structured view when present (it is the more useful shape
  // for downstream data flow); fall back to raw otherwise.
  const [tab, setTab] = useState<PreviewTab>(showSchema ? "schema" : "raw");

  const hasLive = previewText(live) !== "";
  const activeText =
    tab === "schema" && showSchema ? structuredText(live) : rawText(live);

  return (
    <div className="wf-node-modal__preview">
      <div className="wf-node-modal__preview-head">
        <ArrowRightIcon />
        <span className="wf-node-modal__preview-title">{title}</span>
      </div>
      {hasLive ? (
        <>
          {showTabs ? (
            <div className="wf-node-modal__preview-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "raw"}
                className={`wf-node-modal__preview-tab${
                  tab === "raw" ? " is-active" : ""
                }`}
                onClick={() => setTab("raw")}
              >
                {t("editor.inspector.preview.tabRaw")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "schema"}
                className={`wf-node-modal__preview-tab${
                  tab === "schema" ? " is-active" : ""
                }`}
                onClick={() => setTab("schema")}
              >
                {t("editor.inspector.preview.tabSchema")}
              </button>
            </div>
          ) : null}
          <pre className="wf-node-modal__preview-data">
            {showTabs ? activeText : previewText(live)}
          </pre>
          <p className="wf-node-modal__preview-note">
            {live?.truncated === true
              ? t("editor.inspector.preview.fromRunTruncated")
              : t("editor.inspector.preview.fromRun")}
          </p>
        </>
      ) : (
        <>
          <textarea
            className="input wf-node-modal__preview-input"
            value={manualValue}
            placeholder={manualPlaceholder}
            aria-label={manualAriaLabel}
            onChange={(event) => onManualChange(event.target.value)}
          />
          <p className="wf-node-modal__preview-note">
            {t("editor.inspector.preview.manualHint")}
          </p>
        </>
      )}
    </div>
  );
}

interface InputPreviewColumnProps {
  /** The current input RAW text — a manual override if the author typed one,
   * else the predecessor's live-run raw stdout. */
  rawValue: string;
  /** The structured extraction derived from `rawValue` under the predecessor's
   * schema (null when the predecessor has no schema or nothing extracted). */
  derived: ExtractedResult | null;
  /** Whether the predecessor declares an output schema (→ offer the schema
   * tab, always read-only). */
  hasSchema: boolean;
  placeholder: string;
  /** Called when the author edits the RAW textarea (always editable). */
  onRawChange: (value: string) => void;
}

/**
 * The INPUT (left) column of the node modal. Unlike the result column, the
 * RAW view here is ALWAYS an editable textarea — even after a run — so the
 * author can tweak the example input by hand (req: a run must not lock raw).
 * The SCHEMA view is ALWAYS read-only and is DERIVED from the current raw text
 * via the authoritative extractor (req: schema data is never hand-editable,
 * and a manual raw entry still forms the schema when the predecessor has one).
 */
function InputPreviewColumn({
  rawValue,
  derived,
  hasSchema,
  placeholder,
  onRawChange,
}: InputPreviewColumnProps): ReactElement {
  const { t } = useTranslation();
  // Default to the schema view when one exists (the more useful downstream
  // shape); raw otherwise. The raw tab stays editable in both cases.
  const [tab, setTab] = useState<PreviewTab>(hasSchema ? "schema" : "raw");
  const effectiveTab = hasSchema ? tab : "raw";

  const schemaText =
    derived === null
      ? ""
      : structuredText({ structured: derived, truncated: false });

  return (
    <div className="wf-node-modal__preview">
      <div className="wf-node-modal__preview-head">
        <ArrowRightIcon />
        <span className="wf-node-modal__preview-title">
          {t("editor.inspector.preview.inputTitle")}
        </span>
      </div>
      {hasSchema ? (
        <div className="wf-node-modal__preview-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={effectiveTab === "raw"}
            className={`wf-node-modal__preview-tab${
              effectiveTab === "raw" ? " is-active" : ""
            }`}
            onClick={() => setTab("raw")}
          >
            {t("editor.inspector.preview.tabRaw")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={effectiveTab === "schema"}
            className={`wf-node-modal__preview-tab${
              effectiveTab === "schema" ? " is-active" : ""
            }`}
            onClick={() => setTab("schema")}
          >
            {t("editor.inspector.preview.tabSchema")}
          </button>
        </div>
      ) : null}

      {effectiveTab === "schema" ? (
        <>
          <pre className="wf-node-modal__preview-data">
            {schemaText === ""
              ? t("editor.inspector.preview.schemaPending")
              : schemaText}
          </pre>
          <p className="wf-node-modal__preview-note">
            {t("editor.inspector.preview.schemaDerived")}
          </p>
        </>
      ) : (
        <>
          <textarea
            className="input wf-node-modal__preview-input"
            value={rawValue}
            placeholder={placeholder}
            aria-label={t("editor.inspector.preview.inputTitle")}
            onChange={(event) => onRawChange(event.target.value)}
          />
          <p className="wf-node-modal__preview-note">
            {t("editor.inspector.preview.manualHint")}
          </p>
        </>
      )}
    </div>
  );
}

interface DataVarsResultProps {
  /** The data node's assignments (name + source/value). */
  assignments: ReadonlyArray<DataAssignment>;
  /** The current input raw text (the predecessor's output) used to resolve
   * `rawOutput`-sourced values to their actual value. */
  inputRaw: string;
  /** The structured extraction of the input, used to resolve `schemaOutput` /
   * `field` sources to their actual value. Null when none. */
  inputResult: ExtractedResult | null;
}

/**
 * The RESULT column for a `data` node. A `data` node produces no output of its
 * own — it only records named variables usable anywhere later in the scenario.
 * So instead of a preview/textarea, show a read-only `key=value` info block of
 * the variables it sets. Each value is resolved against the node's INPUT where
 * possible (`rawOutput` → the input text, `schemaOutput`/`field` → the input's
 * extraction); a source whose value is only known at run time (exit code, …)
 * shows a `<source>` placeholder.
 */
function DataVarsResult({
  assignments,
  inputRaw,
  inputResult,
}: DataVarsResultProps): ReactElement {
  const { t } = useTranslation();
  const rows = assignments.filter((a) => a.name.trim() !== "");
  const placeholder = (kind: DataSource["kind"]): string =>
    t(`editor.inspector.preview.dataVarSource.${kind}`, { defaultValue: kind });

  return (
    <div className="wf-node-modal__preview">
      <div className="wf-node-modal__preview-head">
        <ArrowRightIcon />
        <span className="wf-node-modal__preview-title">
          {t("editor.inspector.preview.dataVarsTitle")}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="wf-node-modal__preview-note">
          {t("editor.inspector.preview.dataVarsEmpty")}
        </p>
      ) : (
        <dl className="wf-node-modal__vars">
          {rows.map((a, index) => {
            // Resolve the actual value from the input when the source allows
            // it; fall back to a `<source>` placeholder otherwise.
            const value = resolveAssignmentDisplayValue(
              a,
              inputRaw,
              inputResult,
              placeholder,
            );
            return (
              <div key={index} className="wf-node-modal__var-row">
                <span className="wf-node-modal__var-key">{a.name}</span>
                <span className="wf-node-modal__var-eq">=</span>
                <span className="wf-node-modal__var-val">{value}</span>
              </div>
            );
          })}
        </dl>
      )}
      <p className="wf-node-modal__preview-note">
        {t("editor.inspector.preview.dataVarsHint")}
      </p>
    </div>
  );
}

/**
 * Node-editor modal. A centered three-column dialog (portal to `body`):
 *   - header: the node-kind label, an Apply (✓) and Delete (🗑) action, and a
 *     close (×);
 *   - left column: the example INPUT data (the predecessor's last-run result,
 *     or a manual sample);
 *   - centre column: the node's configuration form;
 *   - right column: the example RESULT (this node's last-run output, or a
 *     manual sample).
 *
 * `start` is non-deletable (every workflow keeps exactly one start). Esc and
 * an outside click close (edits auto-persist, so closing == applying).
 */
export function NodeInspector({
  node,
  predecessor,
  allNodes,
  edges,
  commands,
  outputPreview,
  inputPreview,
  manualInput,
  manualOutput,
  onManualInputChange,
  onManualOutputChange,
  onCommandChange,
  onNodeDataChange,
  onDelete,
  onRunNode,
  isRunning,
  onClose,
}: NodeInspectorProps): ReactElement {
  const { t } = useTranslation();
  const kind = node.data.kind;
  const isStart = kind === "start";
  const applyRef = useRef<HTMLButtonElement | null>(null);

  // The effective input RAW text shown in the (always-editable) raw view: a
  // manual override when the author typed one, else the predecessor's live-run
  // raw stdout. Editing the raw textarea writes the manual override.
  const inputRaw = manualInput !== "" ? manualInput : rawText(inputPreview);

  // The predecessor's output schema (command outputSchema or parser schema),
  // and the extraction of the CURRENT input raw under it — so the input's
  // "Output schema" view is derived from whatever raw text is shown (live OR
  // manual), and is always read-only. Null when the predecessor has no schema.
  const predSchema = predecessorOutputSchema(predecessor, commands);
  const derivedInput = useDerivedExtraction(inputRaw, predSchema);

  // The seed for a per-node run is whatever the input column currently shows.
  // An empty string maps to `null` (the node legitimately has no input).
  const seedInput = inputRaw === "" ? null : inputRaw;

  useEffect(() => {
    applyRef.current?.focus();
  }, []);

  const handleBackdropClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) onClose();
  };

  const kindLabel = t(`editor.nodes.${kind}`);

  const modal = (
    <div className="command-form__backdrop" onClick={handleBackdropClick}>
      <div
        className="command-form wf-node-modal"
        role="dialog"
        aria-modal="true"
        aria-label={kindLabel}
      >
        <div className="wf-node-modal__head">
          <h3 className="wf-node-modal__title">{kindLabel}</h3>
          <div className="wf-node-modal__head-actions">
            {kind === "start" || kind === "end" ? null : (
              <button
                type="button"
                className="btn btn--icon btn--run"
                onClick={() => onRunNode(node.id, seedInput)}
                disabled={isRunning}
                aria-label={t("editor.inspector.runNode")}
                title={t("editor.inspector.runNode")}
              >
                <RunIcon />
              </button>
            )}
            <button
              ref={applyRef}
              type="button"
              className="btn btn--icon btn--edit"
              onClick={onClose}
              aria-label={t("common.apply")}
              title={t("common.apply")}
            >
              <CheckIcon />
            </button>
            {isStart ? null : (
              <button
                type="button"
                className="btn btn--icon btn--danger"
                onClick={() => onDelete(node.id)}
                aria-label={t("editor.inspector.deleteNode")}
                title={t("editor.inspector.deleteNode")}
              >
                <TrashIcon />
              </button>
            )}
            <button
              type="button"
              className="wf-node-modal__close"
              onClick={onClose}
              aria-label={t("common.close")}
            >
              ×
            </button>
          </div>
        </div>

        <div className="wf-node-modal__body">
          <InputPreviewColumn
            rawValue={inputRaw}
            derived={derivedInput}
            hasSchema={predSchema !== undefined}
            placeholder={t("editor.inspector.preview.inputPlaceholder")}
            onRawChange={(value) => onManualInputChange(node.id, value)}
          />

          <div className="wf-node-modal__form">
            <NodeConfigForm
              node={node}
              predecessor={predecessor}
              commands={commands}
              allNodes={allNodes}
              edges={edges}
              parserSampleInput={inputRaw}
              onCommandChange={onCommandChange}
              onNodeDataChange={onNodeDataChange}
            />
          </div>

          {kind === "data" ? (
            <DataVarsResult
              assignments={node.data.data ?? []}
              inputRaw={inputRaw}
              inputResult={derivedInput}
            />
          ) : (
            <PreviewColumn
              title={t("editor.inspector.preview.resultTitle")}
              live={outputPreview}
              manualValue={manualOutput}
              manualAriaLabel={t("editor.inspector.preview.resultTitle")}
              manualPlaceholder={t(
                "editor.inspector.preview.resultPlaceholder",
              )}
              onManualChange={(value) => onManualOutputChange(node.id, value)}
            />
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
