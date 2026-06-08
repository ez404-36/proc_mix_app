import { Message } from "@arco-design/web-react";
import { create } from "zustand";
import type { Command } from "../types";
import type { Platform } from "../types/platform";
import {
  deleteCommandInDb,
  listCommandsFromDb,
  upsertCommandInDb,
} from "../utils/commandRepository";
import { buildSeedsForPlatform } from "./seeds";

/**
 * Public shape for `addCommand` input. We explicitly omit `nameKey` and
 * `descriptionKey` so external callers (UI forms, future import flows) cannot
 * accidentally inject i18n keys via user input. Those fields are reserved for
 * built-in seed entries authored inside this module.
 */
type NewCommandInput = Omit<
  Command,
  "id" | "createdAt" | "updatedAt" | "runCount" | "nameKey" | "descriptionKey"
>;

interface CommandState {
  commands: Command[];
  favorites: string[];
  /**
   * Tracks whether the platform-aware seed entries have been materialized.
   * The bootstrap hook fetches the host OS from Rust and then calls
   * `initializeSeeds` exactly once at app startup.
   */
  seedsInitialized: boolean;
  /**
   * Whether the store has finished its initial load from SQLite. The UI
   * can show a brief placeholder until this flips to `true`; after that
   * point `commands` reflects the persisted state.
   */
  hydrated: boolean;
  /**
   * Load every command from the Rust-backed SQLite store and replace the
   * in-memory state. Idempotent: calling twice yields the same result.
   */
  hydrateFromDb: () => Promise<void>;
  /**
   * Populate `commands` with the per-platform seed entries AND persist
   * each one to SQLite via the same IPC path used for user-created
   * commands. Idempotent: a second call (or a call made after the user
   * has already added their own commands) is a no-op.
   */
  initializeSeeds: (platform: Platform) => void;
  /**
   * Persist a new command and return its concrete materialised form
   * (with generated id + timestamps). Returning the value lets the
   * `commandActions` history wrapper record a `commandCreated` event
   * carrying the exact snapshot that landed in the store.
   */
  addCommand: (c: NewCommandInput) => Command;
  /**
   * Apply a patch to the command identified by `id`. Returns
   * `{ before, after }` for the history wrapper, or `null` when the
   * id was not found (the wrapper skips history in that case).
   */
  updateCommand: (
    id: string,
    patch: Partial<Command>,
  ) => { before: Command; after: Command } | null;
  /**
   * Remove the command and return the snapshot that was deleted (so
   * the history wrapper can persist it for restore). Returns `null`
   * when the id did not exist.
   */
  deleteCommand: (id: string) => Command | null;
  toggleFavorite: (id: string) => void;
  markCommandRun: (id: string) => void;
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
  return `cmd-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/**
 * Fire-and-forget persistence helper. The store updates state
 * optimistically, then writes through to SQLite in the background. On
 * failure we surface an Arco toast and log the error; the in-memory
 * state is left as-is so the user does not lose their edit (the next
 * mutation will retry the upsert).
 */
function persistUpsert(cmd: Command): void {
  void upsertCommandInDb(cmd).catch((err: unknown) => {
    console.error("failed to persist command", cmd.id, err);
    Message.error("Failed to save command");
  });
}

function persistDelete(id: string): void {
  void deleteCommandInDb(id).catch((err: unknown) => {
    console.error("failed to delete command", id, err);
    Message.error("Failed to delete command");
  });
}

export const useCommandStore = create<CommandState>()((set, get) => ({
  commands: [],
  favorites: [],
  seedsInitialized: false,
  hydrated: false,
  hydrateFromDb: async () => {
    try {
      const commands = await listCommandsFromDb();
      const favorites = commands.filter((c) => c.favorite).map((c) => c.id);
      // If there is already persisted data we consider seeds done; the
      // bootstrap hook only calls `initializeSeeds` when the table was
      // empty, but a second hydrate (e.g. after a refresh) should not
      // re-trigger seeding either.
      set({
        commands,
        favorites,
        hydrated: true,
        seedsInitialized: commands.length > 0,
      });
    } catch (err: unknown) {
      console.error("failed to hydrate commands from db", err);
      // Still flip `hydrated` so the seed bootstrap can fall back to
      // writing the demo entries; otherwise the UI would stay blank
      // forever if the first IPC call ever fails.
      set({ hydrated: true });
    }
  },
  initializeSeeds: (platform) => {
    const state = get();
    if (state.seedsInitialized) return;
    const commands = buildSeedsForPlatform(platform);
    const favorites = commands.filter((c) => c.favorite).map((c) => c.id);
    set({ commands, favorites, seedsInitialized: true });
    for (const c of commands) {
      persistUpsert(c);
    }
  },
  addCommand: (input) => {
    const ts = nowIso();
    const newCommand: Command = {
      ...input,
      id: makeId(),
      createdAt: ts,
      updatedAt: ts,
      runCount: 0,
    };
    set((state) => ({
      commands: [...state.commands, newCommand],
      favorites: newCommand.favorite
        ? [...state.favorites, newCommand.id]
        : state.favorites,
    }));
    persistUpsert(newCommand);
    return newCommand;
  },
  updateCommand: (id, patch) => {
    let before: Command | undefined;
    let after: Command | undefined;
    set((state) => ({
      commands: state.commands.map((c) => {
        if (c.id !== id) return c;
        before = c;
        const next: Command = { ...c, ...patch, updatedAt: nowIso() };
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
  deleteCommand: (id) => {
    let removed: Command | undefined;
    set((state) => {
      const target = state.commands.find((c) => c.id === id);
      if (target) {
        removed = target;
      }
      return {
        commands: state.commands.filter((c) => c.id !== id),
        favorites: state.favorites.filter((f) => f !== id),
      };
    });
    // Always issue the delete IPC — SQLite treats a missing id as a
    // no-op, and keeping the call unconditional preserves the old
    // store contract that callers (and tests) relied on. Only the
    // *return value* is conditional on whether the command was
    // present in-memory: the history wrapper needs the actual
    // snapshot to record `commandDeleted`, and there's nothing to
    // record when the id was unknown.
    persistDelete(id);
    return removed ?? null;
  },
  toggleFavorite: (id) => {
    let updated: Command | undefined;
    set((state) => {
      const isFavorite = state.favorites.includes(id);
      return {
        favorites: isFavorite
          ? state.favorites.filter((f) => f !== id)
          : [...state.favorites, id],
        commands: state.commands.map((c) => {
          if (c.id !== id) return c;
          const next: Command = {
            ...c,
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
  markCommandRun: (id) => {
    let updated: Command | undefined;
    set((state) => ({
      commands: state.commands.map((c) => {
        if (c.id !== id) return c;
        const next: Command = {
          ...c,
          runCount: c.runCount + 1,
          lastRunAt: nowIso(),
        };
        updated = next;
        return next;
      }),
    }));
    if (updated) persistUpsert(updated);
  },
}));
