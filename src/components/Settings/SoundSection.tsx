import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { useSoundStore } from "../../stores/soundStore";
import { Dropdown } from "../Dropdown";
import type { DropdownOption } from "../Dropdown";
import { ToggleSwitch } from "../ToggleSwitch";
import { ConfirmDialog } from "../ConfirmDialog";
import { RunIcon, TrashIcon, PlusIcon } from "../icons";
import type { SoundId } from "../../types/sound";

/** Dropdown sentinel meaning "no default sound chosen" for a global slot. */
const NONE = "__none__";

/**
 * Settings → Sound: the GLOBAL sound-notification settings (master on/off,
 * default success/error sounds, volume) plus the custom-sound library manager
 * (upload / preview / delete). Per-command / per-workflow overrides live in
 * their own editors; this section owns the shared defaults + the sound library.
 */
export function SoundSection(): ReactElement {
  const { t } = useTranslation();

  const settings = useSoundStore((s) => s.settings);
  const sounds = useSoundStore((s) => s.sounds);
  const load = useSoundStore((s) => s.load);
  const updateSettings = useSoundStore((s) => s.updateSettings);
  const importSound = useSoundStore((s) => s.importSound);
  const deleteSound = useSoundStore((s) => s.deleteSound);
  const preview = useSoundStore((s) => s.preview);

  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    label: string;
  } | null>(null);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const noneLabel = t("sound.settings.noDefault", { defaultValue: "None" });
  const options: DropdownOption[] = useMemo(
    () => [
      { value: NONE, label: noneLabel },
      ...sounds.map((s) => ({ value: s.id, label: s.label })),
    ],
    [sounds, noneLabel],
  );

  const customSounds = useMemo(
    () => sounds.filter((s) => s.kind === "custom"),
    [sounds],
  );

  const setDefault = (
    slot: "successSoundId" | "errorSoundId",
    value: string,
  ): void => {
    const soundId: SoundId | undefined = value === NONE ? undefined : value;
    void updateSettings({ [slot]: soundId });
  };

  return (
    <section className="view-section sound-settings">
      {/* Master switch */}
      <div className="settings-group settings-group--center">
        <ToggleSwitch
          checked={settings.enabled}
          onChange={(enabled) => void updateSettings({ enabled })}
          ariaLabel={t("sound.settings.enable", {
            defaultValue: "Enable sound notifications",
          })}
        />
        <span className="settings-inline-label">
          {t("sound.settings.enable", {
            defaultValue: "Enable sound notifications",
          })}
        </span>
      </div>

      {/* Default success / error sounds */}
      <div className="form-field settings-group--spaced-top">
        <span className="form-field__label">
          {t("sound.settings.defaultSuccess", {
            defaultValue: "Default success sound",
          })}
        </span>
        <div className="sound-config-editor__controls">
          <Dropdown
            value={settings.successSoundId ?? NONE}
            options={options}
            ariaLabel={t("sound.settings.defaultSuccess", {
              defaultValue: "Default success sound",
            })}
            onChange={(v) => setDefault("successSoundId", v)}
          />
          {/* Always shown; disabled (and non-clickable) until a sound is
              chosen, so the control's affordance stays visible. */}
          <button
            type="button"
            className="btn btn--ghost sound-config-editor__preview"
            aria-label={t("sound.preview", { defaultValue: "Play" })}
            title={t("sound.preview", { defaultValue: "Play" })}
            disabled={!settings.successSoundId}
            onClick={() => {
              if (settings.successSoundId) void preview(settings.successSoundId);
            }}
          >
            <RunIcon />
          </button>
        </div>
      </div>

      <div className="form-field settings-group--spaced-top-sm">
        <span className="form-field__label">
          {t("sound.settings.defaultError", {
            defaultValue: "Default error sound",
          })}
        </span>
        <div className="sound-config-editor__controls">
          <Dropdown
            value={settings.errorSoundId ?? NONE}
            options={options}
            ariaLabel={t("sound.settings.defaultError", {
              defaultValue: "Default error sound",
            })}
            onChange={(v) => setDefault("errorSoundId", v)}
          />
          {/* Always shown; disabled until a sound is chosen. */}
          <button
            type="button"
            className="btn btn--ghost sound-config-editor__preview"
            aria-label={t("sound.preview", { defaultValue: "Play" })}
            title={t("sound.preview", { defaultValue: "Play" })}
            disabled={!settings.errorSoundId}
            onClick={() => {
              if (settings.errorSoundId) void preview(settings.errorSoundId);
            }}
          >
            <RunIcon />
          </button>
        </div>
      </div>

      {/* Volume */}
      <div className="form-field settings-group--spaced-top-sm">
        <label className="form-field__label" htmlFor="sound-volume">
          {t("sound.settings.volume", { defaultValue: "Volume" })}
        </label>
        <input
          id="sound-volume"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={settings.volume}
          onChange={(e) =>
            void updateSettings({ volume: Number(e.target.value) })
          }
        />
      </div>

      {/* Custom-sound library */}
      <div className="form-field settings-group--spaced-top">
        <span className="form-field__label">
          {t("sound.settings.customLibrary", {
            defaultValue: "Custom sounds",
          })}
        </span>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => void importSound()}
        >
          <PlusIcon />
          {t("sound.settings.upload", { defaultValue: "Upload sound…" })}
        </button>

        {customSounds.length > 0 ? (
          <ul className="sound-config-editor__custom-list">
            {customSounds.map((s) => (
              <li key={s.id} className="sound-config-editor__custom-item">
                <span className="sound-config-editor__custom-name">
                  {s.label}
                </span>
                <button
                  type="button"
                  className="btn btn--ghost sound-config-editor__preview"
                  aria-label={t("sound.preview", { defaultValue: "Play" })}
                  title={t("sound.preview", { defaultValue: "Play" })}
                  onClick={() => void preview(s.id)}
                >
                  <RunIcon />
                </button>
                <button
                  type="button"
                  className="btn btn--danger sound-config-editor__preview"
                  aria-label={t("common.delete", { defaultValue: "Delete" })}
                  title={t("common.delete", { defaultValue: "Delete" })}
                  onClick={() => setPendingDelete({ id: s.id, label: s.label })}
                >
                  <TrashIcon />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("sound.settings.deleteTitle", {
          defaultValue: "Delete sound",
        })}
        message={t("sound.settings.deleteMessage", {
          defaultValue:
            "Delete “{{name}}”? Any command or workflow using it will fall back to the global default.",
          name: pendingDelete?.label ?? "",
        })}
        danger
        onConfirm={() => {
          if (pendingDelete) void deleteSound(pendingDelete.id);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}
