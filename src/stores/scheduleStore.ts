// Zustand store for the cron Scheduler (v0.2.0).
//
// Unlike the command / workflow stores, schedule mutations are AWAITED rather
// than fire-and-forget: the backend `upsert_schedule` can REJECT a write
// (e.g. `INVALID_CRON`), and the UI must see that rejection so it can show
// the right message and NOT leave a phantom schedule in the list. After a
// successful mutation we re-read the canonical list from SQLite so the cached
// `nextRunAt` / `runCount` the backend computes are reflected immediately.
//
// UI code must go through this store (never call the repository / `invoke`
// directly) so the in-memory list stays consistent with the database.

import { create } from "zustand";
import type { NewScheduleInput, Schedule } from "../types";
import {
  deleteScheduleInDb,
  listSchedulesFromDb,
  setScheduleEnabledInDb,
  upsertScheduleInDb,
} from "../utils/scheduleRepository";

interface ScheduleState {
  schedules: Schedule[];
  /** Whether the initial load from SQLite has completed. */
  hydrated: boolean;
  /** Load every schedule from SQLite and replace the in-memory list. */
  hydrateFromDb: () => Promise<void>;
  /**
   * Persist a NEW schedule. Resolves with the materialised schedule on
   * success; REJECTS with the backend error string (e.g. `INVALID_CRON`) so
   * the form can surface it. The in-memory list is refreshed from the DB on
   * success.
   */
  addSchedule: (input: NewScheduleInput) => Promise<Schedule>;
  /**
   * Persist a patch to an existing schedule. Resolves on success, rejects
   * with the backend error on failure. Refreshes the list from the DB.
   */
  updateSchedule: (
    id: string,
    patch: Partial<Schedule>,
  ) => Promise<Schedule>;
  /** Toggle a schedule's enabled flag. Awaited; refreshes the list. */
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Delete a schedule by id. Awaited; refreshes the list. */
  removeSchedule: (id: string) => Promise<void>;
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
  return `sch-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

export const useScheduleStore = create<ScheduleState>()((set, get) => ({
  schedules: [],
  hydrated: false,
  hydrateFromDb: async () => {
    try {
      const schedules = await listSchedulesFromDb();
      set({ schedules, hydrated: true });
    } catch (err: unknown) {
      console.error("failed to hydrate schedules from db", err);
      // Flip `hydrated` regardless so the UI does not stay blank forever.
      set({ hydrated: true });
    }
  },
  addSchedule: async (input) => {
    const ts = nowIso();
    const schedule: Schedule = {
      ...input,
      id: makeId(),
      createdAt: ts,
      updatedAt: ts,
      runCount: 0,
    };
    // Await the write so a quota / cron rejection propagates to the caller
    // BEFORE we add anything to the in-memory list (no phantom rows).
    await upsertScheduleInDb(schedule);
    await get().hydrateFromDb();
    return schedule;
  },
  updateSchedule: async (id, patch) => {
    const existing = get().schedules.find((s) => s.id === id);
    if (existing === undefined) {
      throw new Error(`schedule ${id} not found`);
    }
    const next: Schedule = { ...existing, ...patch, updatedAt: nowIso() };
    await upsertScheduleInDb(next);
    await get().hydrateFromDb();
    return next;
  },
  setEnabled: async (id, enabled) => {
    await setScheduleEnabledInDb(id, enabled);
    await get().hydrateFromDb();
  },
  removeSchedule: async (id) => {
    await deleteScheduleInDb(id);
    await get().hydrateFromDb();
  },
}));
