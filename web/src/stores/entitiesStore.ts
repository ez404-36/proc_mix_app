// Entities store — the API-visible commands + workflows.
//
// Loaded once (and refreshable) from `GET /api/commands` + `GET /api/workflows`,
// which return only API-enabled entities enriched with display metadata
// (favorite, lastRunAt, description). Home and Library both read from here, so
// the lists are fetched once and shared. Read-only: the web UI never mutates
// entities.

import { create } from "zustand";
import { ApiError, listCommands, listWorkflows } from "../api/client";
import type { ApiEntitySummary } from "../api/types";

interface EntitiesState {
  entities: ApiEntitySummary[];
  isLoading: boolean;
  /** A user-facing error code when the last load failed, else null. */
  error: string | null;
  loaded: boolean;
  load: () => Promise<void>;
}

export const useEntitiesStore = create<EntitiesState>((set) => ({
  entities: [],
  isLoading: false,
  error: null,
  loaded: false,
  load: async () => {
    set({ isLoading: true, error: null });
    try {
      const [commands, workflows] = await Promise.all([
        listCommands(),
        listWorkflows(),
      ]);
      set({
        entities: [...commands, ...workflows],
        isLoading: false,
        loaded: true,
      });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "unknown";
      set({ isLoading: false, error: code, loaded: true });
    }
  },
}));
