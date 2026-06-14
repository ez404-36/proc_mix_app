import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ChangeEvent,
  ReactElement,
  SyntheticEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ParsedFlag, UtilityHelp, VariableSpec } from "../../types";
import { useContextMenu } from "../ContextMenu";
import type { ContextMenuEntry } from "../ContextMenu";
import { buildFlagHighlights, tokenizeScript } from "./scriptHighlight";
import type { FlagHighlight, UtilityHighlight } from "./scriptHighlight";

/**
 * Editable script field with three features layered on top of a plain
 * `<textarea>`:
 *
 *   1. Inline syntax highlighting for `${name}` / `${name:default}`
 *      references. The highlighting works regardless of how the
 *      reference got into the script — user typing, paste, or the
 *      "Insert variable" context menu (see below). Both known
 *      variables (declared in the Variables section) and unknown
 *      ones are highlighted; unknowns get a distinct class so the
 *      user can spot typos. `$$` escapes are NOT highlighted (they
 *      resolve to a literal `$`).
 *
 *   2. Right-click context menu with an "Insert variable" group
 *      listing every variable currently declared on the command.
 *      The menu also offers a quick "New variable…" entry that
 *      inserts a `${todo}` placeholder; the user must declare it
 *      in the Variables section before saving.
 *
 *   3. Flag token highlighting: when `parsedFlags` is provided,
 *      flag tokens in the script are underlined and show a description
 *      popover on hover — exactly the same mechanism as the utility
 *      token hover.
 *
 * Implementation notes (the standard "overlay highlight" pattern):
 *
 *   - A `<pre>` overlay sits behind the textarea with identical
 *     font, padding, line-height and word-wrap settings. The pre
 *     renders the script text with `${...}` spans wrapped in
 *     highlight classes.
 *   - The textarea sits on top with `color: transparent` and
 *     `caret-color: var(--color-text)` so the user sees the
 *     overlay-rendered text under their caret. (background is
 *     transparent so the overlay shows through.)
 *   - Scroll is synced: `onScroll` mirrors `scrollTop`/`scrollLeft`
 *     to the overlay. This is the only sync needed because both
 *     elements have identical content metrics.
 *   - For the overlay to align character-for-character with the
 *     textarea, both MUST use the same font stack, font-size,
 *     line-height, padding, and `white-space: pre-wrap`. Any
 *     drift will cause visible mis-alignment — keep the CSS in
 *     sync (see `.command-form__script-editor*` rules in theme.css).
 *
 * Why not contenteditable? It seemed attractive but has too many
 * pitfalls: caret position is fragile, undo/redo is browser-defined
 * and inconsistent, IME composition (e.g. CJK) breaks span boundaries.
 * The overlay pattern keeps the textarea's native behaviour intact
 * (selection, undo, IME, accessibility, native context-menu for
 * spellcheck if enabled) and only paints highlights underneath.
 */
export interface ScriptEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** Variables declared on the command. Drives the "Insert variable"
   *  context-menu list AND the highlight class — known names get a
   *  different colour than unknowns. */
  variables: ReadonlyArray<VariableSpec>;
  placeholder?: string;
  rows?: number;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
  /** Optional ref hook for parent focus management. */
  textareaRef?: (el: HTMLTextAreaElement | null) => void;
  /**
   * The leading utility token to highlight in the overlay, with its
   * resolved status. `null` when there is no recognised utility or the
   * lookup is still pending with no token to mark. The token is coloured
   * (found / not-found) and becomes a hover target for {@link utilityHelp}.
   */
  utilityHighlight?: UtilityHighlight | null;
  /**
   * Resolved help for the highlighted utility, shown in a popover when
   * the user hovers the token. `null` while the lookup is pending — the
   * token still highlights (status "pending") but hovering shows nothing.
   */
  utilityHelp?: UtilityHelp | null;
  /**
   * Parsed flags for the current utility. When provided, flag tokens in the
   * script are highlighted with a subtle underline and show a description
   * popover on hover. `null`/`undefined` disables flag highlighting entirely.
   */
  parsedFlags?: ReadonlyArray<ParsedFlag> | null;
}

export function ScriptEditor(props: ScriptEditorProps): ReactElement {
  const {
    value,
    onChange,
    variables,
    placeholder,
    rows,
    ariaInvalid,
    ariaDescribedBy,
    textareaRef: externalRef,
    utilityHighlight,
    utilityHelp,
    parsedFlags,
  } = props;
  const { t } = useTranslation();
  const { show: showContextMenu } = useContextMenu();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const overlayRef = useRef<HTMLPreElement | null>(null);
  // Ref to the highlighted utility <span> in the overlay.
  const utilitySpanRef = useRef<HTMLSpanElement | null>(null);
  // Refs to each flag <span> in the overlay, keyed by segment index.
  const flagSpanRefs = useRef<Map<number, HTMLSpanElement>>(new Map());

  const knownNames = useMemo<ReadonlySet<string>>(() => {
    const set = new Set<string>();
    for (const v of variables) set.add(v.name);
    return set;
  }, [variables]);

  // Compute flag highlight ranges whenever the script or flags change.
  const flagHighlights = useMemo<ReadonlyArray<FlagHighlight>>(
    () => buildFlagHighlights(value, parsedFlags ?? []),
    [value, parsedFlags],
  );

  const segments = useMemo(
    () => tokenizeScript(value, knownNames, utilityHighlight ?? null, flagHighlights),
    [value, knownNames, utilityHighlight, flagHighlights],
  );

  // Clear stale flag span refs when segments change (different count/layout).
  // We rebuild them fresh on each render via callback refs below.
  useEffect(() => {
    flagSpanRefs.current.clear();
  }, [segments]);

  // ---------------------------------------------------------------------------
  // Utility hover popover
  // ---------------------------------------------------------------------------

  const [helpAnchor, setHelpAnchor] = useState<DOMRect | null>(null);
  const utilityCloseTimerRef = useRef<number | null>(null);

  const cancelUtilityClose = useCallback((): void => {
    if (utilityCloseTimerRef.current !== null) {
      window.clearTimeout(utilityCloseTimerRef.current);
      utilityCloseTimerRef.current = null;
    }
  }, []);

  const scheduleUtilityClose = useCallback((): void => {
    cancelUtilityClose();
    utilityCloseTimerRef.current = window.setTimeout(() => {
      utilityCloseTimerRef.current = null;
      setHelpAnchor(null);
    }, 120);
  }, [cancelUtilityClose]);

  // ---------------------------------------------------------------------------
  // Flag hover popover
  // ---------------------------------------------------------------------------

  const [hoveredFlag, setHoveredFlag] = useState<{
    anchor: DOMRect;
    flag: ParsedFlag;
  } | null>(null);
  const flagCloseTimerRef = useRef<number | null>(null);

  const cancelFlagClose = useCallback((): void => {
    if (flagCloseTimerRef.current !== null) {
      window.clearTimeout(flagCloseTimerRef.current);
      flagCloseTimerRef.current = null;
    }
  }, []);

  const scheduleFlagClose = useCallback((): void => {
    cancelFlagClose();
    flagCloseTimerRef.current = window.setTimeout(() => {
      flagCloseTimerRef.current = null;
      setHoveredFlag(null);
    }, 120);
  }, [cancelFlagClose]);

  // ---------------------------------------------------------------------------
  // Mouse move: hit-test utility span AND all flag spans.
  // Only one popover is shown at a time — hovering one closes the other.
  // ---------------------------------------------------------------------------

  const handleTextareaMouseMove = useCallback(
    (e: React.MouseEvent<HTMLTextAreaElement>): void => {
      // --- Utility span hit-test ---
      const uSpan = utilitySpanRef.current;
      if (uSpan) {
        const rect = uSpan.getBoundingClientRect();
        const insideUtility =
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom;
        if (insideUtility) {
          cancelUtilityClose();
          scheduleFlagClose();
          setHelpAnchor((prev) =>
            prev &&
            prev.left === rect.left &&
            prev.top === rect.top &&
            prev.width === rect.width &&
            prev.height === rect.height
              ? prev
              : rect,
          );
          return;
        }
      }
      if (helpAnchor !== null) scheduleUtilityClose();

      // --- Flag spans hit-test ---
      let foundFlag = false;
      for (const [, span] of flagSpanRefs.current) {
        const rect = span.getBoundingClientRect();
        const inside =
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom;
        if (inside) {
          const segIdx = Number(span.dataset["segIdx"]);
          const seg = segments[segIdx];
          if (seg?.kind === "flag" && seg.parsedFlag !== undefined) {
            cancelFlagClose();
            scheduleUtilityClose();
            setHoveredFlag((prev) => {
              if (
                prev &&
                prev.anchor.left === rect.left &&
                prev.anchor.top === rect.top &&
                prev.anchor.width === rect.width &&
                prev.anchor.height === rect.height &&
                prev.flag === seg.parsedFlag
              ) {
                return prev;
              }
              return { anchor: rect, flag: seg.parsedFlag! };
            });
          }
          foundFlag = true;
          break;
        }
      }
      if (!foundFlag && hoveredFlag !== null) {
        scheduleFlagClose();
      }
    },
    [
      helpAnchor,
      hoveredFlag,
      segments,
      cancelUtilityClose,
      scheduleUtilityClose,
      cancelFlagClose,
      scheduleFlagClose,
    ],
  );

  const handleMouseLeave = useCallback((): void => {
    scheduleUtilityClose();
    scheduleFlagClose();
  }, [scheduleUtilityClose, scheduleFlagClose]);

  // Cancel timers on unmount.
  useEffect(() => {
    return () => {
      cancelUtilityClose();
      cancelFlagClose();
    };
  }, [cancelUtilityClose, cancelFlagClose]);

  // Close utility popover when utility token moves/disappears.
  useEffect(() => {
    setHelpAnchor(null);
  }, [utilityHighlight?.start, utilityHighlight?.end]);

  const handleRef = useCallback(
    (el: HTMLTextAreaElement | null): void => {
      textareaRef.current = el;
      if (externalRef) externalRef(el);
    },
    [externalRef],
  );

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>): void => {
      onChange(e.target.value);
    },
    [onChange],
  );

  const handleScroll = useCallback((e: SyntheticEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const overlay = overlayRef.current;
    if (!overlay) return;
    overlay.scrollTop = el.scrollTop;
    overlay.scrollLeft = el.scrollLeft;
  }, []);

  /**
   * Replace the current selection in the textarea with `text`,
   * leaving the caret positioned after the inserted text.
   */
  const insertAtCursor = useCallback(
    (text: string): void => {
      const el = textareaRef.current;
      if (!el) return;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      el.focus();
      el.setRangeText(text, start, end, "end");
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

      if (variables.length > 0) {
        items.push({
          id: "insert-variable",
          label: t("commandForm.scriptEditor.insertVariable", {
            defaultValue: "Insert variable",
          }),
          submenu: variables.map((spec) => ({
            id: `insert-variable-${spec.name}`,
            label: spec.name,
            onSelect: () => {
              const snippet =
                spec.defaultValue !== undefined
                  ? `\${${spec.name}:${spec.defaultValue}}`
                  : `\${${spec.name}}`;
              insertAtCursor(snippet);
            },
          })),
        });
      } else {
        items.push({
          id: "insert-variable",
          label: t("commandForm.scriptEditor.insertVariable", {
            defaultValue: "Insert variable",
          }),
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
                if (typeof text === "string") {
                  insertAtCursor(text);
                }
              })
              .catch(() => {});
          },
        },
        { id: "div-edit", divider: true },
        {
          id: "select-all",
          label: t("contextMenu.selectAll"),
          onSelect: () => {
            textareaRef.current?.select();
          },
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
  }, [variables, t, insertAtCursor, showContextMenu]);

  return (
    <div className="command-form__script-editor">
      <pre
        ref={overlayRef}
        className="command-form__script-editor-overlay"
        aria-hidden="true"
      >
        {segments.map((seg, i) => {
          if (seg.kind === "text" || seg.kind === "escape") {
            return <span key={i}>{seg.text}</span>;
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
                ref={utilitySpanRef}
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
              <span
                key={i}
                ref={(el) => {
                  if (el) {
                    el.dataset["segIdx"] = String(i);
                    flagSpanRefs.current.set(i, el);
                  } else {
                    flagSpanRefs.current.delete(i);
                  }
                }}
                className={flagClass}
              >
                {seg.text}
              </span>
            );
          }
          return (
            <span
              key={i}
              className={
                seg.kind === "known"
                  ? "command-form__script-editor-var command-form__script-editor-var--known"
                  : "command-form__script-editor-var command-form__script-editor-var--unknown"
              }
            >
              {seg.text}
            </span>
          );
        })}
        {/* Trailing newline guard: if the script ends with `\n`, the
            browser collapses the empty last line in `<pre>`. A zero-
            width space ensures the overlay's height matches the
            textarea's scrollHeight. */}
        {value.endsWith("\n") ? "\u200B" : ""}
      </pre>
      <textarea
        ref={handleRef}
        className="input command-form__script command-form__script-editor-input"
        value={value}
        onChange={handleChange}
        onScroll={handleScroll}
        onMouseMove={handleTextareaMouseMove}
        onMouseLeave={handleMouseLeave}
        placeholder={placeholder}
        rows={rows}
        spellCheck={false}
        aria-invalid={ariaInvalid ? true : undefined}
        aria-describedby={ariaDescribedBy}
      />
      {/* Utility help popover */}
      {helpAnchor && utilityHelp
        ? createPortal(
            <div
              role="tooltip"
              className="command-form__help-popover command-form__script-help-popover"
              style={tokenPopoverStyle(helpAnchor)}
              onMouseEnter={cancelUtilityClose}
              onMouseLeave={scheduleUtilityClose}
            >
              {utilityHelp.status === "not-found" ? (
                t("commandForm.scriptHelp.notFound", {
                  name: utilityHelp.utility,
                })
              ) : (
                <>
                  <pre className="command-form__script-help-body">
                    {utilityHelp.text ?? ""}
                  </pre>
                  {utilityHelp.truncated ? (
                    <p className="command-form__script-help-truncated">
                      {t("commandForm.scriptHelp.truncated")}
                    </p>
                  ) : null}
                </>
              )}
            </div>,
            document.body,
          )
        : null}
      {/* Flag description popover */}
      {hoveredFlag !== null && hoveredFlag.flag.description.length > 0
        ? createPortal(
            <div
              role="tooltip"
              className="command-form__help-popover command-form__script-help-popover command-form__script-flag-popover"
              style={tokenPopoverStyle(hoveredFlag.anchor)}
              onMouseEnter={cancelFlagClose}
              onMouseLeave={scheduleFlagClose}
            >
              <p className="command-form__script-flag-label">
                {hoveredFlag.flag.flags.join(", ")}
              </p>
              <p className="command-form__script-flag-desc">
                {hoveredFlag.flag.description}
              </p>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** Assumed max popover height (px), used only for the flip decision. */
const TOKEN_POPOVER_MAX_H = 320;

/**
 * Position a help popover under the hovered token, flipping above it when
 * it would overflow the viewport bottom.
 */
function tokenPopoverStyle(anchor: DOMRect): React.CSSProperties {
  const GAP = 6;
  const viewportH = typeof window !== "undefined" ? window.innerHeight : 0;
  const fitsBelow = anchor.bottom + GAP + TOKEN_POPOVER_MAX_H <= viewportH;
  const top = fitsBelow
    ? anchor.bottom + GAP
    : Math.max(8, anchor.top - GAP - TOKEN_POPOVER_MAX_H);
  const left = Math.max(8, anchor.left);
  return { position: "fixed", top, left, maxHeight: TOKEN_POPOVER_MAX_H };
}

export type { HighlightSegment } from "./scriptHighlight";
