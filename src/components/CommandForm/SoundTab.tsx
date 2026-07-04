import { useEffect, type ReactElement } from "react";

import type { EntitySoundConfig } from "../../types";
import { SoundConfigEditor } from "../SoundConfigEditor";
import { useSoundStore } from "../../stores/soundStore";
import type { FormTab } from "./formState";

export interface SoundTabProps {
  active: boolean;
  value: EntitySoundConfig | undefined;
  onChange: (next: EntitySoundConfig | undefined) => void;
}

/**
 * The command form's Sound tab: the per-command sound-notification editor.
 * Sources the selectable sound list, preview handler, and global-default ids
 * from `useSoundStore`; state for the value comes from the parent CommandForm.
 */
export function SoundTab(props: SoundTabProps): ReactElement {
  const { active, value, onChange } = props;
  const tab: FormTab = "sound";

  const sounds = useSoundStore((s) => s.sounds);
  const preview = useSoundStore((s) => s.preview);
  const settings = useSoundStore((s) => s.settings);
  const load = useSoundStore((s) => s.load);

  // Populate the sound list the first time the tab is actually OPENED, not on
  // every CommandForm mount — the tab is always rendered (just hidden), and an
  // eager fetch would cross the IPC boundary before the user ever visits it.
  // Only fetch when active and the list is still empty.
  useEffect(() => {
    if (active && sounds.length === 0) {
      void load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return (
    <div
      role="tabpanel"
      id={`command-form-panel-${tab}`}
      aria-labelledby={`command-form-tab-${tab}`}
      hidden={!active}
      className="command-form__panel"
    >
      <SoundConfigEditor
        value={value}
        onChange={onChange}
        sounds={sounds}
        onPreview={(id) => void preview(id)}
        globalDefaults={{
          successSoundId: settings.successSoundId,
          errorSoundId: settings.errorSoundId,
        }}
      />
    </div>
  );
}
