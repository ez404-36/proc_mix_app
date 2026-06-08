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
import type { UtilityHelp, VariableSpec } from "../../types";
import { useContextMenu } from "../ContextMenu";
import type { ContextMenuEntry } from "../ContextMenu";
import { tokenizeScript } from "./scriptHighlight";
import type { UtilityHighlight } from "./scriptHighlight";

/**
 * Editable script field with two features layered on top of a plain
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
  } = props;
  const { t } = useTranslation();
  const { show: showContextMenu } = useContextMenu();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const overlayRef = useRef<HTMLPreElement | null>(null);
  // Ref to the highlighted utility <span> in the overlay. The overlay
  // sits BEHIND the textarea (z-index 0 vs 1), so the span itself never
  // receives mouse events — the textarea on top intercepts them all.
  // We therefore hit-test the cursor against this span's rect from the
  // textarea's `mousemove` (see `handleTextareaMouseMove`).
  const utilitySpanRef = useRef<HTMLSpanElement | null>(null);

  // Set of declared names for O(1) lookup during tokenization.
  // Recomputed only when `variables` identity changes, which is
  // rare (only on add/remove/edit-name in the parent form).
  const knownNames = useMemo<ReadonlySet<string>>(() => {
    const set = new Set<string>();
    for (const v of variables) set.add(v.name);
    return set;
  }, [variables]);

  const segments = useMemo(
    () => tokenizeScript(value, knownNames, utilityHighlight ?? null),
    [value, knownNames, utilityHighlight],
  );

  // Hover-popover for the highlighted utility token. Anchored to the
  // hovered span's bounding rect (the overlay is laid out exactly like
  // the textarea, so the rect lines up with what the user sees). The
  // open/close timing mirrors the variables cheat-sheet tooltip.
  const [helpAnchor, setHelpAnchor] = useState<DOMRect | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const cancelHelpClose = useCallback((): void => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleHelpClose = useCallback((): void => {
    cancelHelpClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setHelpAnchor(null);
    }, 120);
  }, [cancelHelpClose]);

  /**
   * Hit-test the pointer against the highlighted utility token while the
   * cursor moves over the textarea. The textarea (z-index 1) sits ON TOP
   * of the highlight overlay (z-index 0), so the overlay span's own
   * `onMouseEnter` never fires — every mouse event lands on the textarea.
   * We reconstruct the hover here: if the pointer is within the utility
   * span's bounding rect, open the help popover anchored to that rect;
   * otherwise schedule it closed. The overlay is laid out identically to
   * the textarea, so the span's rect matches what the user sees.
   */
  const handleTextareaMouseMove = useCallback(
    (e: React.MouseEvent<HTMLTextAreaElement>): void => {
      const span = utilitySpanRef.current;
      if (!span) {
        // No utility token currently highlighted — nothing to hover.
        if (helpAnchor !== null) scheduleHelpClose();
        return;
      }
      const rect = span.getBoundingClientRect();
      const inside =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      if (inside) {
        cancelHelpClose();
        // Only update the anchor when it actually changes to avoid a
        // setState on every mousemove frame.
        setHelpAnchor((prev) =>
          prev &&
          prev.left === rect.left &&
          prev.top === rect.top &&
          prev.width === rect.width &&
          prev.height === rect.height
            ? prev
            : rect,
        );
      } else if (helpAnchor !== null) {
        scheduleHelpClose();
      }
    },
    [helpAnchor, cancelHelpClose, scheduleHelpClose],
  );

  // Cancel any pending close on unmount so the timer can't fire late.
  useEffect(() => cancelHelpClose, [cancelHelpClose]);

  // Close the popover if the utility token disappears or moves (e.g. the
  // user edits the command) so a stale popover can't linger over a token
  // that no longer exists.
  //
  // NOTE: we intentionally key this ONLY on the token's [start,end]
  // offsets — NOT on `utilityHelp.utility`. The help text resolves
  // asynchronously: when the user hovers a still-"pending" token, the
  // IPC result arrives a moment later and flips `utilityHelp` from null
  // to the resolved object. If that change reset the anchor, the popover
  // would close the instant the text became available — so the user
  // would hover, see nothing, and the tooltip would never appear. By
  // depending only on the offsets, the open anchor survives the
  // pending→resolved transition and the popover renders as soon as the
  // help text arrives.
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

  // Sync scroll position from the textarea to the overlay so the
  // highlights track the visible region. We use `onScroll` rather
  // than a layout-effect-driven mirror because scroll fires far more
  // often than React renders; a manual mirror keeps it cheap.
  const handleScroll = useCallback((e: SyntheticEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const overlay = overlayRef.current;
    if (!overlay) return;
    overlay.scrollTop = el.scrollTop;
    overlay.scrollLeft = el.scrollLeft;
  }, []);

  /**
   * Replace the current selection in the textarea with `text`,
   * leaving the caret positioned after the inserted text. Uses
   * `setRangeText` so the browser's native undo stack records the
   * change correctly (no manual restoration trickery needed).
   */
  const insertAtCursor = useCallback(
    (text: string): void => {
      const el = textareaRef.current;
      if (!el) return;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      el.focus();
      el.setRangeText(text, start, end, "end");
      // setRangeText doesn't fire `input`/`change`, so notify the
      // parent manually with the new value from the element.
      onChange(el.value);
    },
    [onChange],
  );

  /**
   * Show the custom context menu on right-click. Strategy:
   *
   *   - Listen in the bubble phase on the textarea itself (handled
   *     here via React's `onContextMenu`).
   *   - Use the capture-phase listener below to call
   *     `stopImmediatePropagation` on the original event so the
   *     ContextMenuProvider's global window-level capture handler
   *     never runs. That handler shows generic cut/copy/paste/
   *     selectAll and would otherwise pre-empt our menu.
   *   - Build a menu that combines the "Insert variable" group with
   *     the same cut/copy/paste/selectAll entries so the user
   *     doesn't lose existing functionality.
   */
  // Capture-phase listener attached imperatively so we can call
  // `stopImmediatePropagation` BEFORE the window-level capture
  // handler in ContextMenuProvider fires. React's onContextMenu
  // is bubble-phase only and can't pre-empt a window capture.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const handler = (e: MouseEvent): void => {
      // Stop the window-level capture handler in ContextMenuProvider
      // (registered at `window` with `{ capture: true }`) from
      // running — otherwise it would replace our menu with the
      // generic edit-actions list.
      e.stopImmediatePropagation();
      e.preventDefault();
      const selection = window.getSelection()?.toString() ?? "";
      const hasSelection = selection.length > 0;

      const items: ContextMenuEntry[] = [];

      // "Insert variable" parent: real nested submenu via the
      // ContextMenu's `submenu` field. When the user has no
      // variables declared, the parent is shown disabled so they
      // see the affordance and know to declare one below.
      // Submenu labels are built in JS (not via i18n placeholders)
      // so the literal `${name}` syntax doesn't collide with
      // i18next's own `{{...}}` interpolation markers.
      if (variables.length > 0) {
        items.push({
          id: "insert-variable",
          label: t("commandForm.scriptEditor.insertVariable", {
            defaultValue: "Insert variable",
          }),
          submenu: variables.map((spec) => ({
            id: `insert-variable-${spec.name}`,
            // Label is the bare variable name (e.g. `size`). The
            // submenu is already scoped to "Insert variable", so
            // the `${...}` syntax in the label would be redundant
            // noise — the user picks `size`, the editor inserts
            // `${size}` (see onSelect below).
            label: spec.name,
            onSelect: () => {
              insertAtCursor(`\${${spec.name}}`);
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

      // Standard edit actions — mirror the ContextMenuProvider's
      // generic set so the user keeps the cut/copy/paste/selectAll
      // functionality they have everywhere else.
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
            // Read clipboard async; insert at the current selection.
            // Using the Clipboard API rather than document.execCommand
            // because the textarea may have lost focus while the menu
            // was visible — execCommand would no-op.
            navigator.clipboard
              ?.readText()
              .then((text) => {
                if (typeof text === "string") {
                  insertAtCursor(text);
                }
              })
              .catch(() => {
                // Clipboard may be denied by the browser when not
                // in a user-gesture context; ignore silently.
              });
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
    // Re-attach when the variable list or t function changes so the
    // menu items reflect the current state. The handler itself is
    // re-created on every render; that's fine — attach/detach is
    // O(1) and rarely happens.
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
            // The leading-utility token: coloured by status and a hover
            // target for the help popover. `pointer-events: auto` is set
            // on this span's class so it receives mouse events even
            // though the overlay as a whole has them disabled.
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
        onMouseLeave={scheduleHelpClose}
        placeholder={placeholder}
        rows={rows}
        spellCheck={false}
        aria-invalid={ariaInvalid ? true : undefined}
        aria-describedby={ariaDescribedBy}
      />
      {helpAnchor && utilityHelp
        ? createPortal(
            <div
              role="tooltip"
              className="command-form__help-popover command-form__script-help-popover"
              style={utilityPopoverStyle(helpAnchor)}
              onMouseEnter={cancelHelpClose}
              onMouseLeave={scheduleHelpClose}
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
    </div>
  );
}

/** Assumed max popover height (px), used only for the flip decision. */
const UTILITY_POPOVER_MAX_H = 320;

/**
 * Position the utility help popover under the hovered token, flipping
 * above it when it would overflow the viewport bottom.
 */
function utilityPopoverStyle(anchor: DOMRect): React.CSSProperties {
  const GAP = 6;
  const viewportH = typeof window !== "undefined" ? window.innerHeight : 0;
  const fitsBelow = anchor.bottom + GAP + UTILITY_POPOVER_MAX_H <= viewportH;
  const top = fitsBelow
    ? anchor.bottom + GAP
    : Math.max(8, anchor.top - GAP - UTILITY_POPOVER_MAX_H);
  const left = Math.max(8, anchor.left);
  return { position: "fixed", top, left, maxHeight: UTILITY_POPOVER_MAX_H };
}

export type { HighlightSegment } from "./scriptHighlight";
