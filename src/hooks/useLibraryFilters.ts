import { useCallback, useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { LibraryTab } from "../types";

/** Persisted filter selection for one Library tab. */
export interface LibraryFilterState {
  query: string;
  activeTags: string[];
  category: string;
}

const EMPTY_FILTERS: LibraryFilterState = {
  query: "",
  activeTags: [],
  category: "",
};

function storageKey(tab: LibraryTab): string {
  return `procmix-library-filters:${tab}`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isLibraryFilterState(value: unknown): value is LibraryFilterState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.query === "string" &&
    isStringArray(candidate.activeTags) &&
    typeof candidate.category === "string"
  );
}

/**
 * Read the persisted filter state for `tab`. Any missing/corrupt/absent
 * localStorage entry (including `localStorage` being unavailable, e.g. in a
 * test environment or a privacy-restricted webview) falls back to the empty
 * filter set — persistence is a best-effort convenience, never a
 * requirement for the tab to render.
 */
function readStoredFilters(tab: LibraryTab): LibraryFilterState {
  if (typeof window === "undefined") return EMPTY_FILTERS;
  try {
    const raw = window.localStorage.getItem(storageKey(tab));
    if (raw === null) return EMPTY_FILTERS;
    const parsed: unknown = JSON.parse(raw);
    return isLibraryFilterState(parsed) ? parsed : EMPTY_FILTERS;
  } catch {
    return EMPTY_FILTERS;
  }
}

/**
 * Persist `state` for `tab`. Swallows write failures (quota exceeded,
 * disabled storage, private-browsing restrictions) — losing the ability to
 * remember a filter selection must never crash the tab or block the user
 * from continuing to filter in-memory.
 */
function writeStoredFilters(tab: LibraryTab, state: LibraryFilterState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(tab), JSON.stringify(state));
  } catch {
    // Best-effort persistence only — see doc comment above.
  }
}

export interface UseLibraryFiltersResult {
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  activeTags: string[];
  setActiveTags: Dispatch<SetStateAction<string[]>>;
  category: string;
  setCategory: Dispatch<SetStateAction<string>>;
}

/**
 * Per-tab search/tag/category filter state for a Library list, persisted to
 * `localStorage` under `procmix-library-filters:<tab>`.
 *
 * The Library renders exactly one of `CommandsTab` / `WorkflowsTab` /
 * `MiniAppsTab` at a time (a conditional render in `Library`, not a
 * display:none toggle) — switching tabs UNMOUNTS the previous tab's
 * component, so a plain `useState` loses its value. This hook re-hydrates
 * from `localStorage` on mount (keyed by `tab`, so each tab's filters are
 * independent) and writes back on every change, so returning to a tab
 * restores exactly the query/tags/category the user had selected.
 */
export function useLibraryFilters(tab: LibraryTab): UseLibraryFiltersResult {
  const [state, setState] = useState<LibraryFilterState>(() =>
    readStoredFilters(tab),
  );

  useEffect(() => {
    writeStoredFilters(tab, state);
  }, [tab, state]);

  const setQuery = useCallback<Dispatch<SetStateAction<string>>>((value) => {
    setState((prev) => ({
      ...prev,
      query: typeof value === "function" ? value(prev.query) : value,
    }));
  }, []);

  const setActiveTags = useCallback<Dispatch<SetStateAction<string[]>>>(
    (value) => {
      setState((prev) => ({
        ...prev,
        activeTags: typeof value === "function" ? value(prev.activeTags) : value,
      }));
    },
    [],
  );

  const setCategory = useCallback<Dispatch<SetStateAction<string>>>(
    (value) => {
      setState((prev) => ({
        ...prev,
        category: typeof value === "function" ? value(prev.category) : value,
      }));
    },
    [],
  );

  return {
    query: state.query,
    setQuery,
    activeTags: state.activeTags,
    setActiveTags,
    category: state.category,
    setCategory,
  };
}
