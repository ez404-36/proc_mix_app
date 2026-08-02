import { Message } from "@arco-design/web-react";
import { create } from "zustand";
import type { MiniApp, PanelSize } from "../types";
import type { Platform } from "../types/platform";
import {
  deleteMiniAppInDb,
  listMiniAppsFromDb,
  saveMiniAppInDb,
} from "../utils/miniappRepository";
import { buildMiniAppSeedsForPlatform } from "./miniappSeeds";

/**
 * Default main-panel size for a newly-created mini-app that omits `panelSize`
 * (the compact control-panel default). Mirrors the Rust `default_panel_size`
 * and `repository::DEFAULT_PANEL_SIZE` so every layer agrees.
 */
const DEFAULT_PANEL_SIZE: PanelSize = { w: 400, h: 320 };

/**
 * Public shape for `addMiniApp` input. The store materialises `id`,
 * timestamps, `runCount`, and `lastRunAt`, so callers only supply the
 * editable fields. `panelSize` is optional and defaults to the
 * compact-control-panel size when omitted (the editor always supplies one;
 * the import flow may carry an absent `panelSize` from a legacy export).
 * Exported so the seed builder can construct seed inputs without duplicating
 * the `Omit`.
 */
export type NewMiniAppInput = Omit<
  MiniApp,
  "id" | "createdAt" | "updatedAt" | "runCount" | "lastRunAt" | "panelSize"
> & { panelSize?: PanelSize };

interface MiniAppState {
  miniapps: MiniApp[];
  /**
   * Derived cache of the ids of every favourited mini-app, kept in sync on
   * add / toggle / delete / hydrate. Mirrors the `favorites` array in
   * `commandStore` so sidebar/tray code can render a favourites section
   * without re-scanning the full list on every render.
   */
  favorites: string[];
  /**
   * Whether the store has finished its initial load from SQLite. The UI
   * can show a brief placeholder until this flips to `true`; after that
   * point `miniapps` reflects the persisted state.
   */
  hydrated: boolean;
  /**
   * Tracks whether the platform-aware seed entries have been materialized.
   * The bootstrap hook fetches the host OS from Rust and then calls
   * `initializeSeeds` exactly once at app startup. Mirrors the
   * `seedsInitialized` flag in `commandStore`.
   */
  seedsInitialized: boolean;
  /**
   * Load every mini-app from the Rust-backed SQLite store and replace the
   * in-memory state. Idempotent: calling twice yields the same result.
   */
  hydrateFromDb: () => Promise<void>;
  /**
   * Populate `miniapps` with the per-platform seed entries AND persist
   * each one to SQLite via the same IPC path used for user-created
   * mini-apps. Idempotent: a second call (or a call made after the user
   * has already added their own mini-apps) is a no-op.
   */
  initializeSeeds: (platform: Platform) => void;
  /**
   * Persist a new mini-app and return its concrete materialised form
   * (with generated id + timestamps). Returning the value lets a future
   * history wrapper record a `miniappCreated` event carrying the exact
   * snapshot that landed in the store.
   */
  addMiniApp: (input: NewMiniAppInput) => MiniApp;
  /**
   * Apply a patch to the mini-app identified by `id`. Returns
   * `{ before, after }` for a future history wrapper, or `null` when the
   * id was not found (the wrapper skips history in that case).
   */
  updateMiniApp: (
    id: string,
    patch: Partial<MiniApp>,
  ) => { before: MiniApp; after: MiniApp } | null;
  /**
   * Remove the mini-app and return the snapshot that was deleted (so a
   * history wrapper can persist it for restore). Returns `null` when the
   * id did not exist.
   */
  deleteMiniApp: (id: string) => MiniApp | null;
  toggleFavorite: (id: string) => void;
  markMiniAppRun: (id: string) => void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `ma-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/**
 * Fire-and-forget persistence helper. The store updates state
 * optimistically, then writes through to SQLite in the background. On
 * failure we surface an Arco toast and log the error; the in-memory state
 * is left as-is so the user does not lose their edit (the next mutation
 * will retry the upsert).
 */
function persistUpsert(ma: MiniApp): void {
  void saveMiniAppInDb(ma).catch((err: unknown) => {
    console.error("failed to persist mini-app", ma.id, err);
    Message.error("Failed to save mini-app");
  });
}

function persistDelete(id: string): void {
  void deleteMiniAppInDb(id).catch((err: unknown) => {
    console.error("failed to delete mini-app", id, err);
    Message.error("Failed to delete mini-app");
  });
}

export const useMiniAppStore = create<MiniAppState>()((set, get) => ({
  miniapps: [],
  favorites: [],
  hydrated: false,
  seedsInitialized: false,
  hydrateFromDb: async () => {
    try {
      const miniapps = await listMiniAppsFromDb();
      const favorites = miniapps.filter((m) => m.favorite).map((m) => m.id);
      // If there is already persisted data we consider seeds done; a second
      // hydrate (e.g. after a refresh) must not re-trigger seeding.
      set({
        miniapps,
        favorites,
        hydrated: true,
        seedsInitialized: miniapps.length > 0,
      });
    } catch (err: unknown) {
      console.error("failed to hydrate mini-apps from db", err);
      // Still flip `hydrated` so the UI does not stay blank forever if the
      // first IPC call ever fails.
      set({ hydrated: true });
    }
  },
  initializeSeeds: (platform) => {
    if (get().seedsInitialized) return;
    const seeds = buildMiniAppSeedsForPlatform(platform);
    // Reuse `addMiniApp` so each seed gets a fresh id, timestamps, and the
    // same optimistic in-memory + fire-and-forget IPC persistence path used
    // for user-created mini-apps. Favorites are kept in sync by `addMiniApp`.
    for (const seed of seeds) {
      get().addMiniApp(seed);
    }
    set({ seedsInitialized: true });
  },
  addMiniApp: (input) => {
    const ts = nowIso();
    const newMiniApp: MiniApp = {
      ...input,
      id: makeId(),
      createdAt: ts,
      updatedAt: ts,
      runCount: 0,
      panelSize: input.panelSize ?? { ...DEFAULT_PANEL_SIZE },
    };
    set((state) => ({
      miniapps: [...state.miniapps, newMiniApp],
      favorites: newMiniApp.favorite
        ? [...state.favorites, newMiniApp.id]
        : state.favorites,
    }));
    persistUpsert(newMiniApp);
    return newMiniApp;
  },
  updateMiniApp: (id, patch) => {
    let before: MiniApp | undefined;
    let after: MiniApp | undefined;
    set((state) => ({
      miniapps: state.miniapps.map((m) => {
        if (m.id !== id) return m;
        before = m;
        const next: MiniApp = { ...m, ...patch, updatedAt: nowIso() };
        // Editing a SEED mini-app turns it into a regular user mini-app:
        // once the user supplies their own `name` / `description`, the seed
        // i18n keys must go, or `getMiniAppName` would keep rendering the
        // translated seed label and silently discard the user's text.
        // Mirrors `useCommandFormSave`'s handling of `Command.nameKey`.
        if (patch.name !== undefined && patch.nameKey === undefined) {
          delete next.nameKey;
        }
        if (
          patch.description !== undefined &&
          patch.descriptionKey === undefined
        ) {
          delete next.descriptionKey;
        }
        after = next;
        return next;
      }),
    }));
    if (before && after) {
      persistUpsert(after);
      return { before, after };
    }
    return null;
  },
  deleteMiniApp: (id) => {
    let removed: MiniApp | undefined;
    set((state) => {
      const target = state.miniapps.find((m) => m.id === id);
      if (target) {
        removed = target;
      }
      return {
        miniapps: state.miniapps.filter((m) => m.id !== id),
        favorites: state.favorites.filter((f) => f !== id),
      };
    });
    // Always issue the delete IPC — SQLite treats a missing id as a no-op.
    // Only the *return value* is conditional on whether the mini-app was
    // present in-memory: a history wrapper needs the actual snapshot, and
    // there's nothing to record when the id was unknown.
    persistDelete(id);
    return removed ?? null;
  },
  toggleFavorite: (id) => {
    let updated: MiniApp | undefined;
    set((state) => {
      const isFavorite = state.favorites.includes(id);
      return {
        favorites: isFavorite
          ? state.favorites.filter((f) => f !== id)
          : [...state.favorites, id],
        miniapps: state.miniapps.map((m) => {
          if (m.id !== id) return m;
          const next: MiniApp = {
            ...m,
            favorite: !isFavorite,
            updatedAt: nowIso(),
          };
          updated = next;
          return next;
        }),
      };
    });
    if (updated) persistUpsert(updated);
  },
  markMiniAppRun: (id) => {
    let updated: MiniApp | undefined;
    set((state) => ({
      miniapps: state.miniapps.map((m) => {
        if (m.id !== id) return m;
        const next: MiniApp = {
          ...m,
          runCount: m.runCount + 1,
          lastRunAt: nowIso(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) persistUpsert(updated);
  },
}));
