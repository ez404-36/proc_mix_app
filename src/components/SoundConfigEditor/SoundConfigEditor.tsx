// Per-entity sound-notification editor.
//
// A presentational, fully-controlled editor for a `Command`'s or `Workflow`'s
// optional {@link EntitySoundConfig}. It renders two independent outcome rows —
// Success and Error — each with an enable toggle, a sound picker (defaulting to
// "use global default"), and an optional Play/preview button.
//
// This component is deliberately backend-agnostic: the selectable `sounds`
// list and the `onPreview` handler are INJECTED by the parent. It performs no
// `invoke` calls and imports no store, so it renders and tests without the
// (currently deferred) audio backend. The parent owns persistence via
// `onChange`, which reports the next `EntitySoundConfig | undefined`
// (`undefined` = inherit the global sound settings for both outcomes).

import { useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { EntitySoundConfig, SoundDescriptor } from "../../types";
import { Dropdown } from "../Dropdown";
import { ToggleSwitch } from "../ToggleSwitch";
import { RunIcon } from "../icons/RunIcon";
import {
  buildSoundOptions,
  getOutcome,
  outcomeToDropdownValue,
  previewSoundId,
  setOutcomeEnabled,
  setOutcomeSound,
  type SoundOutcome,
} from "./soundConfigEditor.helpers";

export interface SoundConfigEditorProps {
  /** Current per-entity config; `undefined` means "inherit global". */
  value: EntitySoundConfig | undefined;
  /** Reports the next config (or `undefined` to inherit global). */
  onChange: (next: EntitySoundConfig | undefined) => void;
  /**
   * Selectable sounds (built-ins + custom uploads), injected by the parent —
   * typically sourced from the sound store's `list_sounds`. May be empty while
   * the list is loading or when the audio backend is unavailable; the pickers
   * then offer only "use global default".
   */
  sounds: readonly SoundDescriptor[];
  /**
   * Optional preview handler. When provided, each enabled outcome shows a Play
   * button that calls this with the sound id to audition (the chosen sound, or
   * the resolved global fallback). Omit to hide the Play buttons entirely (e.g.
   * while the audio backend is deferred).
   */
  onPreview?: (soundId: string) => void;
  /**
   * Global fallback sound ids, used only to decide what a Play button should
   * audition when an outcome is set to "use global default". Optional.
   */
  globalDefaults?: { successSoundId?: string; errorSoundId?: string };
  /** Disable all controls (e.g. while the parent form is read-only). */
  disabled?: boolean;
}

const OUTCOMES: readonly SoundOutcome[] = ["success", "error"];

/**
 * Localised label copy for an outcome. Kept inline (not in the helpers module)
 * because it depends on the `t` function and is view concern only.
 */
function useOutcomeLabels(): Record<SoundOutcome, string> {
  const { t } = useTranslation();
  return {
    success: t("sound.outcome.success", { defaultValue: "On success" }),
    error: t("sound.outcome.error", { defaultValue: "On error" }),
  };
}

export function SoundConfigEditor({
  value,
  onChange,
  sounds,
  onPreview,
  globalDefaults,
  disabled = false,
}: SoundConfigEditorProps): ReactElement {
  const { t } = useTranslation();
  const outcomeLabels = useOutcomeLabels();

  const defaultLabel = t("sound.useGlobalDefault", {
    defaultValue: "Use global default",
  });
  const options = useMemo(
    () => buildSoundOptions(sounds, defaultLabel),
    [sounds, defaultLabel],
  );

  return (
    <div className="sound-config-editor">
      {OUTCOMES.map((outcome) => {
        const slot = getOutcome(value, outcome);
        const enabled = slot?.enabled ?? false;
        const dropdownValue = outcomeToDropdownValue(slot);
        const fallbackId =
          outcome === "success"
            ? globalDefaults?.successSoundId
            : globalDefaults?.errorSoundId;
        const toPreview = previewSoundId(slot, fallbackId);

        return (
          <div key={outcome} className="form-field sound-config-editor__row">
            <div className="sound-config-editor__row-head">
              <ToggleSwitch
                checked={enabled}
                disabled={disabled}
                ariaLabel={outcomeLabels[outcome]}
                onChange={(next) =>
                  onChange(setOutcomeEnabled(value, outcome, next))
                }
              />
              <span className="form-field__label sound-config-editor__label">
                {outcomeLabels[outcome]}
              </span>
            </div>

            {enabled ? (
              <div className="sound-config-editor__controls">
                <Dropdown
                  value={dropdownValue}
                  options={options}
                  disabled={disabled}
                  ariaLabel={t("sound.pickerAriaLabel", {
                    defaultValue: "Sound for {{outcome}}",
                    outcome: outcomeLabels[outcome],
                  })}
                  onChange={(next) =>
                    onChange(setOutcomeSound(value, outcome, next))
                  }
                />
                {onPreview ? (
                  <button
                    type="button"
                    className="btn btn--ghost sound-config-editor__preview"
                    /* Always shown; disabled (grey) until a sound resolves so
                       the affordance stays visible, matching Settings → Sound. */
                    disabled={disabled || toPreview === undefined}
                    aria-label={t("sound.preview", { defaultValue: "Play" })}
                    title={t("sound.preview", { defaultValue: "Play" })}
                    onClick={() => {
                      if (toPreview !== undefined) onPreview(toPreview);
                    }}
                  >
                    <RunIcon />
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}

      <span className="command-form__hint" role="note">
        {t("sound.editorHint", {
          defaultValue:
            "Enable a cue for either outcome and pick its sound. Leave both off to inherit the global sound settings.",
        })}
      </span>
    </div>
  );
}
