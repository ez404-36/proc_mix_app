// Pure helpers for the SoundConfigEditor. Kept separate from the component so
// the option-building and immutable-patch logic can be unit-tested without
// rendering React, and so the component stays a thin presentational shell.

import type {
  EntitySoundConfig,
  SoundDescriptor,
  SoundOutcomeConfig,
} from "../../types";
import type { DropdownOption } from "../Dropdown";

/** The two outcomes a per-entity sound config addresses. */
export type SoundOutcome = "success" | "error";

/**
 * Sentinel dropdown value meaning "use the global default sound for this
 * outcome" — the encoded form of `SoundOutcomeConfig.soundId === undefined`.
 * A non-empty, namespaced string that can never collide with a real
 * `SoundId` (built-in keys are `builtin:*`, customs are uuids).
 */
export const USE_GLOBAL_DEFAULT = "__global_default__";

/**
 * Build the dropdown options for an outcome's sound picker: a leading
 * "use global default" entry followed by every selectable sound. The
 * `defaultLabel` (already localised by the caller) labels the sentinel.
 */
export function buildSoundOptions(
  sounds: readonly SoundDescriptor[],
  defaultLabel: string,
): DropdownOption[] {
  return [
    { value: USE_GLOBAL_DEFAULT, label: defaultLabel },
    ...sounds.map((s) => ({ value: s.id, label: s.label })),
  ];
}

/**
 * The dropdown value for an outcome slot: the concrete `soundId` when one is
 * chosen, else the "use global default" sentinel. An absent slot also maps to
 * the sentinel (the picker is only shown when the outcome is enabled, but this
 * keeps the mapping total).
 */
export function outcomeToDropdownValue(
  slot: SoundOutcomeConfig | undefined,
): string {
  return slot?.soundId ?? USE_GLOBAL_DEFAULT;
}

/**
 * Read an outcome slot from a (possibly-undefined) entity config.
 */
export function getOutcome(
  config: EntitySoundConfig | undefined,
  outcome: SoundOutcome,
): SoundOutcomeConfig | undefined {
  return config?.[outcome];
}

/**
 * Immutably set (or clear) one outcome slot on an entity config, returning the
 * next config — or `undefined` when the result would carry no configured
 * outcome at all (so the entity cleanly falls back to "inherit global" and the
 * repository omits the field entirely rather than persisting an empty object).
 */
function withOutcome(
  config: EntitySoundConfig | undefined,
  outcome: SoundOutcome,
  slot: SoundOutcomeConfig | undefined,
): EntitySoundConfig | undefined {
  const next: EntitySoundConfig = { ...config };
  if (slot === undefined) {
    delete next[outcome];
  } else {
    next[outcome] = slot;
  }
  // Collapse an all-empty config to `undefined` (inherit global for both).
  if (next.success === undefined && next.error === undefined) {
    return undefined;
  }
  return next;
}

/**
 * Toggle an outcome on/off. Enabling creates the slot (preserving any
 * previously-chosen `soundId`); disabling sets `enabled: false` while KEEPING
 * the slot so the choice is remembered and — per the resolution contract — a
 * present-but-disabled slot explicitly suppresses the global default.
 */
export function setOutcomeEnabled(
  config: EntitySoundConfig | undefined,
  outcome: SoundOutcome,
  enabled: boolean,
): EntitySoundConfig | undefined {
  const current = getOutcome(config, outcome);
  const slot: SoundOutcomeConfig = {
    ...current,
    enabled,
  };
  return withOutcome(config, outcome, slot);
}

/**
 * Choose the sound for an outcome. The sentinel maps back to
 * `soundId: undefined` (use the global default). Selecting a sound implies the
 * outcome is enabled (the picker is only interactive when enabled), so
 * `enabled` is forced true to keep the slot coherent.
 */
export function setOutcomeSound(
  config: EntitySoundConfig | undefined,
  outcome: SoundOutcome,
  dropdownValue: string,
): EntitySoundConfig | undefined {
  const current = getOutcome(config, outcome);
  const soundId =
    dropdownValue === USE_GLOBAL_DEFAULT ? undefined : dropdownValue;
  const slot: SoundOutcomeConfig = {
    enabled: current?.enabled ?? true,
    ...(soundId !== undefined ? { soundId } : {}),
  };
  return withOutcome(config, outcome, slot);
}

/**
 * Resolve the concrete sound id the Play/preview button should audition for an
 * outcome: the slot's chosen `soundId`, else the caller-supplied global
 * fallback for that outcome, else `undefined` (nothing to preview).
 */
export function previewSoundId(
  slot: SoundOutcomeConfig | undefined,
  globalFallbackId: string | undefined,
): string | undefined {
  return slot?.soundId ?? globalFallbackId;
}
