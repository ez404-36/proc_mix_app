// Typed wrappers around the sound-notification Tauri commands.
//
// `invoke` is confined to this service layer (project convention): components
// and stores call these functions, never `invoke` directly. See
// `docs/sound-notifications.md`.

import { invoke } from "@tauri-apps/api/core";
import type { SoundDescriptor, SoundSettings } from "../types/sound";

/** Load the global sound settings (disabled by default). */
export async function getSoundSettings(): Promise<SoundSettings> {
  return invoke<SoundSettings>("get_sound_settings");
}

/** Persist the global sound settings. */
export async function setSoundSettings(settings: SoundSettings): Promise<void> {
  await invoke("set_sound_settings", { settings });
}

/** List every selectable sound: built-in tones followed by custom uploads. */
export async function listSounds(): Promise<SoundDescriptor[]> {
  return invoke<SoundDescriptor[]>("list_sounds");
}

/**
 * Open the OS file picker and import the chosen audio file as a custom sound.
 * Resolves to the new sound's descriptor, or `null` if the user cancelled.
 * Rejects if the file's extension is not in the allow-list.
 */
export async function importCustomSound(): Promise<SoundDescriptor | null> {
  return invoke<SoundDescriptor | null>("import_custom_sound");
}

/** Delete a custom sound by id (file + metadata + any referencing settings). */
export async function deleteCustomSound(id: string): Promise<void> {
  await invoke("delete_custom_sound", { id });
}

/** Play a sound by id at the current global volume (Settings/editor preview). */
export async function previewSound(id: string): Promise<void> {
  await invoke("preview_sound", { id });
}
