// Sound-notification data model.
//
// ProcMix can play a short audio cue when a command or workflow run finishes.
// The feature has two layers:
//
//   1. Global defaults (backend SQLite, see the deferred `sound_settings`
//      table): a master on/off plus a fallback success/error sound. Disabled
//      out of the box — nothing plays until the user opts in.
//   2. Per-entity overrides ({@link EntitySoundConfig} attached to `Command`
//      and `Workflow`): each entity may independently enable success and/or
//      error notifications and pick its own sound for each case.
//
// Resolution at run completion (owned by the Rust `resolve_outcome_sound`):
// a per-entity outcome slot wins over the global default — including a
// per-entity slot that is present-but-disabled, which SUPPRESSES the global
// default. An absent per-entity slot inherits the global default. A
// per-entity slot with `enabled: true` plays even while the global master
// switch is off, so a user can leave sounds globally off and enable them on
// just one entity.

/**
 * Identifier for a selectable sound. Either a built-in tone key
 * (`"builtin:success"`, `"builtin:error"`, `"builtin:chime"`, `"builtin:buzz"`)
 * or the uuid of a user-uploaded custom sound. An id that resolves to nothing
 * (e.g. an imported reference to a custom sound this machine lacks) degrades
 * to the global default / silence rather than erroring.
 */
export type SoundId = string;

/**
 * Per-outcome sound configuration: whether a cue plays for this outcome and,
 * if so, which sound.
 *
 * `soundId` semantics:
 *   - a concrete id  → play that specific sound.
 *   - `undefined`    → play the global default sound for this outcome.
 *
 * `enabled` semantics (relative to the global default):
 *   - `true`  → play (using `soundId` or the global default sound). Plays even
 *     when the global master switch is off.
 *   - `false` → explicitly silent for this outcome, overriding any global
 *     default that would otherwise fire.
 */
export interface SoundOutcomeConfig {
  enabled: boolean;
  soundId?: SoundId;
}

/**
 * Per-entity sound configuration attached to a `Command` or `Workflow`.
 * Both slots are optional: an absent slot inherits the global default for that
 * outcome, a present slot overrides it (see {@link SoundOutcomeConfig}).
 *
 * `undefined` on the entity (the whole field absent) means "inherit global for
 * both outcomes" and is the default for existing/seed entities — no migration
 * needed.
 */
export interface EntitySoundConfig {
  success?: SoundOutcomeConfig;
  error?: SoundOutcomeConfig;
}

/** Whether a {@link SoundDescriptor} is a bundled built-in or a user upload. */
export type SoundKind = "builtin" | "custom";

/**
 * A selectable sound surfaced by the backend `list_sounds` command: the
 * built-in tones plus every user-uploaded custom sound. Used to populate the
 * sound pickers in the global Settings and per-entity editors.
 */
export interface SoundDescriptor {
  /** Stable id — a `"builtin:*"` key or a custom-sound uuid. */
  id: SoundId;
  /** Display label: a localisable built-in name or the original filename. */
  label: string;
  kind: SoundKind;
}

/**
 * Global fallback sound settings (persisted backend-side in SQLite so they are
 * readable at run-completion time, including on the headless / autostart path
 * where no window exists). Disabled by default.
 */
export interface SoundSettings {
  /** Master switch. `false` by default — no sound until the user opts in. */
  enabled: boolean;
  /** Fallback sound for a successful run; `undefined` means no default chosen. */
  successSoundId?: SoundId;
  /** Fallback sound for a failed run; `undefined` means no default chosen. */
  errorSoundId?: SoundId;
  /** Playback volume, 0.0–1.0. */
  volume: number;
}
