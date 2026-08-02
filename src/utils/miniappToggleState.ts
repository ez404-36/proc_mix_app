// Derivation of a status-backed Mini-App toggle's on/off position.
//
// The naive rule ("the probe exited 0 → the switch is ON") is WRONG: a status
// command that reports `disconnected` still exits 0, so the switch rendered
// "on" whenever the probe merely ran — and clicking it then fired the OFF
// action against an already-off service.
//
// The authoritative rule is a VALUE comparison against the toggle's
// `status.onValue`. When the author has not configured one we fall back to the
// legacy heuristic, but the caller is told so (`matched: false`) and renders
// the status label as the honest source of truth.

import type { StatusResult } from "../services/miniappStatusPoller";

/** Outcome of {@link resolveToggleOnState}. */
export interface ToggleOnState {
  /** Whether the switch should render in the ON position. */
  isOn: boolean;
  /**
   * `true` when `isOn` was derived from a real `onValue` comparison; `false`
   * when it came from the legacy "the probe succeeded" heuristic (no
   * `onValue` configured, or no status result yet). The UI uses this to mark
   * the position as unverified.
   */
  matched: boolean;
}

/**
 * Normalise a status token for comparison: trimmed and case-folded. Both the
 * configured `onValue` and the probe's value go through this, so
 * `" Connected "` matches `connected`.
 */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Render a probe's raw value as a comparable string. Mirrors the poller's own
 * `stringifyValue` for the primitive cases; a non-primitive raw value has no
 * meaningful scalar form for an equality test, so it yields `null` (no match)
 * rather than an arbitrary JSON encoding.
 */
function rawValueToken(rawValue: unknown): string | null {
  if (typeof rawValue === "string") return rawValue;
  if (typeof rawValue === "number" || typeof rawValue === "boolean") {
    return String(rawValue);
  }
  return null;
}

/**
 * Decide whether a status-backed toggle should render as ON.
 *
 * When `onValue` is configured, the toggle is ON iff the latest successful
 * probe's value matches it. Both the MAPPED LABEL and the RAW value are
 * compared (case-insensitively, trimmed) so an author can write either the
 * underlying token (`connected`) or the display label they mapped it to
 * (`Connected`) — whichever they have in front of them in the editor.
 *
 * A non-`ok` probe (error / loading / idle) is never ON: an unreachable
 * service is off as far as the user is concerned, and rendering ON would
 * make the click target run the wrong action.
 *
 * When `onValue` is NOT configured the result falls back to the legacy
 * `state === "ok"` heuristic and reports `matched: false`, so the caller can
 * flag the position as unverified.
 */
export function resolveToggleOnState(
  statusResult: StatusResult | undefined,
  onValue: string | undefined,
): ToggleOnState {
  const configured = onValue !== undefined && onValue.trim() !== "";
  if (statusResult === undefined || statusResult.state !== "ok") {
    return { isOn: false, matched: configured };
  }
  if (!configured) {
    // No `onValue` declared — the best available signal is "the probe ran".
    // Reported as unverified so the UI can say so; the inline status label
    // remains the authoritative display of the real state.
    return { isOn: true, matched: false };
  }
  const target = normalize(onValue);
  if (normalize(statusResult.label) === target) {
    return { isOn: true, matched: true };
  }
  const raw = rawValueToken(statusResult.rawValue);
  if (raw !== null && normalize(raw) === target) {
    return { isOn: true, matched: true };
  }
  return { isOn: false, matched: true };
}
