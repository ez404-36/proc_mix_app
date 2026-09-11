// Zustand store for terminal layout presets ("макеты терминала").
//
// A thin client over `terminalLayoutsService` (SQLite-backed): the layouts
// LIST lives here in memory, the records themselves live in the DB, so this
// store is deliberately NOT `persist`-ed (unlike `useUIStore`'s UI prefs —
// there is nothing session-local to save). Errors propagate to the caller
// (the console header) which surfaces them as toasts.
//
// `activeLayoutId` tracks which saved layout the console currently matches
// (set on apply, cleared on delete); the header uses it together with
// `isDirtyFor` to offer "Update" when any saved parameter changed.

import { create } from "zustand";
import type {
  TerminalLayoutDto,
  TerminalLayoutState,
} from "../types/terminalLayout";
import { terminalLayoutStateEquals } from "../utils/terminalLayoutSnapshot";
import {
  deleteTerminalLayout,
  listTerminalLayouts,
  renameTerminalLayout,
  saveTerminalLayout,
} from "../services/terminalLayoutsService";

interface TerminalLayoutsState {
  layouts: TerminalLayoutDto[];
  /** The layout the console is currently matching (`null` = none/unsaved). */
  activeLayoutId: string | null;
  isLoading: boolean;

  /** Fetch the layout list from the DB (idempotent; keeps stale data on error). */
  load: () => Promise<void>;
  /** Create a new layout from the given display+snapshot state. */
  saveAs: (name: string, state: TerminalLayoutState) => Promise<TerminalLayoutDto>;
  /** Overwrite the layout `id` with the given display+snapshot state. */
  update: (id: string, state: TerminalLayoutState) => Promise<TerminalLayoutDto>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setActiveLayout: (id: string | null) => void;
  /** Whether the console's current state no longer matches the saved layout. */
  isDirtyFor: (id: string, state: TerminalLayoutState) => boolean;
}

export const useTerminalLayoutsStore = create<TerminalLayoutsState>()((set, get) => ({
  layouts: [],
  activeLayoutId: null,
  isLoading: false,

  load: async () => {
    if (get().isLoading) return;
    set({ isLoading: true });
    try {
      const layouts = await listTerminalLayouts();
      set({ layouts });
    } finally {
      set({ isLoading: false });
    }
  },

  saveAs: async (name, state) => {
    const saved = await saveTerminalLayout({ name, ...state });
    set((s) => ({
      layouts: [...s.layouts, saved].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      ),
      activeLayoutId: saved.id,
    }));
    return saved;
  },

  update: async (id, state) => {
    const saved = await saveTerminalLayout({ id, name: getLayoutName(get().layouts, id), ...state });
    set((s) => ({
      layouts: s.layouts
        .map((l) => (l.id === saved.id ? saved : l))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
      activeLayoutId: saved.id,
    }));
    return saved;
  },

  rename: async (id, name) => {
    const saved = await renameTerminalLayout(id, name);
    set((s) => ({
      layouts: s.layouts
        .map((l) => (l.id === saved.id ? saved : l))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    }));
  },

  remove: async (id) => {
    await deleteTerminalLayout(id);
    set((s) => ({
      layouts: s.layouts.filter((l) => l.id !== id),
      activeLayoutId: s.activeLayoutId === id ? null : s.activeLayoutId,
    }));
  },

  setActiveLayout: (id) => set({ activeLayoutId: id }),

  isDirtyFor: (id, state) => {
    const saved = get().layouts.find((l) => l.id === id);
    if (!saved) return false;
    return !terminalLayoutStateEquals(state, saved);
  },
}));

function getLayoutName(layouts: TerminalLayoutDto[], id: string): string {
  const found = layouts.find((l) => l.id === id);
  if (!found) throw new Error(`terminal layout ${id} not found`);
  return found.name;
}
