import type { ReactNode } from "react";

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  shortcut?: string;
  /**
   * Action to invoke when the item is selected. Optional because
   * items that carry a `submenu` are used purely for grouping —
   * selecting them opens the submenu instead of executing.
   * Items WITHOUT a submenu MUST provide `onSelect`; the menu
   * runtime treats missing onSelect on a leaf as a no-op (but
   * TypeScript callers should always supply one).
   */
  onSelect?: () => void;
  /**
   * Nested entries. When present, the item renders as a parent
   * with a right-pointing chevron, opens its child menu on hover /
   * ArrowRight / click, and never invokes `onSelect`.
   */
  submenu?: ContextMenuEntry[];
}

export interface ContextMenuDivider {
  id: string;
  divider: true;
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuDivider;

export interface ContextMenuShowOptions {
  event: { clientX: number; clientY: number; preventDefault: () => void };
  items: ContextMenuEntry[];
}

export interface ContextMenuContextValue {
  show: (opts: ContextMenuShowOptions) => void;
  hide: () => void;
}

export function isDivider(entry: ContextMenuEntry): entry is ContextMenuDivider {
  return (entry as ContextMenuDivider).divider === true;
}
