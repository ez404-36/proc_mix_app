// Store for the sound-notification feature.
//
// Holds the global settings (backend-persisted, disabled by default) and the
// list of selectable sounds (built-ins + custom uploads). All IPC goes through
// `soundService` — this store never calls `invoke` directly. The settings live
// on the backend (SQLite) rather than in `uiStore`/localStorage because the
// backend needs them at run-completion time, including on the headless path.

import { create } from "zustand";
import {
  deleteCustomSound,
  getSoundSettings,
  importCustomSound,
  listSounds,
  previewSound,
  setSoundSettings,
} from "../services/soundService";
import type { SoundDescriptor, SoundSettings } from "../types/sound";

/** Client-side default until the real settings load (mirrors the backend
 * default: OFF, mid volume, no default sounds chosen). */
const DEFAULT_SETTINGS: SoundSettings = {
  enabled: false,
  volume: 0.8,
};

export interface SoundStoreState {
  settings: SoundSettings;
  /** Built-in tones + custom uploads, as returned by `list_sounds`. */
  sounds: SoundDescriptor[];
  isLoading: boolean;
  /** Set when the last load/save/import/delete surfaced an error. */
  error: string | null;

  /** Load the settings and the sound list. */
  load: () => Promise<void>;
  /** Persist a partial patch merged onto the current settings. */
  updateSettings: (patch: Partial<SoundSettings>) => Promise<void>;
  /** Open the OS picker and import a custom sound; refreshes the list. */
  importSound: () => Promise<SoundDescriptor | null>;
  /** Delete a custom sound; refreshes the list and settings. */
  deleteSound: (id: string) => Promise<void>;
  /** Preview (play) a sound by id. */
  preview: (id: string) => Promise<void>;
}

export const useSoundStore = create<SoundStoreState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  sounds: [],
  isLoading: false,
  error: null,

  load: async () => {
    set({ isLoading: true, error: null });
    try {
      const [settings, sounds] = await Promise.all([
        getSoundSettings(),
        listSounds(),
      ]);
      set({ settings, sounds, isLoading: false });
    } catch (err) {
      set({ error: String(err), isLoading: false });
    }
  },

  updateSettings: async (patch) => {
    const next = { ...get().settings, ...patch };
    // Optimistic: reflect immediately, then persist. Roll back on failure.
    const prev = get().settings;
    set({ settings: next, error: null });
    try {
      await setSoundSettings(next);
    } catch (err) {
      set({ settings: prev, error: String(err) });
    }
  },

  importSound: async () => {
    set({ error: null });
    try {
      const descriptor = await importCustomSound();
      if (descriptor) {
        // Refresh the full list so ordering matches the backend.
        set({ sounds: await listSounds() });
      }
      return descriptor;
    } catch (err) {
      set({ error: String(err) });
      return null;
    }
  },

  deleteSound: async (id) => {
    set({ error: null });
    try {
      await deleteCustomSound(id);
      // Reload settings too: deleting a referenced sound clears its slot.
      const [settings, sounds] = await Promise.all([
        getSoundSettings(),
        listSounds(),
      ]);
      set({ settings, sounds });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  preview: async (id) => {
    try {
      await previewSound(id);
    } catch (err) {
      set({ error: String(err) });
    }
  },
}));
