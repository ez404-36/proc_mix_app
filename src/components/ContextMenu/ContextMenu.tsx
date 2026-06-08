import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ContextMenuContext } from "./context";
import {
  isDivider,
  type ContextMenuContextValue,
  type ContextMenuEntry,
  type ContextMenuItem,
  type ContextMenuShowOptions,
} from "./types";

interface MenuState {
  items: ContextMenuEntry[];
  x: number;
  y: number;
}

const MENU_MARGIN = 8;

/**
 * True when `el` (or any ancestor up to the document root) carries the
 * `.selectable` helper class or is a known read-only selectable cell/path
 * in the Environment view. Used by the context-menu handler to show a
 * Copy-only menu on read-only text that the user has selected.
 */
function isSelectableReadOnly(el: HTMLElement | null): boolean {
  if (!el) return false;
  let node: HTMLElement | null = el;
  while (node && node !== document.body) {
    const cls = node.classList;
    if (
      cls.contains("selectable") ||
      cls.contains("env-snapshot-table__td") ||
      cls.contains("env-manager__sources-path")
    ) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

function isEditableElement(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLInputElement) {
    const editableTypes = new Set([
      "text",
      "search",
      "email",
      "password",
      "tel",
      "url",
      "number",
    ]);
    if (el.readOnly || el.disabled) return false;
    return editableTypes.has(el.type);
  }
  if (el instanceof HTMLTextAreaElement) {
    return !el.readOnly && !el.disabled;
  }
  if (el.isContentEditable) return true;
  return false;
}

function firstEnabledIndex(items: ContextMenuEntry[]): number {
  for (let i = 0; i < items.length; i += 1) {
    const entry = items[i];
    if (entry && !isDivider(entry) && !entry.disabled) return i;
  }
  return -1;
}

function nextEnabledIndex(
  items: ContextMenuEntry[],
  current: number,
  direction: 1 | -1,
): number {
  const len = items.length;
  if (len === 0) return -1;
  let idx = current;
  for (let step = 0; step < len; step += 1) {
    idx = (idx + direction + len) % len;
    const entry = items[idx];
    if (entry && !isDivider(entry) && !entry.disabled) return idx;
  }
  return current;
}

async function pasteIntoActiveElement(): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    const active = document.activeElement;
    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement
    ) {
      const start = active.selectionStart ?? active.value.length;
      const end = active.selectionEnd ?? active.value.length;
      const before = active.value.slice(0, start);
      const after = active.value.slice(end);
      const next = before + text + after;
      // Use the native setter so React's controlled inputs pick up the change
      // through the synthetic `input` event we dispatch below.
      const proto =
        active instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      const setter = descriptor?.set;
      if (setter) {
        setter.call(active, next);
      } else {
        active.value = next;
      }
      active.selectionStart = active.selectionEnd = start + text.length;
      active.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (
      active instanceof HTMLElement &&
      active.isContentEditable
    ) {
      // contenteditable: insert at current selection
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
        selection.collapseToEnd();
        active.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
  } catch (error) {
    console.warn("paste failed", error);
  }
}

interface ContextMenuViewProps {
  state: MenuState;
  activeIndex: number;
  onItemClick: (item: ContextMenuItem) => void;
  onItemHover: (index: number) => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
  /** Index of the currently-open child submenu (or -1 if none). */
  openSubmenuIndex: number;
  /** Called when the user hovers/clicks a parent item to open its
   *  submenu, or hovers a leaf to close any previously-open submenu. */
  onOpenSubmenu: (index: number) => void;
}

function ContextMenuView({
  state,
  activeIndex,
  onItemClick,
  onItemHover,
  menuRef,
  openSubmenuIndex,
  onOpenSubmenu,
}: ContextMenuViewProps): ReactElement {
  // Refs to every parent <div> so we can anchor a child submenu next
  // to it. Indexed by item position so the lookup is O(1).
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const submenuRef = useRef<HTMLDivElement | null>(null);
  /** Hover-aware activeIndex for the open submenu, kept local so the
   *  parent menu's keyboard nav is unaffected. */
  const [submenuActiveIndex, setSubmenuActiveIndex] = useState<number>(-1);
  // When a submenu opens (or its index changes), reset the inner
  // activeIndex to the first enabled entry so keyboard nav can begin
  // immediately without a no-op ArrowDown.
  useEffect(() => {
    if (openSubmenuIndex < 0) {
      setSubmenuActiveIndex(-1);
      return;
    }
    const parent = state.items[openSubmenuIndex];
    if (!parent || isDivider(parent) || !parent.submenu) {
      setSubmenuActiveIndex(-1);
      return;
    }
    setSubmenuActiveIndex(firstEnabledIndex(parent.submenu));
  }, [openSubmenuIndex, state.items]);

  // Compute submenu anchor + entries for rendering. Done unconditionally
  // so the markup below stays simple; if `openSubmenuIndex` is invalid
  // we just skip rendering the panel.
  const submenuParent =
    openSubmenuIndex >= 0 ? state.items[openSubmenuIndex] : undefined;
  const submenuEntries =
    submenuParent && !isDivider(submenuParent) && submenuParent.submenu
      ? submenuParent.submenu
      : null;
  const submenuAnchor =
    openSubmenuIndex >= 0 ? itemRefs.current[openSubmenuIndex] ?? null : null;
  const submenuPos = ((): { left: number; top: number } | null => {
    if (!submenuEntries || !submenuAnchor) return null;
    const rect = submenuAnchor.getBoundingClientRect();
    // Default: open to the right of the parent, top-aligned. If it
    // would overflow the viewport, flip to the left side.
    const vw = typeof window !== "undefined" ? window.innerWidth : 0;
    const SUBMENU_W_GUESS = 220;
    const fitsRight = rect.right + SUBMENU_W_GUESS + 4 <= vw - MENU_MARGIN;
    const left = fitsRight
      ? rect.right + 2
      : Math.max(MENU_MARGIN, rect.left - SUBMENU_W_GUESS - 2);
    return { left, top: rect.top };
  })();

  return (
    <>
      <div
        ref={menuRef}
        className="context-menu"
        role="menu"
        style={{ left: state.x, top: state.y }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {state.items.map((entry, idx) => {
          if (isDivider(entry)) {
            return <div key={entry.id} className="context-menu-divider" />;
          }
          const isActive = idx === activeIndex;
          const hasSubmenu =
            Array.isArray(entry.submenu) && entry.submenu.length > 0;
          const className =
            "context-menu-item" +
            (entry.disabled ? " disabled" : "") +
            (entry.danger ? " danger" : "") +
            (isActive ? " active" : "") +
            (hasSubmenu ? " has-submenu" : "");
          return (
            <div
              key={entry.id}
              ref={(el) => {
                itemRefs.current[idx] = el;
              }}
              className={className}
              role="menuitem"
              aria-haspopup={hasSubmenu ? "menu" : undefined}
              aria-expanded={
                hasSubmenu ? openSubmenuIndex === idx : undefined
              }
              aria-disabled={entry.disabled ? true : undefined}
              onMouseEnter={() => {
                if (entry.disabled) return;
                onItemHover(idx);
                // Hovering a parent opens its submenu; hovering a leaf
                // (or a different parent) closes the previously-open
                // submenu — matches native OS context-menu behaviour.
                if (hasSubmenu) {
                  onOpenSubmenu(idx);
                } else if (openSubmenuIndex !== -1) {
                  onOpenSubmenu(-1);
                }
              }}
              onClick={() => {
                if (entry.disabled) return;
                if (hasSubmenu) {
                  // Toggle: click again on the open parent closes it.
                  onOpenSubmenu(openSubmenuIndex === idx ? -1 : idx);
                  return;
                }
                onItemClick(entry);
              }}
            >
              <span className="context-menu-item__label">
                {entry.icon ? (
                  <span className="context-menu-item__icon" aria-hidden="true">
                    {entry.icon}
                  </span>
                ) : null}
                <span>{entry.label}</span>
              </span>
              {hasSubmenu ? (
                <span className="context-menu-chevron" aria-hidden="true">
                  ▸
                </span>
              ) : entry.shortcut ? (
                <span className="context-menu-shortcut">{entry.shortcut}</span>
              ) : null}
            </div>
          );
        })}
      </div>
      {/* Child submenu panel. Positioned absolutely next to the parent
          item; reuses the .context-menu classes for visual consistency.
          Keyboard navigation inside the submenu is handled by the
          provider via the same arrow-key listener (it inspects
          `openSubmenuIndex` to decide which list to navigate). */}
      {submenuEntries && submenuPos ? (
        <div
          ref={submenuRef}
          className="context-menu context-menu--submenu"
          role="menu"
          style={{ left: submenuPos.left, top: submenuPos.top }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {submenuEntries.map((entry, idx) => {
            if (isDivider(entry)) {
              return (
                <div key={entry.id} className="context-menu-divider" />
              );
            }
            const isActive = idx === submenuActiveIndex;
            const className =
              "context-menu-item" +
              (entry.disabled ? " disabled" : "") +
              (entry.danger ? " danger" : "") +
              (isActive ? " active" : "");
            return (
              <div
                key={entry.id}
                className={className}
                role="menuitem"
                aria-disabled={entry.disabled ? true : undefined}
                onMouseEnter={() => {
                  if (!entry.disabled) setSubmenuActiveIndex(idx);
                }}
                onClick={() => {
                  if (!entry.disabled) onItemClick(entry);
                }}
              >
                <span className="context-menu-item__label">
                  {entry.icon ? (
                    <span
                      className="context-menu-item__icon"
                      aria-hidden="true"
                    >
                      {entry.icon}
                    </span>
                  ) : null}
                  <span>{entry.label}</span>
                </span>
                {entry.shortcut ? (
                  <span className="context-menu-shortcut">
                    {entry.shortcut}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </>
  );
}

interface ContextMenuProviderProps {
  children: ReactNode;
}

export function ContextMenuProvider({
  children,
}: ContextMenuProviderProps): ReactElement {
  const { t } = useTranslation();
  const [state, setState] = useState<MenuState | null>(null);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  /** Index of the parent item whose submenu is currently shown,
   *  or -1 if none. Reset whenever the menu hides, opens fresh,
   *  or `activeIndex` moves to a leaf. */
  const [openSubmenuIndex, setOpenSubmenuIndex] = useState<number>(-1);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const hide = useCallback((): void => {
    setState(null);
    setActiveIndex(-1);
    setOpenSubmenuIndex(-1);
  }, []);

  const show = useCallback((opts: ContextMenuShowOptions): void => {
    opts.event.preventDefault();
    if (opts.items.length === 0) return;
    setState({
      items: opts.items,
      x: opts.event.clientX,
      y: opts.event.clientY,
    });
    setActiveIndex(firstEnabledIndex(opts.items));
    setOpenSubmenuIndex(-1);
  }, []);

  // Clamp menu within viewport once it has rendered and we know its size.
  useLayoutEffect(() => {
    if (!state || !menuRef.current) return;
    const menu = menuRef.current;
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nextX = state.x;
    let nextY = state.y;
    if (rect.right > vw - MENU_MARGIN) {
      nextX = Math.max(MENU_MARGIN, vw - rect.width - MENU_MARGIN);
    }
    if (rect.bottom > vh - MENU_MARGIN) {
      nextY = Math.max(MENU_MARGIN, vh - rect.height - MENU_MARGIN);
    }
    if (nextX !== state.x || nextY !== state.y) {
      setState({ ...state, x: nextX, y: nextY });
    }
  }, [state]);

  // Close on click outside, scroll, resize, and Esc; arrow keys cycle items.
  useEffect(() => {
    if (!state) return;

    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (menuRef.current && target && menuRef.current.contains(target)) {
        return;
      }
      // Submenus render in the same portal as the root menu but
      // OUTSIDE `menuRef` (they're siblings, not children). Match
      // any element carrying `role="menu"` to keep clicks on the
      // submenu from closing the whole stack. Cheap traversal —
      // submenus are at most one level deep right now.
      if (
        target instanceof Element &&
        target.closest('[role="menu"]') !== null
      ) {
        return;
      }
      hide();
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        hide();
        return;
      }
      if (event.key === "Tab") {
        hide();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((idx) => {
          const next = nextEnabledIndex(state.items, idx, 1);
          // Moving keyboard focus to a different (leaf) item closes
          // any submenu opened by the previous parent.
          const entry = state.items[next];
          if (
            !entry ||
            isDivider(entry) ||
            !Array.isArray(entry.submenu) ||
            entry.submenu.length === 0
          ) {
            setOpenSubmenuIndex(-1);
          }
          return next;
        });
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((idx) => {
          const next = nextEnabledIndex(state.items, idx, -1);
          const entry = state.items[next];
          if (
            !entry ||
            isDivider(entry) ||
            !Array.isArray(entry.submenu) ||
            entry.submenu.length === 0
          ) {
            setOpenSubmenuIndex(-1);
          }
          return next;
        });
        return;
      }
      if (event.key === "ArrowRight") {
        // ArrowRight opens the submenu of the focused parent. No-op
        // on leaves. Doesn't advance focus into the submenu — moves
        // into it on next ArrowDown via the submenu's own active
        // index (managed inside `ContextMenuView`).
        const entry = state.items[activeIndex];
        if (
          entry &&
          !isDivider(entry) &&
          Array.isArray(entry.submenu) &&
          entry.submenu.length > 0
        ) {
          event.preventDefault();
          setOpenSubmenuIndex(activeIndex);
        }
        return;
      }
      if (event.key === "ArrowLeft") {
        // ArrowLeft closes an open submenu (returns focus to the
        // parent's list). No-op when nothing is open.
        if (openSubmenuIndex !== -1) {
          event.preventDefault();
          setOpenSubmenuIndex(-1);
        }
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const entry = state.items[activeIndex];
        if (entry && !isDivider(entry) && !entry.disabled) {
          // If the focused item has a submenu, Enter opens it
          // (same as ArrowRight) rather than firing an action —
          // there's no action to fire on a grouping parent.
          if (
            Array.isArray(entry.submenu) &&
            entry.submenu.length > 0
          ) {
            setOpenSubmenuIndex(activeIndex);
            return;
          }
          hide();
          // Leaves SHOULD have onSelect (the type makes it optional
          // only to allow grouping parents to omit it); if a caller
          // forgot it, no-op rather than crash.
          if (entry.onSelect) entry.onSelect();
        }
      }
    };

    const handleScroll = (): void => hide();
    const handleResize = (): void => hide();

    window.addEventListener("mousedown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);
    window.addEventListener("blur", handleResize);

    return () => {
      window.removeEventListener("mousedown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("blur", handleResize);
    };
  }, [state, activeIndex, openSubmenuIndex, hide]);

  // Auto-handle right-click on editable elements (inputs, textareas,
  // contenteditable). Components don't need to wire their own onContextMenu
  // for this — the provider listens at the window level (capture phase) and
  // takes precedence for editable targets.
  //
  // Also handles right-click on read-only selectable text (table cells,
  // source paths in the Environment view, any `.selectable` element) —
  // shows a Copy-only menu when the user has selected text there.
  useEffect(() => {
    const handler = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;

      // Read-only selectable text: show Copy only when there is a selection.
      if (!isEditableElement(target) && isSelectableReadOnly(target)) {
        const selection = window.getSelection()?.toString() ?? "";
        if (selection.length === 0) return;
        event.preventDefault();
        show({
          event: {
            clientX: event.clientX,
            clientY: event.clientY,
            preventDefault: () => event.preventDefault(),
          },
          items: [
            {
              id: "copy",
              label: t("contextMenu.copy"),
              onSelect: () => {
                try {
                  document.execCommand("copy");
                } catch (err) {
                  console.warn("copy failed", err);
                }
              },
            },
          ],
        });
        return;
      }

      if (!isEditableElement(target)) return;
      event.preventDefault();
      const selection = window.getSelection()?.toString() ?? "";
      const hasSelection = selection.length > 0;
      const textTarget = target;
      show({
        event: {
          clientX: event.clientX,
          clientY: event.clientY,
          preventDefault: () => event.preventDefault(),
        },
        items: [
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
              void pasteIntoActiveElement();
            },
          },
          { id: "div1", divider: true },
          {
            id: "select-all",
            label: t("contextMenu.selectAll"),
            onSelect: () => {
              if (
                textTarget instanceof HTMLInputElement ||
                textTarget instanceof HTMLTextAreaElement
              ) {
                textTarget.select();
              } else {
                try {
                  document.execCommand("selectAll");
                } catch (error) {
                  console.warn("selectAll failed", error);
                }
              }
            },
          },
        ],
      });
    };
    window.addEventListener("contextmenu", handler, { capture: true });
    return () =>
      window.removeEventListener("contextmenu", handler, { capture: true });
  }, [t, show]);

  const value = useMemo<ContextMenuContextValue>(
    () => ({ show, hide }),
    [show, hide],
  );

  const handleItemClick = useCallback(
    (item: ContextMenuItem): void => {
      // Parents with a submenu are handled by `ContextMenuView` (it
      // toggles `openSubmenuIndex` directly) and never reach this
      // path. Leaves SHOULD have `onSelect`; if a caller mistakenly
      // omitted it on a leaf, do nothing rather than crash.
      hide();
      if (item.onSelect) item.onSelect();
    },
    [hide],
  );

  return (
    <ContextMenuContext.Provider value={value}>
      {children}
      {state
        ? createPortal(
            <ContextMenuView
              state={state}
              activeIndex={activeIndex}
              onItemClick={handleItemClick}
              onItemHover={setActiveIndex}
              menuRef={menuRef}
              openSubmenuIndex={openSubmenuIndex}
              onOpenSubmenu={setOpenSubmenuIndex}
            />,
            document.body,
          )
        : null}
    </ContextMenuContext.Provider>
  );
}
