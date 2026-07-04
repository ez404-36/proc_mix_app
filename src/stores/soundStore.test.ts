import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSoundSettings = vi.fn();
const setSoundSettings = vi.fn();
const listSounds = vi.fn();
const importCustomSound = vi.fn();
const deleteCustomSound = vi.fn();
const previewSound = vi.fn();

vi.mock("../services/soundService", () => ({
  getSoundSettings: () => getSoundSettings(),
  setSoundSettings: (s: unknown) => setSoundSettings(s),
  listSounds: () => listSounds(),
  importCustomSound: () => importCustomSound(),
  deleteCustomSound: (id: string) => deleteCustomSound(id),
  previewSound: (id: string) => previewSound(id),
}));

import { useSoundStore } from "./soundStore";
import type { SoundDescriptor, SoundSettings } from "../types/sound";

const builtins: SoundDescriptor[] = [
  { id: "builtin:success", label: "success", kind: "builtin" },
  { id: "builtin:error", label: "error", kind: "builtin" },
];

beforeEach(() => {
  vi.clearAllMocks();
  useSoundStore.setState({
    settings: { enabled: false, volume: 0.8 },
    sounds: [],
    isLoading: false,
    error: null,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("soundStore", () => {
  it("starts disabled by default", () => {
    expect(useSoundStore.getState().settings.enabled).toBe(false);
  });

  it("load() fetches settings and sounds", async () => {
    const settings: SoundSettings = {
      enabled: true,
      successSoundId: "builtin:success",
      volume: 0.5,
    };
    getSoundSettings.mockResolvedValueOnce(settings);
    listSounds.mockResolvedValueOnce(builtins);

    await useSoundStore.getState().load();

    const s = useSoundStore.getState();
    expect(s.settings).toEqual(settings);
    expect(s.sounds).toEqual(builtins);
    expect(s.isLoading).toBe(false);
  });

  it("updateSettings() merges a patch and persists it", async () => {
    setSoundSettings.mockResolvedValueOnce(undefined);
    await useSoundStore.getState().updateSettings({ enabled: true });
    expect(useSoundStore.getState().settings.enabled).toBe(true);
    expect(setSoundSettings).toHaveBeenCalledWith({ enabled: true, volume: 0.8 });
  });

  it("updateSettings() rolls back on failure", async () => {
    setSoundSettings.mockRejectedValueOnce(new Error("boom"));
    await useSoundStore.getState().updateSettings({ enabled: true });
    const s = useSoundStore.getState();
    expect(s.settings.enabled).toBe(false); // rolled back
    expect(s.error).toContain("boom");
  });

  it("importSound() refreshes the list when a sound is added", async () => {
    const added: SoundDescriptor = { id: "c1", label: "a.wav", kind: "custom" };
    importCustomSound.mockResolvedValueOnce(added);
    listSounds.mockResolvedValueOnce([...builtins, added]);

    const result = await useSoundStore.getState().importSound();
    expect(result).toEqual(added);
    expect(useSoundStore.getState().sounds).toContainEqual(added);
  });

  it("importSound() returns null and does not refresh when cancelled", async () => {
    importCustomSound.mockResolvedValueOnce(null);
    const result = await useSoundStore.getState().importSound();
    expect(result).toBeNull();
    expect(listSounds).not.toHaveBeenCalled();
  });

  it("deleteSound() reloads settings and sounds", async () => {
    deleteCustomSound.mockResolvedValueOnce(undefined);
    getSoundSettings.mockResolvedValueOnce({ enabled: true, volume: 0.8 });
    listSounds.mockResolvedValueOnce(builtins);

    await useSoundStore.getState().deleteSound("c1");
    expect(deleteCustomSound).toHaveBeenCalledWith("c1");
    expect(useSoundStore.getState().sounds).toEqual(builtins);
  });

  it("preview() delegates to the service", async () => {
    previewSound.mockResolvedValueOnce(undefined);
    await useSoundStore.getState().preview("builtin:success");
    expect(previewSound).toHaveBeenCalledWith("builtin:success");
  });
});
