// Reusable text field wrapper that adds "insert artifact reference" affordances
// to inputs/textareas in the mini-app editor's properties panel.
//
// Two ways to drop a `${name}` token into the field:
//  1. **Autocomplete** — while typing, an unclosed `${` token before the cursor
//     triggers a filtered dropdown; selecting a name completes `${name}`.
//  2. **Right-click menu** — a native context menu with an "Insert artifact"
//     submenu (plus standard cut/copy/paste/select-all), mirroring the command
//     form's Script field.
//
// The field is also syntax-highlighted with an overlay `<pre>`: `${name}`
// references to a known artifact render in the accent colour, unknown names in
// the warning colour (typo-spotting) — the same technique the command Script
// editor and the workflow text node use.
//
// The `${name}` syntax matches the executor's `VAR_RE` grammar
// (`/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g`), so an inserted reference
// is resolved at run time exactly like a command variable.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  SyntheticEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useContextMenu } from "../ContextMenu";
import type { ContextMenuEntry } from "../ContextMenu";
import { useFlagsByUtility } from "../../hooks/useFlagsByUtility";
import { useUtilitiesHelp } from "../../hooks/useUtilityHelp";
import type { ParsedFlag } from "../../types";
import { parseUtilityNamesWithRanges } from "../../utils/utilityName";
import type { UtilityNameRange } from "../../utils/utilityName";
import { buildFlagHighlights, tokenizeScript } from "../CommandForm/scriptHighlight";
import type {
  FlagHighlight,
  UtilityHighlight,
  UtilityHighlightStatus,
} from "../CommandForm/scriptHighlight";

export interface ArtifactRefInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Artifact names available for insertion (empty strings are ignored). */
  artifactNames: ReadonlyArray<string>;
  /** Render a `<textarea>` instead of an `<input>`. */
  multiline?: boolean;
  /**
   * Mark this field as an actual shell script (an inline action's `script`,
   * a status source's inline probe, …) so its overlay ALSO carves out
   * leading-utility and flag tokens, using the exact same
   * `command-form__script-editor-utility(--found/--missing/--pending)` /
   * `command-form__script-editor-flag(--found/--not-found)` classes as the
   * command form's `ScriptEditor`. Fields that hold a label or an artifact
   * value (not a command) must leave this `false` (the default): they only
   * get `${var}` reference highlighting, never utility/flag colouring —
   * highlighting `--config` inside a plain label would be misleading.
   */
  shellSyntax?: boolean;
  placeholder?: string;
  /** Rows for the textarea variant (ignored for single-line). */
  rows?: number;
  /** Accessible label (the field is no longer wrapped in a `<label>`). */
  ariaLabel: string;
  /**
   * Mark the field as failing validation: adds `.input--error` and
   * `aria-invalid`, matching the plain `.input` pattern used elsewhere.
   * The message itself is rendered by the caller as a `.form-hint`.
   */
  invalid?: boolean;
  /** Extra class appended to the underlying field element. */
  className?: string;
}

/** The opening token that triggers autocomplete. */
const OPEN_TOKEN = "${";

interface OpenToken {
  open: boolean;
  /** Partial name typed after `${` (valid name-prefix chars, possibly empty). */
  query: string;
  /** Index in `text` where the `${` opens (position of `$`). */
  start: number;
}

/**
 * Detect an unclosed `${name` token immediately before the cursor.
 *
 * Returns `{ open: true, query, start }` when the text before `cursorPos`
 * ends with `${` optionally followed by a valid in-progress name prefix and
 * NO closing `}` in between. A prefix starting with a digit is rejected (the
 * grammar requires a name to begin with a letter or underscore).
 */
function detectOpenToken(text: string, cursorPos: number): OpenToken {
  const before = text.slice(0, cursorPos);
  const start = before.lastIndexOf(OPEN_TOKEN);
  if (start === -1) return { open: false, query: "", start: -1 };
  const partial = before.slice(start + OPEN_TOKEN.length);
  // A `}` between `${` and the cursor means the token already closed.
  if (partial.includes("}")) return { open: false, query: "", start: -1 };
  // Empty partial (just `${`) is a valid open token. A non-empty partial must
  // be a valid in-progress identifier prefix.
  if (partial.length > 0 && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(partial)) {
    return { open: false, query: "", start: -1 };
  }
  return { open: true, query: partial, start };
}

export function ArtifactRefInput({
  value,
  onChange,
  artifactNames,
  multiline = false,
  shellSyntax = false,
  placeholder,
  rows,
  ariaLabel,
  invalid = false,
  className,
}: ArtifactRefInputProps): ReactElement {
  const { t } = useTranslation();
  const { show: showContextMenu } = useContextMenu();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const overlayRef = useRef<HTMLPreElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Most recent cursor position. Tracked in state (not a ref) because dropdown
  // visibility for the `${` autocomplete depends on it and must re-render.
  const [cursor, setCursor] = useState<number>(value.length);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  // Explicit dismissal of the `${` autocomplete (Escape / outside pointer).
  // Reset whenever the token or its query changes, so the next keystroke
  // re-opens the list.
  const [dismissed, setDismissed] = useState<boolean>(false);

  const getField = useCallback(():
    | HTMLInputElement
    | HTMLTextAreaElement
    | null => {
    return multiline ? textareaRef.current : inputRef.current;
  }, [multiline]);

  const token = detectOpenToken(value, cursor);
  const dropdownOpen = token.open && !dismissed;

  // Segment the value into plain runs + `${var}` references for the highlight
  // overlay. Reuses the command-form tokenizer (single source of truth for the
  // `${name}` / `${name:default}` / `$$` grammar).
  const knownNames = useMemo(
    () => new Set(artifactNames.filter((n) => n.length > 0)),
    [artifactNames],
  );

  // Shell-syntax fields (real scripts, not labels/artifact values) ALSO get
  // leading-utility + flag-token highlighting, mirroring the command form's
  // `ScriptEditor` — same helpers, same CSS classes. Disabled for non-script
  // fields: every command in the chain, with its resolved status.
  const utilityRanges = useMemo<UtilityNameRange[]>(
    () => (shellSyntax ? parseUtilityNamesWithRanges(value) : []),
    [shellSyntax, value],
  );
  const utilityNames = useMemo<string[]>(
    () => utilityRanges.map((r) => r.name),
    [utilityRanges],
  );
  const helpByUtility = useUtilitiesHelp(utilityNames);
  const utilityHighlights = useMemo<UtilityHighlight[]>(() => {
    return utilityRanges.map((range) => {
      const help = helpByUtility.get(range.name) ?? null;
      const status: UtilityHighlightStatus =
        help === null
          ? "pending"
          : help.status === "found"
            ? "found"
            : "not-found";
      return { name: range.name, start: range.start, end: range.end, status };
    });
  }, [utilityRanges, helpByUtility]);

  const flagsByUtility = useFlagsByUtility(utilityRanges, helpByUtility);
  const flagsMap = useMemo<ReadonlyMap<string, ReadonlyArray<ParsedFlag>>>(() => {
    const map = new Map<string, ReadonlyArray<ParsedFlag>>();
    for (const [name, cli] of flagsByUtility) map.set(name, cli.flags);
    return map;
  }, [flagsByUtility]);
  const flagHighlights = useMemo<ReadonlyArray<FlagHighlight>>(
    () =>
      shellSyntax ? buildFlagHighlights(value, utilityRanges, flagsMap) : [],
    [shellSyntax, value, utilityRanges, flagsMap],
  );

  const segments = useMemo(
    () =>
      tokenizeScript(
        value,
        knownNames,
        shellSyntax ? utilityHighlights : null,
        shellSyntax ? flagHighlights : undefined,
      ),
    [value, knownNames, shellSyntax, utilityHighlights, flagHighlights],
  );

  // Autocomplete filters the artifact names by the partial prefix typed after
  // the open `${` token.
  const list = useMemo((): string[] => {
    const all = artifactNames.filter((n) => n.length > 0);
    if (!dropdownOpen) return [];
    const q = token.query.toLowerCase();
    return all.filter((name) => name.toLowerCase().startsWith(q));
  }, [artifactNames, dropdownOpen, token.query]);

  // Reset keyboard navigation whenever the option set changes.
  useEffect(() => {
    setActiveIndex(-1);
  }, [list]);

  // A newly opened/changed `${` token clears a prior dismissal so the next
  // keystroke re-opens the list.
  useEffect(() => {
    setDismissed(false);
  }, [token.open, token.start, token.query]);

  // Close on outside pointer-down or Escape while the dropdown is open.
  useEffect(() => {
    if (!dropdownOpen) return;
    const onPointerDown = (event: MouseEvent): void => {
      const node = wrapRef.current;
      if (node !== null && event.target instanceof Node && !node.contains(event.target)) {
        setDismissed(true);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setDismissed(true);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [dropdownOpen]);

  /** Read the field's current selection into `cursor` state. */
  const syncCursor = useCallback((): void => {
    const el = getField();
    if (el !== null) setCursor(el.selectionStart ?? value.length);
  }, [getField, value.length]);

  /** Keep the highlight overlay scrolled in lock-step with the field. */
  const handleScroll = useCallback(
    (e: SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
      const overlay = overlayRef.current;
      if (overlay === null) return;
      overlay.scrollTop = e.currentTarget.scrollTop;
      overlay.scrollLeft = e.currentTarget.scrollLeft;
    },
    [],
  );

  const restoreCursor = useCallback((pos: number): void => {
    requestAnimationFrame(() => {
      const el = getField();
      if (el !== null) {
        el.setSelectionRange(pos, pos);
        el.focus();
      }
    });
  }, [getField]);

  /** Apply a chosen artifact name: complete an open `${` token if present,
   *  otherwise insert `${name}` at the cursor. */
  const applyName = useCallback(
    (name: string): void => {
      const inserted = `${OPEN_TOKEN}${name}}`;
      if (token.open) {
        const before = value.slice(0, token.start);
        const after = value.slice(cursor);
        const next = before + inserted + after;
        const pos = before.length + inserted.length;
        onChange(next);
        setCursor(pos);
        setDismissed(false);
        restoreCursor(pos);
        return;
      }
      const el = getField();
      const start = el?.selectionStart ?? cursor;
      const end = el?.selectionEnd ?? cursor;
      const next = value.slice(0, start) + inserted + value.slice(end);
      const pos = start + inserted.length;
      onChange(next);
      setCursor(pos);
      setDismissed(false);
      restoreCursor(pos);
    },
    [token, value, cursor, onChange, restoreCursor, getField],
  );

  // Native context menu: an "Insert artifact" submenu of every artifact name,
  // plus standard cut/copy/paste/select-all. Attached in the capture phase and
  // `stopImmediatePropagation`d so it bypasses the global context-menu guard
  // (same pattern as the command Script editor and the workflow text node).
  useEffect(() => {
    // Widen to HTMLElement so `addEventListener` resolves to a single overload
    // (the input/textarea union otherwise rejects the MouseEvent handler type).
    const el: HTMLElement | null = getField();
    if (el === null) return;
    const handler = (e: MouseEvent): void => {
      e.stopImmediatePropagation();
      e.preventDefault();
      const selection = window.getSelection()?.toString() ?? "";
      const hasSelection = selection.length > 0;
      const names = artifactNames.filter((n) => n.length > 0);

      const items: ContextMenuEntry[] = [];

      if (names.length > 0) {
        items.push({
          id: "insert-artifact",
          label: t("miniapps.editor.insertArtifact"),
          submenu: names.map((name) => ({
            id: `insert-artifact-${name}`,
            label: `${OPEN_TOKEN}${name}}`,
            onSelect: () => applyName(name),
          })),
        });
      } else {
        items.push({
          id: "insert-artifact",
          label: t("miniapps.editor.noArtifacts"),
          disabled: true,
        });
      }
      items.push({ id: "div-artifact", divider: true });
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
                if (typeof text !== "string") return;
                const target = getField();
                if (target === null) return;
                const start = target.selectionStart ?? value.length;
                const end = target.selectionEnd ?? start;
                const next = value.slice(0, start) + text + value.slice(end);
                const pos = start + text.length;
                onChange(next);
                setCursor(pos);
                restoreCursor(pos);
              })
              .catch(() => {});
          },
        },
        { id: "div-edit", divider: true },
        {
          id: "select-all",
          label: t("contextMenu.selectAll"),
          onSelect: () => getField()?.select(),
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
  }, [
    artifactNames,
    t,
    applyName,
    showContextMenu,
    getField,
    value,
    onChange,
    restoreCursor,
  ]);

  const handleKeyDown = (
    e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ): void => {
    if (!dropdownOpen || list.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i < list.length - 1 ? i + 1 : 0));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i > 0 ? i - 1 : list.length - 1));
      return;
    }
    if (e.key === "Enter") {
      const chosen = list[activeIndex];
      if (chosen !== undefined) {
        e.preventDefault();
        applyName(chosen);
        return;
      }
    }
    if (e.key === "Escape") {
      setDismissed(true);
    }
  };

  const fieldClass = `input artifact-ref-input__field artifact-ref-input__field--overlay${
    invalid ? " input--error" : ""
  }${className ? ` ${className}` : ""}`;

  // Shared highlight overlay: paints the `${var}` references behind the
  // transparent field. Single-line and multiline share the segments; the CSS
  // differs only in wrapping (`pre` vs `pre-wrap`) via the variant class.
  const overlay = (
    <pre
      ref={overlayRef}
      className={`artifact-ref-input__overlay artifact-ref-input__overlay--${
        multiline ? "multiline" : "single"
      }`}
      aria-hidden="true"
    >
      {segments.map((seg, i) => {
        if (seg.kind === "known" || seg.kind === "unknown") {
          return (
            <span
              key={i}
              className={`artifact-ref-input__var artifact-ref-input__var--${seg.kind}`}
            >
              {seg.text}
            </span>
          );
        }
        if (seg.kind === "utility") {
          const status = seg.utilityStatus ?? "pending";
          const statusClass =
            status === "found"
              ? "command-form__script-editor-utility--found"
              : status === "not-found"
                ? "command-form__script-editor-utility--missing"
                : "command-form__script-editor-utility--pending";
          return (
            <span
              key={i}
              className={`command-form__script-editor-utility ${statusClass}`}
            >
              {seg.text}
            </span>
          );
        }
        if (seg.kind === "flag") {
          const flagClass =
            seg.flagStatus === "not-found"
              ? "command-form__script-editor-flag command-form__script-editor-flag--not-found"
              : "command-form__script-editor-flag command-form__script-editor-flag--found";
          return (
            <span key={i} className={flagClass}>
              {seg.text}
            </span>
          );
        }
        return <span key={i}>{seg.text}</span>;
      })}
      {/* Trailing-newline guard so a multiline overlay's height matches the
          textarea's scrollHeight (a `<pre>` collapses a final blank line). */}
      {multiline && value.endsWith("\n") ? "\u200B" : ""}
    </pre>
  );

  return (
    <div className="artifact-ref-input" ref={wrapRef}>
      <div
        className={`artifact-ref-input__editor artifact-ref-input__editor--${
          multiline ? "multiline" : "single"
        }`}
      >
        {overlay}
        {multiline ? (
          <textarea
            ref={textareaRef}
            className={fieldClass}
            rows={rows ?? 3}
            value={value}
            placeholder={placeholder}
            aria-label={ariaLabel}
            aria-invalid={invalid}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              onChange(e.target.value);
              syncCursor();
            }}
            onSelect={syncCursor}
            onClick={syncCursor}
            onKeyUp={syncCursor}
            onKeyDown={handleKeyDown}
            onScroll={handleScroll}
          />
        ) : (
          <input
            ref={inputRef}
            type="text"
            className={fieldClass}
            value={value}
            placeholder={placeholder}
            aria-label={ariaLabel}
            aria-invalid={invalid}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              onChange(e.target.value);
              syncCursor();
            }}
            onSelect={syncCursor}
            onClick={syncCursor}
            onKeyUp={syncCursor}
            onKeyDown={handleKeyDown}
            onScroll={handleScroll}
          />
        )}
      </div>
      {dropdownOpen ? (
        list.length === 0 ? (
          <div
            className="artifact-ref-input__dropdown artifact-ref-input__dropdown--empty"
            role="alert"
          >
            {t("miniapps.editor.noArtifacts")}
          </div>
        ) : (
          <ul
            className="artifact-ref-input__dropdown"
            role="listbox"
            aria-label={t("miniapps.editor.insertArtifact")}
          >
            {list.map((name, idx) => (
              <li
                key={name}
                className={
                  "artifact-ref-input__option" +
                  (idx === activeIndex ? " artifact-ref-input__option--active" : "")
                }
                role="option"
                aria-selected={idx === activeIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyName(name);
                }}
                onMouseEnter={() => setActiveIndex(idx)}
              >
                {`${OPEN_TOKEN}${name}}`}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
