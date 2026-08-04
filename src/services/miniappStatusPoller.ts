// Frontend polling loop for Mini-App status widgets.
//
// A status widget points at a `StatusSource` (a library command id or an
// inline script) and a `StatusMapping` describing how to render the probe's
// result. This module owns two concerns:
//
//   1. `applyStatusMapping` — a PURE helper that turns a probe result into a
//      display-ready `StatusResult`. It has no React dependency and is the
//      unit-testable surface for the mapping rules.
//   2. `useMiniAppStatusPolling` — a React hook that, for each widget config,
//      runs an initial probe immediately, then re-probes on a `setInterval`,
//      pausing while the tab is hidden and skipping ticks whose previous
//      probe is still in flight.
//
// The actual IPC lives in `utils/miniappRepository.runStatusProbe`; this hook
// never calls `invoke` directly (project convention).

import { useCallback, useEffect, useRef, useState } from "react";

import type { StatusMapping, StatusSource } from "../types";
import { runStatusProbe } from "../utils/miniappRepository";

/**
 * Result of a headless status probe. Structurally identical to the wire
 * `StatusProbeResultRecord` returned by `runStatusProbe` — declared locally
 * so this module is self-contained and the `applyStatusMapping` contract is
 * explicit. The two types are mutually assignable via structural typing.
 */
export interface StatusProbeResult {
  status: string;
  exitCode: number | null;
  fields: Record<string, unknown>;
  returnValue: unknown | null;
  stdoutTail: string | null;
}

/**
 * Interpolation parameters for a {@link StatusError} message key. Kept to
 * primitives so the value is safe to hand straight to `t(key, params)`.
 */
export type StatusErrorParams = Record<string, string | number>;

/**
 * A probe failure, carried as a TRANSLATION KEY + params rather than a
 * pre-formatted string. This module has no `t` (it is pure / React-free and
 * the poller runs outside the component tree), so formatting is the render
 * site's job — see `MiniAppWidget`'s `StatusBadge`.
 *
 * `detail` holds the raw backend text (a Rust error string, a probe status
 * token). It is NEVER the user-facing message; the widget exposes it only as
 * a `title` tooltip so a developer can still diagnose a failure.
 */
export interface StatusError {
  state: "error";
  messageKey: string;
  params?: StatusErrorParams;
  detail?: string;
}

/**
 * Display-ready outcome for a single status widget. The runner renders the
 * `state` discriminator; `ok` carries the resolved label (and optional
 * colour), `error` a translation key the widget resolves.
 *
 * `unmatched` is a distinct outcome from `ok`: the probe succeeded but NO rule
 * in a `mode: "mapped"` mapping matched the raw value. It never implies a
 * real, author-intended match, so it is never rendered with the `ok`
 * (success) treatment. Two shapes:
 *   - short, single-line raw value → `label` carries it verbatim (preserves
 *     today's DX for "mapped mode with no rules yet" style usage).
 *   - multi-line or overly long raw value → `messageKey` is set instead
 *     (a generic "Unmatched" translation key, resolved at the render site
 *     like {@link StatusError.messageKey}); `label` is the empty string and
 *     MUST NOT be rendered when `messageKey` is present.
 * `rawString` always carries the full raw value so the widget can expose it
 * as a `title` tooltip regardless of which shape was used.
 */
export type StatusResult =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; label: string; color?: string; rawValue: unknown }
  | {
      state: "unmatched";
      label: string;
      messageKey?: string;
      rawValue: unknown;
      rawString: string;
    }
  | StatusError;

/** i18n key for the generic "no rule matched, and the raw value was too long
 *  or multi-line to display directly" fallback label. */
export const STATUS_UNMATCHED_KEY = "miniapps.runner.status.unmatched";

/** Raw values at or under this length, with no newline, are short enough to
 *  show verbatim as an unmatched status label. Anything longer or multi-line
 *  falls back to the generic {@link STATUS_UNMATCHED_KEY} label instead. */
const UNMATCHED_RAW_DISPLAY_LIMIT = 60;

/**
 * Return value of {@link useMiniAppStatusPolling}: the per-widget results plus
 * an imperative refresh trigger.
 */
export interface StatusPolling {
  /** Latest `StatusResult` per widget id. */
  results: Record<string, StatusResult>;
  /**
   * Re-probe `widgetId` immediately, cancelling its pending timer and
   * rearming the schedule from the fresh result. Used after a toggle's
   * on/off action runs, so the switch's real position is re-read at once
   * instead of after up to a full `intervalMs` of showing a stale value.
   *
   * A no-op when the widget has no polling config, when a probe for it is
   * already in flight (the in-flight one will settle and reschedule), or
   * while the document is hidden. Stable across renders — safe to pass
   * straight into a child component's props.
   */
  refresh: (widgetId: string) => void;
}

/** A single widget's polling configuration handed to the hook. */
export interface StatusWidgetConfig {
  widgetId: string;
  source: StatusSource;
  intervalMs: number;
  mapping: StatusMapping;
  /**
   * Optional per-probe `${name}` resolutions. These are the current
   * Mini-App artifact values (collected by the runner from interactive
   * `artifact` widgets). They flow straight through to the Rust status
   * probe via `runStatusProbe(source, variableValues)`, where the same
   * `core/parser.rs` substitution that runs an executed command is applied
   * to the probe's inline script / referenced command. Omitted from the
   * config-signature diff so a value edit (typing into an artifact input)
   * does NOT reset the polling lifecycle — only the next tick reads the
   * fresh values.
   */
  variableValues?: Readonly<Record<string, string>>;
}

/** Floor for the polling interval — anything tighter would hammer the shell. */
const MIN_INTERVAL_MS = 1000;

/**
 * Ceiling for the failure backoff. A widget whose probe keeps failing (a
 * deleted command, an uninstalled utility) would otherwise hammer the
 * executor at full rate for as long as the runner stays open. The interval
 * doubles per consecutive failure and is clamped here; a single success
 * resets it to the configured interval.
 */
export const MAX_BACKOFF_MS = 5 * 60 * 1000;

/** i18n key for "the probe ran but did not report success". */
export const STATUS_PROBE_FAILED_KEY = "miniapps.runner.status.probeFailed";
/** i18n key for "the probe could not be started at all" (IPC / Rust throw). */
export const STATUS_PROBE_ERROR_KEY = "miniapps.runner.status.probeError";

/**
 * Interval for the `n`-th consecutive failure: the configured interval
 * doubled once per failure, clamped to {@link MAX_BACKOFF_MS}. `failures === 0`
 * (the steady state, and the state right after any success) returns the
 * configured interval unchanged.
 *
 * Exported for the unit tests — the backoff schedule is the contract, not an
 * implementation detail of the effect.
 */
export function backoffIntervalMs(
  baseIntervalMs: number,
  failures: number,
): number {
  const base = Math.max(MIN_INTERVAL_MS, baseIntervalMs);
  if (failures <= 0) return base;
  // `2 ** failures` overflows to Infinity long before it matters; `Math.min`
  // still yields the cap, so no explicit exponent clamp is needed.
  return Math.min(MAX_BACKOFF_MS, base * 2 ** failures);
}

/**
 * Stringify an extracted JSON value for display. Strings pass through;
 * numbers / booleans use their native string form; objects/arrays are
 * JSON-encoded. `null`/`undefined` become the empty string (the
 * `applyStatusMapping` priority chain only reaches them as a final
 * fallback, so an empty label is the honest representation of "nothing
 * was extracted").
 */
function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    // A value with a circular reference cannot be serialised — fall back to
    // the runtime's string form rather than throwing inside the poller.
    return String(value);
  }
}

/**
 * A single `StatusMapping.rules[]` entry, narrowed to the fields
 * {@link ruleMatches} needs. Matches the TS `StatusMapping["rules"]` element
 * shape structurally.
 */
interface MatchableRule {
  match: string;
  matchMode?: "exact" | "contains" | "regex";
}

/**
 * Decide whether `rule` matches `rawString`, per its {@link MatchableRule.matchMode}.
 * Absent `matchMode` defaults to `"exact"` (preserves old saved rules with
 * zero migration). An invalid `"regex"` pattern never throws — a malformed
 * user-entered pattern simply never matches, so a broken rule degrades to
 * "falls through to the next rule / raw fallback" rather than crashing the
 * poller.
 */
function ruleMatches(rule: MatchableRule, rawString: string): boolean {
  const mode = rule.matchMode ?? "exact";
  switch (mode) {
    case "exact":
      return rule.match === rawString;
    case "contains":
      return rawString.includes(rule.match);
    case "regex": {
      try {
        return new RegExp(rule.match).test(rawString);
      } catch {
        return false;
      }
    }
  }
}

/**
 * Turn a probe result into a display-ready {@link StatusResult} using the
 * widget's {@link StatusMapping}. Pure — no React, no IPC, no side effects.
 *
 * Resolution order for the raw value:
 *   1. `mapping.field` set AND present in `result.fields` → that field.
 *   2. otherwise `result.returnValue` (when not null/undefined).
 *   3. otherwise `result.stdoutTail` (may be null → empty label).
 *
 * A non-`"succeeded"` probe is an error regardless of the mapping (a failed
 * status command has no meaningful display value). For `mode: "mapped"`, the
 * first rule whose `match` satisfies its {@link ruleMatches} strategy
 * (`"exact"` equality by default, or `"contains"` / `"regex"`) wins; if none
 * match, the result is `state: "unmatched"` — the raw string verbatim when it
 * is short and single-line, or a generic translation key when it is not (see
 * {@link StatusResult}'s doc comment).
 */
export function applyStatusMapping(
  result: StatusProbeResult,
  mapping: StatusMapping,
): StatusResult {
  if (result.status !== "succeeded") {
    // A translation KEY, not an English literal: this module is React-free
    // and cannot call `t`. The widget resolves the key; `detail` keeps the
    // raw backend status token available as a debugging tooltip.
    return {
      state: "error",
      messageKey: STATUS_PROBE_FAILED_KEY,
      params: { status: result.status },
      detail: result.status,
    };
  }

  let rawValue: unknown;
  if (
    mapping.field !== undefined &&
    mapping.field !== "" &&
    mapping.field in result.fields
  ) {
    rawValue = result.fields[mapping.field];
  } else if (result.returnValue !== null && result.returnValue !== undefined) {
    rawValue = result.returnValue;
  } else {
    rawValue = result.stdoutTail;
  }

  const rawString = stringifyValue(rawValue).trim();

  if (mapping.mode === "raw") {
    return { state: "ok", label: rawString, rawValue };
  }

  // mode === "mapped": first rule whose matchMode strategy matches wins.
  const rules = mapping.rules ?? [];
  const matched = rules.find((rule) => ruleMatches(rule, rawString));
  if (matched) {
    return matched.color !== undefined && matched.color !== ""
      ? {
          state: "ok",
          label: matched.label,
          color: matched.color,
          rawValue,
        }
      : { state: "ok", label: matched.label, rawValue };
  }
  // No rule matched. A short, single-line raw value is still shown verbatim
  // (this is what lets "mapped" mode double as "raw" mode while the author
  // has not written any rules yet); anything multi-line or long — e.g. a
  // whole `openvpn3 sessions-list` block — would blow up the compact badge,
  // so it collapses to the generic "Unmatched" label instead. Either way the
  // outcome is `unmatched`, never `ok`: no rule actually matched, so this must
  // not be styled as a real success.
  const isDisplayable =
    rawString.length <= UNMATCHED_RAW_DISPLAY_LIMIT && !rawString.includes("\n");
  return isDisplayable
    ? { state: "unmatched", label: rawString, rawValue, rawString }
    : {
        state: "unmatched",
        label: "",
        messageKey: STATUS_UNMATCHED_KEY,
        rawValue,
        rawString,
      };
}

/**
 * Compute a stable signature for a configs array so the polling effect can
 * tear down + rebuild only when the widget set, intervals, sources, or
 * mappings actually change — not on every parent render (which rebuilds the
 * array reference). The hook keeps a ref to the latest configs so individual
 * probes always read fresh values; this signature gates the lifecycle.
 */
function configSignature(configs: StatusWidgetConfig[]): string {
  return configs
    .map((c) =>
      JSON.stringify({
        id: c.widgetId,
        interval: Math.max(MIN_INTERVAL_MS, c.intervalMs),
        source: c.source,
        mapping: c.mapping,
      }),
    )
    .join("|");
}

/**
 * Poll one or more status widgets, returning a `widgetId → StatusResult` map.
 *
 * Behaviour:
 *   - Each widget is probed immediately on mount, then re-probed on a
 *     self-rescheduling timer whose delay is the configured interval
 *     (clamped to {@link MIN_INTERVAL_MS}).
 *   - `state: "loading"` is only ever reported for a widget's FIRST probe
 *     (no result yet). A re-poll of an already-settled widget keeps
 *     reporting its last known result until the new probe settles — so a
 *     status-backed toggle's position (or any other display) never flashes
 *     to an "unknown" state on every tick just because a routine re-check is
 *     in flight.
 *   - CONSECUTIVE FAILURES BACK OFF: the delay doubles per failure up to
 *     {@link MAX_BACKOFF_MS}, and resets on the first success. A widget
 *     pointing at a deleted command therefore stops hammering the executor.
 *   - When the tab is hidden (`document.hidden`) all timers are cleared;
 *     on return to visible the widgets are re-probed immediately and the
 *     timers restarted (the failure counters survive the flip).
 *   - The next probe is only scheduled once the previous one settles, so a
 *     slow probe can never stack up requests.
 *   - Everything is torn down on unmount or when the config signature changes.
 *
 * The hook accepts a fresh array on every render (parents typically rebuild
 * it from widget data) — internally it diffs by {@link configSignature} so
 * the lifecycle only resets on a real change.
 *
 * Returns the `widgetId → StatusResult` map plus {@link StatusPolling.refresh},
 * an imperative "re-probe this widget NOW" trigger — see its own doc comment.
 */
export function useMiniAppStatusPolling(
  configs: StatusWidgetConfig[],
): StatusPolling {
  const [results, setResults] = useState<Record<string, StatusResult>>({});

  // Ref mirror of the latest configs so the interval callbacks always read
  // fresh source/mapping values without the effect depending on the array
  // reference (which changes every render).
  const configsRef = useRef(configs);
  useEffect(() => {
    configsRef.current = configs;
  });

  // Ref holding the CURRENT effect instance's `runProbe`, so `refresh` (a
  // stable callback handed to widgets) always reaches the live polling
  // lifecycle rather than closing over a torn-down one. Reassigned by the
  // effect below on every (re)start and cleared on teardown.
  const runProbeRef = useRef<((widgetId: string) => void) | null>(null);

  // The lifecycle keys off the serialized signature, not the array identity.
  const signature = configSignature(configs);

  useEffect(() => {
    // Guards cleanup: once true, pending probes must not write state.
    let cancelled = false;
    // Per-widget in-flight markers — a probe is skipped while one is running.
    const inFlight = new Set<string>();
    // Self-rescheduling timers: each probe schedules the NEXT one once it
    // settles, which is what lets the delay grow with consecutive failures.
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    // Consecutive-failure counter per widget. Reset to 0 on any success;
    // survives a visibility flip so a broken probe does not regain full rate
    // just because the user switched tabs.
    const failures = new Map<string, number>();

    /**
     * Arm the next probe for `widgetId` after the backoff-adjusted delay.
     * Any previously-armed timer for the same widget is cleared first so a
     * widget can never accumulate two timers.
     */
    const scheduleNext = (widgetId: string): void => {
      if (cancelled || document.hidden) return;
      const existing = timers.get(widgetId);
      if (existing !== undefined) clearTimeout(existing);
      const latest = configsRef.current.find((c) => c.widgetId === widgetId);
      if (latest === undefined) return;
      const delay = backoffIntervalMs(
        latest.intervalMs,
        failures.get(widgetId) ?? 0,
      );
      const handle = setTimeout(() => {
        // Always read the latest config for this widget id so source /
        // mapping edits apply without a full lifecycle reset.
        const fresh = configsRef.current.find((c) => c.widgetId === widgetId);
        if (fresh) runProbe(fresh);
      }, delay);
      timers.set(widgetId, handle);
    };

    const runProbe = (config: StatusWidgetConfig): void => {
      if (cancelled) return;
      // Defensive: a timer queued just before the visibility handler cleared
      // it could still fire while hidden. Drop the probe rather than spawn
      // one the user cannot see (the visibility handler restarts polling on
      // return).
      if (document.hidden) return;
      if (inFlight.has(config.widgetId)) return;
      inFlight.add(config.widgetId);

      // Only flash the `loading` badge for the WIDGET'S FIRST EVER probe
      // (no prior result yet). A RE-poll of an already-settled widget keeps
      // showing its last known result while the new probe is in flight —
      // flipping to `loading` on every tick would otherwise blank a
      // status-backed toggle's position (and any other display) for the
      // ~1-2s a shell probe takes, every `intervalMs`, forever. The real
      // value still updates the moment the probe settles below; this only
      // suppresses the transient "unknown" flash for a value that was
      // already known.
      setResults((prev) =>
        prev[config.widgetId] === undefined
          ? { ...prev, [config.widgetId]: { state: "loading" } }
          : prev,
      );

      void (async (): Promise<void> => {
        let next: StatusResult;
        try {
          const probeResult = await runStatusProbe(
            config.source,
            config.variableValues,
          );
          if (cancelled) return;
          next = applyStatusMapping(probeResult, config.mapping);
        } catch (err) {
          if (cancelled) return;
          // A throw here is the probe failing to START (missing command,
          // IPC error). Carry a translation key; the raw Rust string stays
          // in `detail` as a developer tooltip, never as the user's message.
          const detail = err instanceof Error ? err.message : String(err);
          next = {
            state: "error",
            messageKey: STATUS_PROBE_ERROR_KEY,
            detail,
          };
        } finally {
          inFlight.delete(config.widgetId);
        }
        if (cancelled) return;
        if (next.state === "error") {
          failures.set(config.widgetId, (failures.get(config.widgetId) ?? 0) + 1);
        } else {
          failures.set(config.widgetId, 0);
        }
        setResults((prev) => ({ ...prev, [config.widgetId]: next }));
        // Reschedule only after the probe settles, so a slow probe cannot
        // stack up requests and a failing one backs off.
        scheduleNext(config.widgetId);
      })();
    };

    const startAll = (): void => {
      // Read the freshest configs so a mapping edit between visibility flips
      // is honoured on resume.
      for (const config of configsRef.current) {
        // The immediate probe arms its own follow-up via `scheduleNext`.
        runProbe(config);
      }
    };

    const stopAll = (): void => {
      for (const handle of timers.values()) {
        clearTimeout(handle);
      }
      timers.clear();
    };

    const handleVisibilityChange = (): void => {
      if (document.hidden) {
        stopAll();
      } else {
        startAll();
      }
    };

    // Publish THIS lifecycle's probe runner for the stable `refresh` callback
    // below. Looking the config up here (rather than closing over one) keeps
    // an imperative refresh on the same "always read the freshest config"
    // contract as a scheduled tick.
    runProbeRef.current = (widgetId: string): void => {
      const fresh = configsRef.current.find((c) => c.widgetId === widgetId);
      if (fresh === undefined) return;
      // Drop the armed timer first so the forced probe REPLACES the pending
      // tick rather than racing it — `runProbe` rearms via `scheduleNext`
      // once it settles.
      const existing = timers.get(widgetId);
      if (existing !== undefined) {
        clearTimeout(existing);
        timers.delete(widgetId);
      }
      runProbe(fresh);
    };

    startAll();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      runProbeRef.current = null;
      stopAll();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
    // The effect keys off the serialised `signature`, not the `configs` array
    // reference (which the parent rebuilds each render). No reactive values
    // other than `signature` are read inside, so exhaustive-deps stays quiet.
  }, [signature]);

  // Stable identity across renders (empty dep list) — it dereferences the ref
  // at CALL time, so it always reaches the live lifecycle even though the
  // effect re-creates `runProbe` whenever the config signature changes.
  const refresh = useCallback((widgetId: string): void => {
    runProbeRef.current?.(widgetId);
  }, []);

  return { results, refresh };
}
