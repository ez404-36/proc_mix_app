import type { ReactElement } from "react";
import type { Terminal } from "@xterm/xterm";
import type { CompletionPopupState } from "./completionController";

interface CompletionPopupProps {
  state: CompletionPopupState;
  /** The xterm instance whose cursor cell anchors the popup. */
  term: Terminal;
  /** The positioned container (`.terminal-view`) the popup floats over. */
  container: HTMLDivElement | null;
  onAccept: (candidateIndex: number) => void;
}

/** Popup geometry constants (px). The list shows at most 8 rows before it
 *  scrolls; width is a fixed readable band clamped to the container. */
const ITEM_HEIGHT = 22;
const LIST_PADDING = 8;
const MAX_VISIBLE_ITEMS = 8;
const POPUP_WIDTH = 280;
const CONTAINER_PAD_LEFT = 10;
const CONTAINER_PAD_TOP = 6;

/**
 * Floating candidate list for Tab completion (plan M3). Anchored under the
 * xterm cursor cell (flipped above when near the container's bottom edge).
 * Purely presentational: keyboard handling stays in the completion
 * controller (xterm keeps focus); the only interaction is a mouse click on
 * an item, which accepts that candidate.
 */
export function CompletionPopup({
  state,
  term,
  container,
  onAccept,
}: CompletionPopupProps): ReactElement | null {
  if (container === null) return null;

  const buffer = term.buffer.active;
  const style = container.ownerDocument.defaultView?.getComputedStyle(container);
  const padLeft = style ? Number.parseInt(style.paddingLeft, 10) : CONTAINER_PAD_LEFT;
  const padTop = style ? Number.parseInt(style.paddingTop, 10) : CONTAINER_PAD_TOP;
  const cellWidth = (container.clientWidth - padLeft * 2) / Math.max(term.cols, 1);
  const cellHeight = (container.clientHeight - padTop * 2) / Math.max(term.rows, 1);

  const listHeight = Math.min(state.candidates.length, MAX_VISIBLE_ITEMS) * ITEM_HEIGHT + LIST_PADDING;
  let top = padTop + (buffer.cursorY + 1) * cellHeight + 2;
  if (top + listHeight > container.clientHeight) {
    top = Math.max(padTop + buffer.cursorY * cellHeight - listHeight - 2, 4);
  }
  const left = Math.min(
    padLeft + buffer.cursorX * cellWidth,
    Math.max(container.clientWidth - POPUP_WIDTH - 4, 4),
  );

  return (
    <div
      className="terminal-completion"
      style={{ left, top, width: POPUP_WIDTH }}
      role="listbox"
    >
      {state.candidates.map((candidate, i) => {
        const isActive = i === state.index;
        const classes = [
          "terminal-completion__item",
          candidate.isDir ? "terminal-completion__item--dir" : "",
          isActive ? "is-active" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <button
            key={candidate.name}
            type="button"
            role="option"
            aria-selected={isActive}
            className={classes}
            title={candidate.name}
            // preventDefault keeps focus in the xterm textarea — the
            // controller's key handling must not lose the keystroke stream.
            onMouseDown={(e) => {
              e.preventDefault();
              onAccept(i);
            }}
          >
            <span className="terminal-completion__name">{candidate.name}</span>
            {candidate.isDir ? (
              <span className="terminal-completion__hint">dir</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
