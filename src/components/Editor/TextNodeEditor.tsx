import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ReactElement, SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { useContextMenu } from "../ContextMenu";
import type { ContextMenuEntry } from "../ContextMenu";
import { tokenizeScript } from "../CommandForm/scriptHighlight";

/** Reserved `text`-node references for the predecessor's input. Kept in
 * lock-step with the Rust `TEXT_RAW_INPUT_VAR` / `TEXT_SCHEMA_INPUT_VAR`. */
const RAW_INPUT_VAR = "raw_input";
const SCHEMA_INPUT_VAR = "schema_input";

interface TextNodeEditorProps {
  /** The template text the node composes. */
  value: string;
  /** Variable names (from upstream `data` nodes that are guaranteed to run
   * before this node) the author can insert as `${name}` references. */
  variableNames: ReadonlyArray<string>;
  /** Whether the predecessor declares an output schema — gates the
   * "Schema (${schema_input})" incoming-data option. */
  hasSchemaInput: boolean;
  onChange: (next: string) => void;
}

/**
 * Editor for a `text` node: a textarea for composing template text, with a
 * right-click "Insert variable" menu (mirroring the command form's Script
 * field) that inserts a `${name}` reference at the caret for any upstream
 * variable. A hint below the textarea tells the user the insertion feature
 * exists. The expanded result becomes the node's output at run time.
 */
export function TextNodeEditor({
  value,
  variableNames,
  hasSchemaInput,
  onChange,
}: TextNodeEditorProps): ReactElement {
  const { t } = useTranslation();
  const { show: showContextMenu } = useContextMenu();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const overlayRef = useRef<HTMLPreElement | null>(null);

  // The references that resolve at run time — a `${name}` to one of these is
  // "known" (blue), anything else "unknown". Includes the dominating data-node
  // variables plus the reserved input specials (`raw_input` always, and
  // `schema_input` only when the predecessor has a schema).
  const knownNames = useMemo(() => {
    const names = new Set(variableNames);
    names.add(RAW_INPUT_VAR);
    if (hasSchemaInput) names.add(SCHEMA_INPUT_VAR);
    return names;
  }, [variableNames, hasSchemaInput]);
  // Segment the text into plain runs + `${var}` references for the highlight
  // overlay. Reuses the command-form tokenizer (single source of truth for the
  // `${name}` / `${name:default}` / `$$` grammar) with no utility/flag passes.
  const segments = useMemo(
    () => tokenizeScript(value, knownNames),
    [value, knownNames],
  );

  // Keep the highlight overlay scrolled in lock-step with the textarea.
  const handleScroll = useCallback(
    (e: SyntheticEvent<HTMLTextAreaElement>): void => {
      const overlay = overlayRef.current;
      if (!overlay) return;
      overlay.scrollTop = e.currentTarget.scrollTop;
      overlay.scrollLeft = e.currentTarget.scrollLeft;
    },
    [],
  );

  /** Replace the current selection with `text`, caret left after it. */
  const insertAtCursor = useCallback(
    (snippet: string): void => {
      const el = textareaRef.current;
      if (!el) return;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      el.focus();
      el.setRangeText(snippet, start, end, "end");
      onChange(el.value);
    },
    [onChange],
  );

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const handler = (e: MouseEvent): void => {
      e.stopImmediatePropagation();
      e.preventDefault();
      const selection = window.getSelection()?.toString() ?? "";
      const hasSelection = selection.length > 0;

      const items: ContextMenuEntry[] = [];

      // Incoming data: the predecessor's raw output (always) and its schema
      // result (only when the predecessor declares a schema).
      const inputSubmenu: ContextMenuEntry[] = [
        {
          id: "insert-raw-input",
          label: t("editor.inspector.text.rawInput"),
          onSelect: () => insertAtCursor(`\${${RAW_INPUT_VAR}}`),
        },
      ];
      if (hasSchemaInput) {
        inputSubmenu.push({
          id: "insert-schema-input",
          label: t("editor.inspector.text.schemaInput"),
          onSelect: () => insertAtCursor(`\${${SCHEMA_INPUT_VAR}}`),
        });
      }
      items.push({
        id: "incoming-data",
        label: t("editor.inspector.text.incomingData"),
        submenu: inputSubmenu,
      });

      if (variableNames.length > 0) {
        items.push({
          id: "insert-variable",
          label: t("editor.inspector.text.insertVariable"),
          submenu: variableNames.map((name) => ({
            id: `insert-variable-${name}`,
            label: name,
            onSelect: () => insertAtCursor(`\${${name}}`),
          })),
        });
      } else {
        items.push({
          id: "insert-variable",
          label: t("editor.inspector.text.insertVariable"),
          disabled: true,
        });
      }
      items.push({ id: "div-vars", divider: true });
      items.push(
        {
          id: "cut",
          label: t("contextMenu.cut"),
          disabled: !hasSelection,
          onSelect: () => {
            try {
              document.execCommand("cut");
            } catch (error) {
              console.warn("cut failed", error);
            }
          },
        },
        {
          id: "copy",
          label: t("contextMenu.copy"),
          disabled: !hasSelection,
          onSelect: () => {
            try {
              document.execCommand("copy");
            } catch (error) {
              console.warn("copy failed", error);
            }
          },
        },
        {
          id: "paste",
          label: t("contextMenu.paste"),
          onSelect: () => {
            navigator.clipboard
              ?.readText()
              .then((text) => {
                if (typeof text === "string") insertAtCursor(text);
              })
              .catch(() => {});
          },
        },
        { id: "div-edit", divider: true },
        {
          id: "select-all",
          label: t("contextMenu.selectAll"),
          onSelect: () => textareaRef.current?.select(),
        },
      );

      showContextMenu({
        event: {
          clientX: e.clientX,
          clientY: e.clientY,
          preventDefault: () => e.preventDefault(),
        },
        items,
      });
    };
    el.addEventListener("contextmenu", handler, { capture: true });
    return () => {
      el.removeEventListener("contextmenu", handler, { capture: true });
    };
  }, [variableNames, hasSchemaInput, t, insertAtCursor, showContextMenu]);

  return (
    <div className="wf-inspector__field">
      <label className="wf-inspector__label">
        {t("editor.inspector.text.label")}
      </label>
      {/* Overlay-highlight pattern (same as the command-form Script field): a
          `<pre>` paints the `${var}` references in colour behind a transparent
          textarea that owns input + caret. */}
      <div className="wf-text-editor">
        <pre
          ref={overlayRef}
          className="wf-text-editor__overlay"
          aria-hidden="true"
        >
          {segments.map((seg, i) =>
            seg.kind === "known" || seg.kind === "unknown" ? (
              <span
                key={i}
                className={`wf-text-editor__var wf-text-editor__var--${seg.kind}`}
              >
                {seg.text}
              </span>
            ) : (
              <span key={i}>{seg.text}</span>
            ),
          )}
          {/* Trailing-newline guard so the overlay height matches the
              textarea's scrollHeight (a `<pre>` collapses a final blank line). */}
          {value.endsWith("\n") ? "\u200B" : ""}
        </pre>
        <textarea
          ref={textareaRef}
          className="input wf-node-modal__text-input wf-text-editor__input"
          value={value}
          rows={6}
          spellCheck={false}
          placeholder={t("editor.inspector.text.placeholder")}
          aria-label={t("editor.inspector.text.label")}
          onChange={(e) => onChange(e.target.value)}
          onScroll={handleScroll}
        />
      </div>
      <p className="form-hint">{t("editor.inspector.text.hint")}</p>
    </div>
  );
}
