import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { SoundConfigEditor } from "./SoundConfigEditor";
import type { EntitySoundConfig, SoundDescriptor } from "../../types";
import "../../i18n";

const sounds: SoundDescriptor[] = [
  { id: "builtin:success", label: "Success tone", kind: "builtin" },
  { id: "custom-1", label: "my-alarm.wav", kind: "custom" },
];

afterEach(() => {
  vi.clearAllMocks();
});

describe("SoundConfigEditor", () => {
  it("renders a toggle for each outcome, both off when value is undefined", () => {
    render(
      <SoundConfigEditor value={undefined} onChange={vi.fn()} sounds={sounds} />,
    );
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(2);
    for (const s of switches) {
      expect(s.getAttribute("aria-checked")).toBe("false");
    }
  });

  it("hides the sound picker until an outcome is enabled", () => {
    render(
      <SoundConfigEditor value={undefined} onChange={vi.fn()} sounds={sounds} />,
    );
    // No comboboxes/listbox triggers while both outcomes are off.
    expect(screen.queryByRole("button", { name: /sound for/i })).toBeNull();
  });

  it("enabling success emits a config with success.enabled=true", () => {
    const onChange = vi.fn();
    render(
      <SoundConfigEditor value={undefined} onChange={onChange} sounds={sounds} />,
    );
    const successToggle = screen.getByRole("switch", { name: /on success/i });
    fireEvent.click(successToggle);
    expect(onChange).toHaveBeenCalledWith({ success: { enabled: true } });
  });

  it("shows the picker for an enabled outcome and reflects the chosen sound", () => {
    const value: EntitySoundConfig = {
      error: { enabled: true, soundId: "custom-1" },
    };
    render(
      <SoundConfigEditor value={value} onChange={vi.fn()} sounds={sounds} />,
    );
    // The error picker trigger shows the chosen sound's label.
    expect(screen.getByText("my-alarm.wav")).not.toBeNull();
  });

  it("renders a Play button only when onPreview is provided and a sound resolves", () => {
    const value: EntitySoundConfig = {
      success: { enabled: true, soundId: "builtin:success" },
    };
    const onPreview = vi.fn();
    const { rerender } = render(
      <SoundConfigEditor value={value} onChange={vi.fn()} sounds={sounds} />,
    );
    // No onPreview -> no Play button.
    expect(screen.queryByRole("button", { name: /play/i })).toBeNull();

    rerender(
      <SoundConfigEditor
        value={value}
        onChange={vi.fn()}
        sounds={sounds}
        onPreview={onPreview}
      />,
    );
    const play = screen.getByRole("button", { name: /play/i });
    fireEvent.click(play);
    expect(onPreview).toHaveBeenCalledWith("builtin:success");
  });

  it("disables the controls when disabled", () => {
    const value: EntitySoundConfig = { success: { enabled: true } };
    render(
      <SoundConfigEditor
        value={value}
        onChange={vi.fn()}
        sounds={sounds}
        disabled
      />,
    );
    for (const s of screen.getAllByRole("switch")) {
      expect((s as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
