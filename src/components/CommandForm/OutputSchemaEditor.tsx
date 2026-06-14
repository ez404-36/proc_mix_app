import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useWheelPassthrough } from "../../hooks/useWheelPassthrough";
import type { ReactElement } from "react";
import type { TFunction } from "i18next";
import type {
  ExtractedResult,
  OutputField,
  OutputParserKind,
  OutputPipelineStep,
  OutputSchema,
} from "../../types";
import { Message } from "@arco-design/web-react";
import { ArrowDownIcon } from "../icons";
import { previewExtraction } from "../../services/outputExtraction";
import { copyText } from "../../utils/consoleClipboard";
import { Dropdown } from "../Dropdown";
import type { DropdownOption } from "../Dropdown";

/**
 * Parsers offered in the editor. Order matches the conceptual
 * progression from "no parsing" to "fully structured".
 */
const PARSER_KINDS: readonly OutputParserKind[] = [
  "raw",
  "lines",
  "json",
  "regex",
  "keyValue",
  "table",
];

/** Which parser surfaces which optional config inputs. */
function usesPattern(parser: OutputParserKind): boolean {
  return parser === "regex";
}
function usesDelimiter(parser: OutputParserKind): boolean {
  return parser === "keyValue" || parser === "table";
}
function usesHeader(parser: OutputParserKind): boolean {
  return parser === "table";
}
/** Which parsers let the user declare named fields with a locator. */
function usesFields(parser: OutputParserKind): boolean {
  return (
    parser === "json" ||
    parser === "regex" ||
    parser === "table" ||
    parser === "lines"
  );
}



export interface OutputSchemaEditorProps {
  /** Current schema, or `undefined` when the command has none. */
  value: OutputSchema | undefined;
  /** Emit the next schema, or `undefined` to clear it. */
  onChange: (next: OutputSchema | undefined) => void;
  /**
   * stdout captured from the most recent in-form run, used to
   * auto-fill the "sample output" textarea so the user can preview
   * extraction against real output without pasting it manually. The
   * auto-fill only applies while the user hasn't edited the textarea;
   * once they type, their value wins.
   */
  sampleOutput?: string;
  /**
   * Hide the "Sample output (for preview)" textarea entirely and drive all
   * previews from `sampleOutput` directly. Used by the workflow `parser` node,
   * where the modal's "example input" column already IS the sample, so a
   * duplicate sample field would be redundant.
   */
  hideSample?: boolean;
  t: TFunction;
}

/**
 * Inline editor for a command's output schema. Lets the user pick a
 * parser, configure it (pattern / delimiter / header), declare named
 * fields with a locator, choose the return field, and preview the
 * extraction against a pasted sample of stdout.
 *
 * Parsing is delegated to the Rust `preview_extraction` command — the
 * editor never re-implements parser logic on the TS side.
 *
 * `OutputSchema` always uses `pipeline: OutputPipelineStep[]` with at
 * least one step. There is no legacy single-parser mode in the UI.
 */
export function OutputSchemaEditor(
  props: OutputSchemaEditorProps,
): ReactElement {
  const { value, onChange, sampleOutput, hideSample = false, t } = props;
  const enabled = value !== undefined;

  const [sample, setSample] = useState<string>(() => value?.sample ?? "");
  const [preview, setPreview] = useState<ExtractedResult | null>(null);
  const [previewing, setPreviewing] = useState<boolean>(false);
  const [returnCollapsed, setReturnCollapsed] = useState<boolean>(false);
  const [sampleCollapsed, setSampleCollapsed] = useState<boolean>(false);
  // Per-step intermediate previews. Index `i` holds the result of running
  // pipeline steps 0..i (inclusive) so the connector between step i and
  // step i+1 can show real data.
  const [stepPreviews, setStepPreviews] = useState<ReadonlyArray<ExtractedResult | null>>([]);

  // Once the user types into the sample textarea their value is
  // authoritative — we stop auto-filling it from run output so a fresh
  // run can't clobber what they're editing.
  const sampleEditedRef = useRef<boolean>(false);

  // Whether the typed sample is persisted with the schema.
  const saveSample = value?.sample !== undefined;

  // Live ref to the preview runner so the debounced auto-preview effect
  // can invoke the latest runner without taking `runPreview` as a
  // dependency (it changes on every schema edit).
  const runPreviewRef = useRef<(text: string) => void>(() => {});

  const sampleTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const returnValueTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useWheelPassthrough(sampleTextareaRef);
  useWheelPassthrough(returnValueTextareaRef);

  // Callback ref for intermediate-value textareas — attaches wheel passthrough
  // imperatively since the number of steps is dynamic.
  const intermediateWheelRef = useCallback((el: HTMLTextAreaElement | null): void => {
    if (!el || el.dataset["wheelBound"] === "1") return;
    el.dataset["wheelBound"] = "1";
    el.addEventListener("wheel", (e: WheelEvent) => {
      const canScrollDown = el.scrollTop + el.clientHeight < el.scrollHeight;
      const canScrollUp = el.scrollTop > 0;
      if ((e.deltaY > 0 && canScrollDown) || (e.deltaY < 0 && canScrollUp)) return;
      let parent = el.parentElement;
      while (parent) {
        const ov = window.getComputedStyle(parent).overflowY;
        if ((ov === "auto" || ov === "scroll") && parent.scrollHeight > parent.clientHeight) {
          parent.scrollTop += e.deltaY;
          e.preventDefault();
          break;
        }
        parent = parent.parentElement;
      }
    }, { passive: false });
  }, []);

  const handleSampleChange = useCallback(
    (next: string): void => {
      sampleEditedRef.current = true;
      setSample(next);
      if (value !== undefined && value.sample !== undefined) {
        if (next === "") {
          const { sample: _omit, ...rest } = value;
          onChange(rest);
        } else {
          onChange({ ...value, sample: next });
        }
      }
    },
    [onChange, value],
  );

  const handleToggleSaveSample = useCallback(
    (next: boolean): void => {
      if (value === undefined) return;
      if (next) {
        onChange({ ...value, sample });
      } else {
        const { sample: _omit, ...rest } = value;
        onChange(rest);
      }
    },
    [onChange, sample, value],
  );

  const handleToggle = useCallback(
    (next: boolean): void => {
      onChange(next ? { pipeline: [{ parser: "raw", fields: [] }] } : undefined);
      setPreview(null);
    },
    [onChange],
  );

  // Patch root-level schema fields (returnField, source, sample).
  const patch = useCallback(
    (p: Partial<Pick<OutputSchema, "returnField" | "source" | "sample">>): void => {
      if (value === undefined) return;
      onChange({ ...value, ...p });
    },
    [onChange, value],
  );

  const handleStepParserChange = useCallback(
    (stepIndex: number, next: string): void => {
      if (value === undefined || !PARSER_KINDS.includes(next as OutputParserKind)) return;
      const pipeline = value.pipeline.map((s, i) =>
        i === stepIndex
          ? { parser: next as OutputParserKind, fields: [] }
          : s,
      );
      onChange({ ...value, pipeline });
    },
    [onChange, value],
  );

  const patchStep = useCallback(
    (stepIndex: number, p: Partial<OutputPipelineStep>): void => {
      if (value === undefined) return;
      const pipeline = value.pipeline.map((s, i) =>
        i === stepIndex ? { ...s, ...p } : s,
      );
      onChange({ ...value, pipeline });
    },
    [onChange, value],
  );

  const handleStepFieldChange = useCallback(
    (stepIndex: number, fieldIndex: number, p: Partial<OutputField>): void => {
      if (value === undefined) return;
      const pipeline = value.pipeline.map((s, si) =>
        si === stepIndex
          ? {
              ...s,
              fields: s.fields.map((f, fi) =>
                fi === fieldIndex ? { ...f, ...p } : f,
              ),
            }
          : s,
      );
      onChange({ ...value, pipeline });
    },
    [onChange, value],
  );

  const handleStepFieldAdd = useCallback(
    (stepIndex: number): void => {
      if (value === undefined) return;
      const pipeline = value.pipeline.map((s, si) =>
        si === stepIndex ? { ...s, fields: [...s.fields, { name: "" }] } : s,
      );
      onChange({ ...value, pipeline });
    },
    [onChange, value],
  );

  const handleStepFieldRemove = useCallback(
    (stepIndex: number, fieldIndex: number): void => {
      if (value === undefined) return;
      const pipeline = value.pipeline.map((s, si) =>
        si === stepIndex
          ? { ...s, fields: s.fields.filter((_, fi) => fi !== fieldIndex) }
          : s,
      );
      onChange({ ...value, pipeline });
    },
    [onChange, value],
  );

  const handleStepAdd = useCallback((): void => {
    if (value === undefined) return;
    onChange({
      ...value,
      pipeline: [...value.pipeline, { parser: "raw" as const, fields: [] }],
    });
  }, [onChange, value]);

  const handleStepRemove = useCallback(
    (stepIndex: number): void => {
      if (value === undefined) return;
      const next = value.pipeline.filter((_, i) => i !== stepIndex);
      // Always keep at least 1 step.
      if (next.length >= 1) {
        onChange({ ...value, pipeline: next });
      }
    },
    [onChange, value],
  );

  const handleStepMoveUp = useCallback(
    (stepIndex: number): void => {
      if (value === undefined || stepIndex === 0) return;
      const pipeline = [...value.pipeline];
      [pipeline[stepIndex - 1], pipeline[stepIndex]] = [
        pipeline[stepIndex],
        pipeline[stepIndex - 1],
      ];
      onChange({ ...value, pipeline });
    },
    [onChange, value],
  );

  const handleStepMoveDown = useCallback(
    (stepIndex: number): void => {
      if (value === undefined) return;
      const pipeline = [...value.pipeline];
      if (stepIndex >= pipeline.length - 1) return;
      [pipeline[stepIndex], pipeline[stepIndex + 1]] = [
        pipeline[stepIndex + 1],
        pipeline[stepIndex],
      ];
      onChange({ ...value, pipeline });
    },
    [onChange, value],
  );

  const runPreview = useCallback(
    async (text: string): Promise<void> => {
      if (value === undefined) return;
      setPreviewing(true);
      try {
        // Final result — pass value directly, Rust handles 1+ step pipelines.
        const resultPromise = previewExtraction(value, text);

        // Intermediate step previews: for step i, run pipeline[0..i+1].
        const { pipeline } = value;
        const stepPromises: Promise<ExtractedResult | null>[] =
          pipeline.length >= 2
            ? pipeline.map((_, i) => {
                const stepSchema: typeof value = {
                  ...value,
                  pipeline: pipeline.slice(0, i + 1),
                  returnField: undefined,
                };
                return previewExtraction(stepSchema, text).catch(() => null);
              })
            : [];

        const [result, ...intermediates] = await Promise.all([
          resultPromise,
          ...stepPromises,
        ]);
        setPreview(result);
        setStepPreviews(intermediates);
      } catch (err) {
        setPreview({
          fields: {},
          returnValue: null,
          error: err instanceof Error ? err.message : String(err),
        });
        setStepPreviews([]);
      } finally {
        setPreviewing(false);
      }
    },
    [value],
  );

  const previewReturnText =
    preview !== null && preview.error === undefined
      ? JSON.stringify(preview.returnValue, null, 2)
      : "";
  const previewText =
    preview === null
      ? ""
      : preview.error !== undefined
        ? preview.error
        : JSON.stringify(
            { fields: preview.fields, returnValue: preview.returnValue },
            null,
            2,
          );

  const handleCopyReturnValue = useCallback((): void => {
    if (previewReturnText === "") return;
    copyText(previewReturnText);
    Message.success(
      t("commandForm.outputSchema.previewCopied", {
        defaultValue: "Preview copied",
      }),
    );
  }, [previewReturnText, t]);

  useEffect(() => {
    runPreviewRef.current = (text: string) => void runPreview(text);
  }, [runPreview]);

  // The text all previews run against: when the sample textarea is hidden
  // (`hideSample`), drive previews from `sampleOutput` directly (the modal's
  // input column is the sample); otherwise from the in-editor `sample` state.
  const effectiveSample = hideSample ? (sampleOutput ?? "") : sample;

  useEffect(() => {
    if (value === undefined || effectiveSample === "") {
      setPreview(null);
      return;
    }
    const id = window.setTimeout(() => {
      runPreviewRef.current(effectiveSample);
    }, 300);
    return () => window.clearTimeout(id);
  }, [value, effectiveSample]);

  useEffect(() => {
    if (sampleEditedRef.current) return;
    if (sampleOutput === undefined || sampleOutput === "") return;
    setSample(sampleOutput);
  }, [sampleOutput]);

  const resizeSample = useCallback((): void => {
    const el = sampleTextareaRef.current;
    if (!el) return;
    if (el.offsetParent === null) return;
    const cs = getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || 18;
    const verticalPadding =
      parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const borders =
      parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const maxHeight = lineHeight * 18 + verticalPadding + borders;
    el.style.height = "auto";
    const contentHeight = el.scrollHeight + borders;
    el.style.height = `${Math.min(contentHeight, maxHeight)}px`;
    el.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
  }, []);

  useLayoutEffect(() => {
    resizeSample();
  }, [sample, resizeSample]);

  const parserOptions: ReadonlyArray<DropdownOption> = PARSER_KINDS.map(
    (k) => ({
      value: k,
      label: t(`commandForm.outputSchema.parsers.${k}`, { defaultValue: k }),
    }),
  );


  const lastStepFields: readonly OutputField[] =
    value !== undefined && value.pipeline.length > 0
      ? value.pipeline[value.pipeline.length - 1].fields
      : [];

  const returnFieldNames: readonly string[] =
    value === undefined
      ? []
      : Array.from(
          new Set([
            ...lastStepFields.map((f) => f.name.trim()).filter((n) => n !== ""),
            ...(preview !== null && preview.error === undefined
              ? Object.keys(preview.fields).filter((k) => k !== "result")
              : []),
          ]),
        );
  const returnFieldOptions: ReadonlyArray<DropdownOption> = [
    {
      value: "",
      label: t("commandForm.outputSchema.returnWhole", {
        defaultValue: "Whole result",
      }),
    },
    ...returnFieldNames.map((name) => ({ value: name, label: name })),
  ];

  // Steps are always value.pipeline.
  const steps = value?.pipeline ?? [];
  const multiStep = steps.length > 1;

  return (
    <div className="command-form__field command-form__output-schema">
      <div className="command-form__output-schema-header">
        <label className="command-form__field command-form__field--inline">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => handleToggle(e.target.checked)}
          />
          <span>
            {t("commandForm.outputSchema.enable", {
              defaultValue: "Parse output",
            })}
          </span>
        </label>
      </div>

      {enabled && value ? (
        <div className="command-form__output-schema-body">

          {/* Sample textarea — always at the top. Hidden for the parser node,
              whose modal input column already serves as the sample. */}
          {!hideSample ? (
          <div className="command-form__field">
            <span className="command-form__label">
              {t("commandForm.outputSchema.sample", {
                defaultValue: "Sample output (for preview)",
              })}
              <button
                type="button"
                className="btn btn--ghost btn--icon"
                onClick={() => setSampleCollapsed((c) => !c)}
                aria-expanded={!sampleCollapsed}
              >
                {sampleCollapsed ? "▾" : "▴"}
              </button>
            </span>
            {!sampleCollapsed ? (
              <>
                <textarea
                  ref={sampleTextareaRef}
                  className="input command-form__output-schema-sample"
                  value={sample}
                  rows={3}
                  onChange={(e) => handleSampleChange(e.target.value)}
                  onInput={resizeSample}
                  onFocus={resizeSample}
                  placeholder={t("commandForm.outputSchema.samplePlaceholder", {
                    defaultValue:
                      "Run the command to auto-fill, or paste sample stdout here…",
                  })}
                />
                <label className="command-form__field command-form__field--inline">
                  <input
                    type="checkbox"
                    checked={saveSample}
                    disabled={sample === ""}
                    onChange={(e) => handleToggleSaveSample(e.target.checked)}
                  />
                  <span>
                    {t("commandForm.outputSchema.saveSample", {
                      defaultValue: "Save this sample with the command",
                    })}
                  </span>
                </label>
                {saveSample ? (
                  <span className="command-form__hint" role="note">
                    {t("commandForm.outputSchema.saveSampleWarning", {
                      defaultValue:
                        "Make sure the sample contains no sensitive data.",
                    })}
                  </span>
                ) : null}
              </>
            ) : null}
          </div>
          ) : null}

          {/* Pipeline flow */}
          <div className="command-form__output-schema-flow">

            {steps.map((step, si) => (
              <div key={si} className="command-form__output-schema-flow-item">

                {/* Connector */}
                <div className="command-form__output-schema-connector">
                  {si === 0 ? (
                    <>
                      <div className="command-form__output-schema-connector-label command-form__output-schema-connector-label--source">
                        {t("commandForm.outputSchema.connectorSource", {
                          defaultValue: "Console output",
                        })}
                      </div>
                      <ArrowDownIcon />
                    </>
                  ) : (() => {
                    const prev = stepPreviews[si - 1];
                    const isError = prev !== null && prev !== undefined && prev.error !== undefined;
                    const text =
                      prev === null || prev === undefined
                        ? null
                        : prev.error !== undefined
                          ? prev.error
                          : JSON.stringify(prev.returnValue, null, 2);
                    return text !== null ? (
                      <>
                        <ArrowDownIcon />
                        <span className="command-form__label">
                          {t("commandForm.outputSchema.intermediateValue", { defaultValue: "Intermediate value" })}
                        </span>
                        <textarea
                          ref={intermediateWheelRef}
                          className={`input command-form__output-schema-preview-json command-form__output-schema-connector-intermediate ${isError ? "command-form__output-schema-preview-json--error" : "command-form__output-schema-preview-json--success"}`}
                          value={text}
                          readOnly
                          rows={4}
                          aria-label={t("commandForm.outputSchema.intermediateValue", { defaultValue: "Intermediate value" })}
                        />
                        <ArrowDownIcon />
                      </>
                    ) : (
                      <ArrowDownIcon />
                    );
                  })()}
                </div>

                {/* Parser step card */}
                <div className="command-form__output-schema-step">
                  <div className="command-form__output-schema-step-header">
                    <span className="command-form__label">
                      {multiStep
                        ? `${t("commandForm.outputSchema.pipelineStep", { defaultValue: "Parser" })} ${si + 1}`
                        : t("commandForm.outputSchema.parser", { defaultValue: "Parser" })}
                    </span>
                    {multiStep ? (
                      <div style={{ display: "flex", gap: "4px" }}>
                        <button
                          type="button"
                          className="btn btn--ghost btn--icon"
                          onClick={() => handleStepMoveUp(si)}
                          disabled={si === 0}
                          title={t("commandForm.outputSchema.stepMoveUp", { defaultValue: "Move up" })}
                        >
                          ▴
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--icon"
                          onClick={() => handleStepMoveDown(si)}
                          disabled={si === steps.length - 1}
                          title={t("commandForm.outputSchema.stepMoveDown", { defaultValue: "Move down" })}
                        >
                          ▾
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--icon"
                          onClick={() => handleStepRemove(si)}
                          title={t("commandForm.outputSchema.stepRemove", { defaultValue: "Remove step" })}
                        >
                          ×
                        </button>
                      </div>
                    ) : null}
                  </div>

                  <div className="command-form__output-schema-step-body">
                    <label className="command-form__field">
                      <Dropdown
                        value={step.parser}
                        options={parserOptions}
                        onChange={(next) => handleStepParserChange(si, next)}
                        ariaLabel={t("commandForm.outputSchema.parser", { defaultValue: "Parser" })}
                      />
                    </label>

                    {usesPattern(step.parser) ? (
                      <label className="command-form__field">
                        <span className="command-form__label">
                          {t("commandForm.outputSchema.pattern", { defaultValue: "Pattern (named groups)" })}
                        </span>
                        <input
                          type="text"
                          className="input"
                          value={step.pattern ?? ""}
                          onChange={(e) => patchStep(si, { pattern: e.target.value })}
                          placeholder="(?P<name>\\w+)"
                        />
                      </label>
                    ) : null}

                    {usesDelimiter(step.parser) ? (
                      <label className="command-form__field">
                        <span className="command-form__label">
                          {t("commandForm.outputSchema.delimiter", { defaultValue: "Delimiter" })}
                        </span>
                        <input
                          type="text"
                          className="input"
                          value={step.delimiter ?? ""}
                          onChange={(e) => patchStep(si, { delimiter: e.target.value })}
                          placeholder={
                            step.parser === "table"
                              ? t("commandForm.outputSchema.delimiterTablePlaceholder", { defaultValue: "leave empty to split on spaces" })
                              : t("commandForm.outputSchema.delimiterKeyValuePlaceholder", { defaultValue: "leave empty to auto-detect = or :" })
                          }
                        />
                        {step.parser === "table" ? (
                          <span className="command-form__hint" role="note">
                            {t("commandForm.outputSchema.delimiterTableHint", {
                              defaultValue: "Leave empty for output whose columns are separated by spaces (e.g. df, ls, ps). Set a delimiter only for CSV/TSV (e.g. , or \\t).",
                            })}
                          </span>
                        ) : null}
                      </label>
                    ) : null}

                    {usesHeader(step.parser) ? (
                      <label className="command-form__field command-form__field--inline">
                        <input
                          type="checkbox"
                          checked={step.hasHeader ?? false}
                          onChange={(e) => patchStep(si, { hasHeader: e.target.checked })}
                        />
                        <span>
                          {t("commandForm.outputSchema.hasHeader", { defaultValue: "First row is a header" })}
                        </span>
                      </label>
                    ) : null}

                    {usesFields(step.parser) ? (
                      <div className="command-form__output-schema-fields">
                        <span className="command-form__label">
                          {t("commandForm.outputSchema.fields", { defaultValue: "Fields" })}
                        </span>
                        <ul className="command-form__output-schema-field-list">
                          {step.fields.map((field, fi) => (
                            <li key={fi} className="command-form__output-schema-field-row">
                              <input
                                type="text"
                                className="input"
                                value={field.name}
                                onChange={(e) =>
                                  handleStepFieldChange(si, fi, { name: e.target.value })
                                }
                                placeholder={t("commandForm.outputSchema.fieldName", { defaultValue: "field name" })}
                                aria-label={t("commandForm.outputSchema.fieldName", { defaultValue: "field name" })}
                              />
                              <input
                                type="text"
                                className="input"
                                value={locatorValue(step.parser, field)}
                                onChange={(e) =>
                                  handleStepFieldChange(si, fi, locatorPatch(step.parser, e.target.value))
                                }
                                placeholder={locatorPlaceholder(step.parser, t)}
                                aria-label={locatorPlaceholder(step.parser, t)}
                              />
                              <button
                                type="button"
                                className="btn btn--ghost btn--icon"
                                onClick={() => handleStepFieldRemove(si, fi)}
                                title={t("commandForm.outputSchema.removeField", { defaultValue: "Remove field" })}
                              >
                                ×
                              </button>
                            </li>
                          ))}
                        </ul>
                        <button
                          type="button"
                          className="btn btn--primary"
                          onClick={() => handleStepFieldAdd(si)}
                        >
                          {t("commandForm.outputSchema.addField", { defaultValue: "Add field" })}
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}

            {/* Add parser button */}
            <div className="command-form__output-schema-flow-item">
              <div className="command-form__output-schema-connector">
                <ArrowDownIcon />
              </div>
              <button
                type="button"
                className="btn btn--primary"
                onClick={handleStepAdd}
              >
                {t("commandForm.outputSchema.addStep", { defaultValue: "+ Parser" })}
              </button>
            </div>

            {/* Final result node */}
            <div className="command-form__output-schema-flow-item">
              <div className="command-form__output-schema-connector">
                <ArrowDownIcon />
              </div>
              <div className="command-form__output-schema-result">
                <div className="command-form__output-schema-step-header">
                  <span className="command-form__label">
                    {t("commandForm.outputSchema.returnField", { defaultValue: "Return value" })}
                    {preview !== null && preview.error === undefined ? (
                      <button
                        type="button"
                        className="btn btn--ghost btn--icon"
                        onClick={() => setReturnCollapsed((c) => !c)}
                        aria-expanded={!returnCollapsed}
                      >
                        {returnCollapsed ? "▾" : "▴"}
                      </button>
                    ) : null}
                  </span>
                  {preview !== null && preview.error === undefined ? (
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={handleCopyReturnValue}
                      disabled={previewReturnText === ""}
                    >
                      {t("commandForm.outputSchema.copyPreview", { defaultValue: "Copy" })}
                    </button>
                  ) : null}
                </div>
                <Dropdown
                  value={value.returnField ?? ""}
                  options={returnFieldOptions}
                  onChange={(next) => patch({ returnField: next === "" ? undefined : next })}
                  ariaLabel={t("commandForm.outputSchema.returnField", { defaultValue: "Return value" })}
                />
                {preview !== null ? (
                  preview.error !== undefined ? (
                    <textarea
                      className="input command-form__output-schema-preview-json command-form__output-schema-preview-json--error"
                      value={previewText}
                      readOnly
                      rows={4}
                      role="alert"
                      aria-label={t("commandForm.outputSchema.returnField", { defaultValue: "Return value" })}
                    />
                  ) : !returnCollapsed ? (
                    <>
                      {previewing ? (
                        <span className="command-form__output-schema-preview-status" role="status">
                          {t("commandForm.outputSchema.previewing", { defaultValue: "updating…" })}
                        </span>
                      ) : null}
                      <textarea
                        ref={returnValueTextareaRef}
                        className="input command-form__output-schema-preview-json command-form__output-schema-preview-json--success"
                        value={previewReturnText}
                        readOnly
                        rows={4}
                        aria-label={t("commandForm.outputSchema.returnField", { defaultValue: "Return value" })}
                      />
                    </>
                  ) : null
                ) : (
                  <p className="command-form__output-schema-preview-empty" role="note">
                    {t("commandForm.outputSchema.previewEmpty", { defaultValue: "Add sample output to see the result." })}
                  </p>
                )}
              </div>
            </div>

          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The current locator string for a field, by parser. */
function locatorValue(parser: OutputParserKind, field: OutputField): string {
  switch (parser) {
    case "json":
      return field.path ?? "";
    case "regex":
      return field.group ?? "";
    case "table":
      return field.column ?? "";
    case "lines":
      return field.index ?? "";
    default:
      return "";
  }
}

/** Patch the right locator key for the current parser. */
function locatorPatch(
  parser: OutputParserKind,
  raw: string,
): Partial<OutputField> {
  const next = raw.trim() === "" ? undefined : raw;
  switch (parser) {
    case "json":
      return { path: next };
    case "regex":
      return { group: next };
    case "table":
      return { column: next };
    case "lines":
      return { index: next };
    default:
      return {};
  }
}

function locatorPlaceholder(parser: OutputParserKind, t: TFunction): string {
  switch (parser) {
    case "json":
      return "items[0].name";
    case "regex":
      return "group";
    case "table":
      return t("commandForm.outputSchema.columnPlaceholder", {
        defaultValue: "column name or index",
      });
    case "lines":
      return "0";
    default:
      return "";
  }
}
