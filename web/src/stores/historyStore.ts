// History store (F7) — paginated, read-only run history.
//
// Backed by `GET /api/history` (B2), which returns only run events
// (`commandRun` / `workflowRun`) of currently-API-enabled entities, newest
// first. The web History view is VIEW-ONLY: no delete / restore / cancel — so
// this store exposes only fetch + paging. Paging is server-side (the on-disk
// row count is the constraint, not React state).

import { create } from "zustand";
import { ApiError, getHistory } from "../api/client";
import type { HistoryEventWire } from "../api/types";

export const HISTORY_PAGE_SIZE = 20;

interface HistoryState {
  items: HistoryEventWire[];
  total: number;
  page: number;
  loading: boolean;
  /** User-facing error code when the last load failed, else null. */
  error: string | null;
  load: () => Promise<void>;
  setPage: (page: number) => Promise<void>;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  items: [],
  total: 0,
  page: 1,
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const result = await getHistory(get().page, HISTORY_PAGE_SIZE);
      set({
        items: result.items,
        total: result.total,
        page: result.page,
        loading: false,
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof ApiError ? err.code : "unknown",
      });
    }
  },

  setPage: async (page) => {
    if (page < 1) return;
    set({ page });
    await get().load();
  },
}));
