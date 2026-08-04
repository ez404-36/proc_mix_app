import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, ReactElement } from "react";
import { Message } from "@arco-design/web-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { openPath } from "@tauri-apps/plugin-opener";
import { pickArtifactPath } from "../../services/miniappPathPicker";
import type { Command } from "../../types";
import type { MiniAppAction, StatusSource, WidgetStyle } from "../../types";
// Alias the domain type so the exported component can keep the same name
// (`MiniAppWidget`) the runner imports, without shadowing the type within
// this file. The two are structurally identical for consumers.
import type { MiniAppWidget as WidgetSpec } from "../../types";
import { useCommandStore } from "../../stores/commandStore";
import { triggerCommandRun } from "../../services/commandRunner";
import type { StatusResult } from "../../services/miniappStatusPoller";
import { resolveArtifactValues } from "../../utils/resolveArtifactValues";
import { renderIcon } from "../../utils/iconRenderer";
import {
  buildInlineCommand,
  withArtifactVariableSpecs,
  type ArtifactSpecSource,
} from "../../utils/miniappInlineCommand";
import { resolveToggleOnState } from "../../utils/miniappToggleState";
import { ToggleSwitch } from "../ToggleSwitch/ToggleSwitch";
import {
  ExportIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  InfoIcon,
  RunIcon,
  SpinnerIcon,
  StatusCheckIcon,
  StatusCrossIcon,
} from "../icons";

/**
 * Shared artifact context threaded from the runner into every widget. The
 * runner owns the canonical `artifactValues` map (current values keyed by
 * artifact `name`); each widget reads from it for display resolution and
 * (for buttons/toggles) routes it into `triggerCommandRun` as
 * `RunOptions.variableValues` so Rust's `core/parser.rs` substitutes
 * `${artifactName}` in the script.
 */
export interface ArtifactContext {
  /** Current artifact values keyed by artifact `name`. */
  artifactValues: Record<string, string>;
  /** Update a single artifact value (called by interactive artifact inputs). */
  onArtifactChange: (name: string, value: string) => void;
  /** The set of names that ARE artifacts (vs command variables). */
  artifactNames: ReadonlySet<string>;
  /** `ReadonlyMap` view of `artifactValues` for the display-text resolver. */
  valuesMap: ReadonlyMap<string, string>;
  /**
   * The execution-side values map — the raw artifact values routed through
   * `RunOptions.variableValues`. Provided as its own prop so a widget that
   * wants to layer additional values can spread + override without mutating
   * the runner's map.
   */
  executionValues: Record<string, string>;
  /**
   * The panel's referenceable artifacts (name / editor default / variant).
   * A `VariableSpec` is synthesized from each one for every action that
   * runs, so a `${artifactName}` whose runtime value is missing degrades to
   * the editor default instead of failing with Rust's `MissingVariable`,
   * and a `secret` artifact is marked `sensitive` for redaction.
   * See `utils/miniappInlineCommand`.
   */
  artifactSpecs: ReadonlyArray<ArtifactSpecSource>;
}

export interface MiniAppWidgetProps extends ArtifactContext {
  widget: WidgetSpec;
  /**
   * Latest status result for this widget, produced by the runner's poller.
   * Only meaningful for `status` widgets and `toggle` widgets that carry a
   * `status` source; absent for buttons and artifacts.
   */
  statusResult?: StatusResult;
  /**
   * Fired by button / toggle widgets once an action was actually invoked
   * (the run started). The runner uses it to bump the mini-app's run count.
   * NOT fired when a `commandRef` resolves to a missing command or the run
   * was cancelled before spawning.
   */
  onActionComplete?: () => void;
  /**
   * Fired with the execution id the moment `triggerCommandRun` resolves
   * (i.e. the run actually started spawning) — same firing rule as
   * {@link onActionComplete}, but carries the id so the runner can track
   * which OS process belongs to which widget for the active-processes panel.
   * A single widget can fire this MULTIPLE times over its lifetime (each
   * click/toggle is its own execution); the runner is responsible for
   * de-duplicating/clearing finished entries, not this component.
   */
  onExecutionStarted?: (executionId: string) => void;
  /**
   * Force an immediate status re-probe for THIS widget, bypassing the rest of
   * its polling interval (see `StatusPolling.refresh`). Only `toggle` widgets
   * call it — right after an on/off action settles — so the switch's real
   * position is confirmed at once instead of after up to a full interval.
   * Absent in the editor preview, where nothing is polled.
   */
  onRefreshStatus?: () => void;
  /**
   * Whether the widget's root renders the bordered/background "card" chrome.
   * Defaults to `true` (the editor canvas's WYSIWYG preview relies on this
   * default to keep showing selection/drag affordances). The Runner passes
   * `false` so widgets render as bare controls without card chrome.
   */
  bordered?: boolean;
}

/**
 * Resolve a widget action into the `Command` it should run.
 *
 * - `commandRef`: looks the id up in the command store; returns `null` when
 *   the referenced command no longer exists (deleted, or a stale id on an
 *   imported mini-app). The caller surfaces a localized "command not found".
 *   The stored command is never mutated — a COPY carrying the panel's
 *   synthesized artifact specs is returned so a referenced command that
 *   parameterises on `${artifactName}` gets the same missing-value fallback
 *   and secret redaction an inline action does.
 * - `inline`: builds a fresh ephemeral `Command` from the action's fields,
 *   with one synthesized `VariableSpec` per artifact.
 */
function resolveActionCommand(
  action: MiniAppAction,
  commands: Command[],
  artifactSpecs: ReadonlyArray<ArtifactSpecSource>,
): Command | null {
  if (action.kind === "commandRef") {
    const found = commands.find((c) => c.id === action.commandId);
    return found !== undefined
      ? withArtifactVariableSpecs(found, artifactSpecs)
      : null;
  }
  return buildInlineCommand(action, artifactSpecs);
}

/**
 * Whether a widget action can currently be executed. A `commandRef` pointing
 * at a deleted / never-imported command cannot — the widget renders in a
 * visibly broken state rather than looking healthy and only failing on click.
 * An `inline` action always carries its own script, so it is always runnable.
 */
function isActionRunnable(action: MiniAppAction, commands: Command[]): boolean {
  if (action.kind !== "commandRef") return true;
  return commands.some((c) => c.id === action.commandId);
}

/**
 * Whether a status source resolves. Same rule as {@link isActionRunnable},
 * applied to a `status` widget's (or a status-backed toggle's) probe source.
 */
function isSourceResolvable(
  source: StatusSource,
  commands: Command[],
): boolean {
  if (source.kind !== "commandRef") return true;
  return commands.some((c) => c.id === source.commandId);
}

/**
 * Inline warning marker for a widget whose action / status source references
 * a command that no longer exists. Rendered next to the (disabled) control so
 * the breakage is visible at a glance instead of only on click.
 */
function BrokenRefMarker({ label }: { label: string }): ReactElement {
  return (
    <span
      className="miniapp-widget__broken"
      role="img"
      aria-label={label}
      title={label}
    >
      <InfoIcon />
    </span>
  );
}

/**
 * Resolve + run a widget action end-to-end. Handles the missing-command
 * toast, the try/catch around `triggerCommandRun`, and firing
 * `onActionComplete` only when a run actually started (non-null execution
 * id). `triggerCommandRun` swallows its own run errors (admin sentinel,
 * remote sentinels, generic failure) via Arco toasts and returns `null`, so
 * the outer try/catch is purely defensive against an unexpected throw.
 *
 * `variableValues` carries the current artifact values so Rust's
 * `core/parser.rs` substitutes `${artifactName}` in the script / args /
 * workingDir / env — for BOTH an inline action AND a referenced library
 * command (a referenced command may itself parameterise on an artifact
 * name). The map is passed verbatim; `triggerCommandRun` merges it with
 * the command's own variable defaults + prompt results.
 */
async function runWidgetAction(
  action: MiniAppAction,
  commands: Command[],
  t: TFunction,
  artifactSpecs: ReadonlyArray<ArtifactSpecSource>,
  onActionComplete?: () => void,
  variableValues?: Record<string, string>,
  onExecutionStarted?: (executionId: string) => void,
): Promise<void> {
  const cmd = resolveActionCommand(action, commands, artifactSpecs);
  if (cmd === null) {
    Message.error(t("miniapps.runner.commandNotFound"));
    return;
  }
  try {
    const executionId = await triggerCommandRun(cmd, {
      variableValues: variableValues ?? {},
    });
    if (executionId !== null) {
      onActionComplete?.();
      onExecutionStarted?.(executionId);
    }
  } catch (err) {
    // Defensive only — `triggerCommandRun` already surfaces a toast for
    // every known failure path. A throw here is an unexpected boundary
    // error, so we surface it rather than swallow it.
    const message = err instanceof Error ? err.message : String(err);
    Message.error(
      t("miniapps.runner.runFailed", { defaultValue: message, message }),
    );
  }
}

/**
 * Resolve a button's author-configured {@link WidgetStyle} into inline CSS,
 * mirroring {@link TextWidget}'s established pattern (a plain object built
 * from optional style fields, spread onto the element). Fully-default style
 * (no `color`, `variant` unset or `"fill"`) returns `undefined` so an
 * already-saved widget with no `style` renders with ZERO inline style and
 * keeps the exact `.btn--run` appearance.
 *
 * `"outline"` swaps to a transparent background with a colored border/text;
 * a custom `"fill"` color keeps a solid background with white text (matching
 * `.btn--run`'s own `color: #fff`).
 */
function buttonStyleFor(style: WidgetStyle | undefined): CSSProperties | undefined {
  if (style === undefined) return undefined;
  const variant = style.variant ?? "fill";
  if (style.color === undefined && variant === "fill") return undefined;
  if (variant === "outline") {
    return {
      backgroundColor: "transparent",
      borderColor: style.color ?? "var(--app-color-run)",
      color: style.color ?? "var(--app-color-run)",
    };
  }
  return {
    backgroundColor: style.color,
    borderColor: style.color,
    color: "#fff",
  };
}

interface ButtonWidgetProps extends ArtifactContext {
  widget: Extract<WidgetSpec, { kind: "button" }>;
  onActionComplete?: () => void;
  onExecutionStarted?: (executionId: string) => void;
}

function ButtonWidget({
  widget,
  onActionComplete,
  onExecutionStarted,
  artifactNames,
  valuesMap,
  executionValues,
  artifactSpecs,
}: ButtonWidgetProps): ReactElement {
  const { t } = useTranslation();
  const commands = useCommandStore((s) => s.commands);
  const [isRunning, setIsRunning] = useState(false);

  // Display label: resolve `${artifactName}` references against the current
  // artifact values. A non-artifact reference (`${cmdVar}`) survives verbatim
  // (Rust resolves it at run time).
  const resolvedLabel = resolveArtifactValues(
    widget.label,
    valuesMap,
    artifactNames,
  );

  // A button whose `commandRef` no longer resolves is DISABLED and marked,
  // rather than looking healthy and only erroring on click.
  const isBroken = !isActionRunnable(widget.action, commands);
  const brokenLabel = t("miniapps.runner.brokenCommand");

  const handleClick = (): void => {
    if (isRunning || isBroken) return;
    setIsRunning(true);
    void (async (): Promise<void> => {
      try {
        await runWidgetAction(
          widget.action,
          commands,
          t,
          artifactSpecs,
          onActionComplete,
          executionValues,
          onExecutionStarted,
        );
      } finally {
        setIsRunning(false);
      }
    })();
  };

  // A configured `icon` (emoji or data URI) replaces the default run glyph;
  // the spinner always wins while a run is in flight.
  const leadingIcon = isRunning ? (
    <SpinnerIcon />
  ) : (
    (renderIcon(widget.icon, 16, "miniapp-widget__button-icon") ?? <RunIcon />)
  );

  return (
    <span className="miniapp-widget__button-row">
      <button
        type="button"
        className={`btn btn--run miniapp-widget__button${
          isBroken ? " is-broken" : ""
        }`}
        onClick={handleClick}
        disabled={isRunning || isBroken}
        title={isBroken ? brokenLabel : undefined}
        style={buttonStyleFor(widget.style)}
      >
        {leadingIcon}
        <span>{isRunning ? t("miniapps.runner.running") : resolvedLabel}</span>
      </button>
      {isBroken ? <BrokenRefMarker label={brokenLabel} /> : null}
    </span>
  );
}

/**
 * How long a toggle keeps showing the position the user just asked for while
 * waiting for the real state to catch up (see `optimisticOn` in
 * {@link ToggleWidget}). Generous enough to cover a slow connect/disconnect
 * plus a poll interval, short enough that a genuinely failed action visibly
 * self-corrects rather than leaving the switch stuck in a lie.
 */
const OPTIMISTIC_TOGGLE_GRACE_MS = 30_000;

interface ToggleWidgetProps extends ArtifactContext {
  widget: Extract<WidgetSpec, { kind: "toggle" }>;
  statusResult?: StatusResult;
  onActionComplete?: () => void;
  onExecutionStarted?: (executionId: string) => void;
  /** Force an immediate status re-probe for this widget (see `StatusPolling`). */
  onRefreshStatus?: () => void;
}

function ToggleWidget({
  widget,
  statusResult,
  onActionComplete,
  onExecutionStarted,
  onRefreshStatus,
  artifactNames,
  valuesMap,
  executionValues,
  artifactSpecs,
}: ToggleWidgetProps): ReactElement {
  const { t } = useTranslation();
  const commands = useCommandStore((s) => s.commands);
  // Local state is authoritative only when the toggle has NO status source.
  // It starts `false` because there is nothing to read the real state from —
  // a status-less toggle is INHERENTLY unverified, which is why it renders
  // the "unverified" marker below. The real fix for an author who needs an
  // accurate position is to configure `status` + `status.onValue`.
  const [localOn, setLocalOn] = useState(false);
  const [pendingAction, setPendingAction] = useState<"on" | "off" | null>(null);
  // The position the user last ASKED for, held past the action's completion
  // until the real state can be expected to reflect it.
  //
  // WHY THIS IS SEPARATE FROM `pendingAction`: `triggerCommandRun` resolves
  // as soon as the process is SPAWNED, not when it finishes — and even after
  // it finishes, the underlying tool (openvpn3 connecting, a service
  // starting) needs longer still before a probe can observe the new state.
  // Driving the switch off `pendingAction` alone therefore snapped it back to
  // the old position the instant the spawn returned, which reads as "my click
  // was undone".
  const [optimisticOn, setOptimisticOn] = useState<boolean | null>(null);
  // The `statusResult` object that was on screen when the CURRENT override
  // was created. Any probe result with this exact identity predates the
  // action and therefore cannot speak to its outcome — see the confirm
  // effect below.
  const overrideBaselineRef = useRef<StatusResult | undefined>(undefined);
  // Monotonic id bumped on every toggle click. The grace-window effect keys
  // on this rather than on `optimisticOn`, so the deadline restarts for EVERY
  // click — including one that re-requests the position already displayed
  // (e.g. re-issuing "on" after a failed attempt), where `optimisticOn` alone
  // would not change and would silently leave the previous, nearly-expired
  // deadline in force.
  const [overrideAttempt, setOverrideAttempt] = useState(0);

  const statusBacked = widget.status !== undefined;
  // Value-based derivation: ON iff the probe's value matches `onValue`
  // (case-insensitive). Falls back to the legacy "probe succeeded" heuristic
  // when no `onValue` is configured — reported via `matched: false`.
  const derived = resolveToggleOnState(statusResult, widget.status?.onValue);

  // Retire the optimistic override as soon as a FRESH settled probe AGREES
  // with it: the real state has caught up, so the override is redundant and
  // the poller is authoritative again.
  //
  // "FRESH" is load-bearing, not a detail. Comparing values alone cannot tell
  // "the probe confirms my action" from "the probe happens to match because
  // it ran BEFORE my action". That distinction is invisible when toggling
  // back mid-transition: with real state OFF, clicking ON then immediately
  // OFF again leaves the still-stale "off" probe coincidentally matching the
  // second click's target, which would end the transition instantly —
  // dropping the spinner and trusting a reading that predates the action.
  // Requiring a probe result whose identity differs from the one captured at
  // click time closes that hole: only a genuinely new poll can confirm.
  //
  // A DISAGREEING probe is deliberately NOT a clear signal on its own — it is
  // the expected reading for the whole window between "the action was issued"
  // and "the tool finished acting". Letting disagreement clear the override
  // would snap the switch back almost every time. The bounded fallback below
  // is what stops this from ever lying indefinitely.
  const probeSettled =
    statusResult !== undefined && statusResult.state !== "loading";
  useEffect(() => {
    if (!probeSettled || optimisticOn === null) return;
    if (statusResult === overrideBaselineRef.current) return;
    if (derived.isOn === optimisticOn) setOptimisticOn(null);
  }, [probeSettled, derived.isOn, optimisticOn, statusResult]);

  // Bounded fallback: if the real state has NOT caught up within this window,
  // drop the override and show what the probe actually reports. This is what
  // makes a failed/ineffective action self-correct — without it, an override
  // that is never confirmed would display a permanent lie. Re-armed on every
  // new override (each click restarts the grace period).
  useEffect(() => {
    if (optimisticOn === null) return;
    const handle = setTimeout(
      () => setOptimisticOn(null),
      OPTIMISTIC_TOGGLE_GRACE_MS,
    );
    return () => clearTimeout(handle);
    // `overrideAttempt` (not `optimisticOn`) is what guarantees a fresh
    // deadline per click — see its declaration. `optimisticOn` is still a dep
    // so clearing the override tears the timer down.
  }, [optimisticOn, overrideAttempt]);

  // Displayed position. The optimistic value wins for a status-backed toggle
  // while it is set, so the switch flips the moment it is clicked and stays
  // there until the real state catches up (or the grace window expires).
  const isOn = statusBacked ? (optimisticOn ?? derived.isOn) : localOn;

  // The position is "unverified" whenever nothing authoritative backs it:
  // no status source at all, or a status source with no `onValue` mapping.
  const isUnverified = !statusBacked || !derived.matched;

  const resolvedLabel = resolveArtifactValues(
    widget.label,
    valuesMap,
    artifactNames,
  );

  // Broken when EITHER action, or the status source, points at a missing
  // command. The switch is disabled so a click cannot fire a half-working
  // pair of actions.
  const isBroken =
    !isActionRunnable(widget.onAction, commands) ||
    !isActionRunnable(widget.offAction, commands) ||
    (widget.status !== undefined &&
      !isSourceResolvable(widget.status.source, commands));
  const brokenLabel = t("miniapps.runner.brokenCommand");

  const runToggle = (target: "on" | "off"): void => {
    if (pendingAction !== null || isBroken) return;
    const action = target === "on" ? widget.onAction : widget.offAction;
    setPendingAction(target);
    // Flip the visible position IMMEDIATELY — before any IPC — so the switch
    // responds to the click at once. For a status-backed toggle this override
    // outlives the spawn and is retired only by a settled probe (see
    // `optimisticOn`).
    if (statusBacked) {
      // Pin the currently-displayed probe as this override's baseline, so a
      // result that predates the action can never be mistaken for its
      // confirmation (matters when re-toggling mid-transition).
      overrideBaselineRef.current = statusResult;
      setOptimisticOn(target === "on");
      setOverrideAttempt((n) => n + 1);
    } else {
      setLocalOn(target === "on");
    }
    void (async (): Promise<void> => {
      try {
        await runWidgetAction(
          action,
          commands,
          t,
          artifactSpecs,
          onActionComplete,
          executionValues,
          onExecutionStarted,
        );
      } finally {
        setPendingAction(null);
        // Re-probe at once rather than waiting out the remaining interval, so
        // the optimistic position is confirmed (or corrected) as soon as the
        // action's effect is observable.
        onRefreshStatus?.();
      }
    })();
  };

  const handleSwitchChange = (next: boolean): void => {
    runToggle(next ? "on" : "off");
  };

  // The badge shows the real polled status, REPLACED by a spinner for the
  // whole TRANSITION — from the click until the probe confirms the new state
  // (or the grace window expires), i.e. exactly while `optimisticOn` is set.
  //
  // It is deliberately NOT keyed on `pendingAction`: that only covers
  // `triggerCommandRun`, which resolves the instant the process is SPAWNED
  // (milliseconds), so the spinner flashed too briefly to ever be seen while
  // the badge underneath still showed the stale pre-click status for seconds.
  // `optimisticOn` spans the real "we asked, reality hasn't caught up yet"
  // window, which is precisely when a loader is meaningful.
  //
  // A routine background re-poll never renders one (the poller keeps
  // reporting the last settled result instead of a `loading` flash; see
  // `miniappStatusPoller`), so the only spinner a user ever sees on a toggle
  // is one their own click caused.
  const isTransitioning = statusBacked && optimisticOn !== null;
  const statusBadge = isTransitioning ? (
    <span className="miniapp-widget__status-inline">
      <span className="miniapp-widget__badge miniapp-widget__badge--loading">
        <SpinnerIcon />
        <span>
          {t(
            optimisticOn
              ? "miniapps.runner.toggleTurningOn"
              : "miniapps.runner.toggleTurningOff",
          )}
        </span>
      </span>
    </span>
  ) : statusBacked && statusResult ? (
    <span className="miniapp-widget__status-inline">
      <StatusBadge statusResult={statusResult} />
    </span>
  ) : null;

  return (
    <div className="miniapp-widget__toggle">
      <ToggleSwitch
        checked={isOn}
        onChange={handleSwitchChange}
        ariaLabel={resolvedLabel}
        // Only the actual spawn blocks input — the switch stays usable during
        // the (much longer) confirmation window so the user can immediately
        // toggle back if they change their mind.
        disabled={pendingAction !== null || isBroken}
        color={widget.style?.color}
        variant={widget.style?.variant}
      />
      <span className="miniapp-widget__label">{resolvedLabel}</span>
      {isUnverified && !isBroken && !isTransitioning ? (
        <span
          className="miniapp-widget__unverified"
          title={t("miniapps.runner.toggleUnverifiedHint")}
        >
          {t("miniapps.runner.toggleUnverified")}
        </span>
      ) : null}
      {isBroken ? <BrokenRefMarker label={brokenLabel} /> : null}
      {statusBadge}
    </div>
  );
}

interface StatusBadgeProps {
  statusResult: StatusResult;
}

/**
 * Compact inline status indicator shared by the toggle (inline badge) and
 * the dedicated status widget (full card body). Renders the glyph + label
 * for the current poller state.
 *
 * The poller is React-free and cannot translate, so an `error` result carries
 * a translation KEY + params — resolved HERE. The raw backend text stays in
 * `detail` and is surfaced only as a `title` tooltip, never as the user's
 * message.
 *
 * NOTE: `loading` renders the SAME neutral placeholder as `idle`, NOT a
 * spinner. A spinner here would only ever appear for a widget's first probe
 * (the poller suppresses `loading` on every subsequent re-poll, keeping the
 * last settled result instead), which made it a brief, purposeless flash on
 * panel open. The only spinner in the mini-app runtime is the one a toggle
 * shows while the USER'S OWN on/off action is in flight — see `ToggleWidget`.
 */
function StatusBadge({ statusResult }: StatusBadgeProps): ReactElement {
  const { t } = useTranslation();
  switch (statusResult.state) {
    case "error":
      return (
        <span
          className="miniapp-widget__badge miniapp-widget__badge--error"
          title={statusResult.detail}
        >
          <StatusCrossIcon />
          <span>{t(statusResult.messageKey, statusResult.params ?? {})}</span>
        </span>
      );
    case "ok":
      return (
        <span
          className="miniapp-widget__badge miniapp-widget__badge--ok"
          style={
            statusResult.color !== undefined
              ? { color: statusResult.color }
              : undefined
          }
        >
          <StatusCheckIcon />
          <span>{statusResult.label}</span>
        </span>
      );
    case "unmatched":
      return (
        <span
          className="miniapp-widget__badge miniapp-widget__badge--unmatched"
          title={statusResult.rawString}
        >
          <InfoIcon />
          <span>
            {statusResult.messageKey !== undefined
              ? t(statusResult.messageKey)
              : statusResult.label}
          </span>
        </span>
      );
    // `loading` deliberately shares the neutral `idle` placeholder rather
    // than rendering a spinner — see this function's doc comment.
    case "idle":
    case "loading":
    default:
      return (
        <span className="miniapp-widget__badge miniapp-widget__badge--idle">
          <span>—</span>
        </span>
      );
  }
}

interface StatusWidgetViewProps extends ArtifactContext {
  widget: Extract<WidgetSpec, { kind: "status" }>;
  statusResult?: StatusResult;
}

function StatusWidgetView({
  widget,
  statusResult,
  artifactNames,
  valuesMap,
}: StatusWidgetViewProps): ReactElement {
  const { t } = useTranslation();
  const commands = useCommandStore((s) => s.commands);
  const resolved: StatusResult = statusResult ?? { state: "idle" };
  const resolvedLabel = resolveArtifactValues(
    widget.label,
    valuesMap,
    artifactNames,
  );
  // A status widget pointing at a deleted command would otherwise only ever
  // show a generic probe error. Name the actual cause.
  const isBroken = !isSourceResolvable(widget.source, commands);
  const brokenLabel = t("miniapps.runner.brokenCommand");
  return (
    <div
      className={`miniapp-widget__status${isBroken ? " is-broken" : ""}`}
      title={isBroken ? brokenLabel : undefined}
    >
      <span className="miniapp-widget__label">{resolvedLabel}</span>
      {isBroken ? (
        <span className="miniapp-widget__badge miniapp-widget__badge--error">
          <StatusCrossIcon />
          <span>{brokenLabel}</span>
        </span>
      ) : (
        <StatusBadge statusResult={resolved} />
      )}
    </div>
  );
}

interface ArtifactWidgetProps extends ArtifactContext {
  widget: Extract<WidgetSpec, { kind: "artifact" }>;
}

/**
 * Interactive artifact renderer. Each variant presents an editable input
 * whose value flows into the runner's `artifactValues` map (and from there
 * into both execution `variableValues` and the display-text resolver).
 *
 *  - `path`:   text input + a "Browse" button (native OS file dialog via the
 *              `pick_artifact_path` Rust command, so the ABSOLUTE path is
 *              stored) + an "Open" button that launches the current path via
 *              the OS.
 *  - `text`:   plain editable text input.
 *  - `secret`: password input with a reveal toggle.
 *
 * The input shows the raw stored value (`artifactValues[name] ?? widget.value`
 * as a pre-init fallback). A controlled editable input MUST display exactly
 * the stored value or cursor position / edits break, so cross-artifact
 * `${otherArtifact}` references inside an artifact's own value are shown as
 * the raw template here (predictable editing); only the LABEL is resolved
 * for display.
 */
function ArtifactWidget({
  widget,
  artifactValues,
  onArtifactChange,
  artifactNames,
  valuesMap,
}: ArtifactWidgetProps): ReactElement {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  const [opening, setOpening] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  // Pre-init fallback to `widget.value`: the runner populates
  // `artifactValues` in a post-mount effect, so the very first paint sees an
  // empty map. Falling back to the editor default avoids an empty-input
  // flash and stays correct once state is hydrated (same value).
  const value = artifactValues[widget.name] ?? widget.value;

  const resolvedLabel = resolveArtifactValues(
    widget.label,
    valuesMap,
    artifactNames,
  );

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>): void => {
    onArtifactChange(widget.name, event.target.value);
  };

  const handleBrowseClick = (): void => {
    if (browsing) return;
    setBrowsing(true);
    void (async (): Promise<void> => {
      try {
        // The native dialog returns the ABSOLUTE path (via the `rfd`-backed
        // `pick_artifact_path` command); `null` means the user cancelled, in
        // which case the current value is left unchanged.
        const picked = await pickArtifactPath();
        if (picked !== null) {
          onArtifactChange(widget.name, picked);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Message.error(
          t("miniapps.runner.artifact.browseFailed", {
            defaultValue: message,
            message,
          }),
        );
      } finally {
        setBrowsing(false);
      }
    })();
  };

  const handleOpenPath = (): void => {
    if (opening) return;
    setOpening(true);
    void (async (): Promise<void> => {
      try {
        await openPath(value);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Message.error(
          t("miniapps.runner.openFailed", {
            defaultValue: message,
            message,
          }),
        );
      } finally {
        setOpening(false);
      }
    })();
  };

  if (widget.variant === "path") {
    return (
      <div className="miniapp-widget__artifact miniapp-widget__artifact--path">
        <span className="miniapp-widget__label">{resolvedLabel}</span>
        <div className="miniapp-widget__path-row">
          <input
            type="text"
            className="input miniapp-widget__path-input"
            value={value}
            onChange={handleInputChange}
            placeholder={t("miniapps.runner.artifact.enterValue")}
            aria-label={resolvedLabel}
          />
          <button
            type="button"
            className="btn btn--ghost btn--icon miniapp-widget__browse"
            onClick={handleBrowseClick}
            disabled={browsing}
            aria-label={t("miniapps.runner.artifact.browse")}
            title={t("miniapps.runner.artifact.browse")}
          >
            {browsing ? <SpinnerIcon /> : <FolderIcon />}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--icon miniapp-widget__open"
            onClick={handleOpenPath}
            disabled={opening || value === ""}
            aria-label={t("miniapps.runner.open")}
            title={t("miniapps.runner.open")}
          >
            {/* Distinct from the Browse folder glyph: "Open" launches the
                path in the OS, so it uses the outbound-arrow icon. */}
            {opening ? <SpinnerIcon /> : <ExportIcon />}
          </button>
        </div>
      </div>
    );
  }

  if (widget.variant === "secret") {
    return (
      <div className="miniapp-widget__artifact miniapp-widget__artifact--secret">
        <span className="miniapp-widget__label">{resolvedLabel}</span>
        <div className="miniapp-widget__secret-row">
          <input
            type={revealed ? "text" : "password"}
            className="input miniapp-widget__secret-input"
            value={value}
            onChange={handleInputChange}
            placeholder={t("miniapps.runner.artifact.enterValue")}
            aria-label={resolvedLabel}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="btn btn--ghost btn--icon miniapp-widget__reveal"
            onClick={() => setRevealed((v) => !v)}
            aria-pressed={revealed}
            aria-label={
              revealed ? t("miniapps.runner.hide") : t("miniapps.runner.reveal")
            }
            title={
              revealed ? t("miniapps.runner.hide") : t("miniapps.runner.reveal")
            }
          >
            {revealed ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>
      </div>
    );
  }

  // variant === "text"
  return (
    <div className="miniapp-widget__artifact miniapp-widget__artifact--text">
      <span className="miniapp-widget__label">{resolvedLabel}</span>
      <input
        type="text"
        className="input miniapp-widget__text-input"
        value={value}
        onChange={handleInputChange}
        placeholder={t("miniapps.runner.artifact.enterValue")}
        aria-label={resolvedLabel}
      />
    </div>
  );
}

interface TextWidgetProps extends ArtifactContext {
  widget: Extract<WidgetSpec, { kind: "text" }>;
}

/**
 * Static styled-text widget. Renders `content` with the author-configured
 * {@link TextStyle} (size / color / weight / italic / alignment). `content`
 * supports `${artifactName}` references resolved against the current artifact
 * values — the SAME display-time resolver the labels use. Purely display: no
 * interaction, no pointer capture, so it renders identically on the editor
 * canvas and in the runner.
 *
 * The inline `style` here is the legitimate dynamic case the styling canon
 * permits — every value is per-widget author data, and `color` is a token
 * (or hex) passed through verbatim rather than a hardcoded literal.
 */
function TextWidget({
  widget,
  artifactNames,
  valuesMap,
}: TextWidgetProps): ReactElement {
  const resolvedContent = resolveArtifactValues(
    widget.content,
    valuesMap,
    artifactNames,
  );

  const { style } = widget;
  const textStyle: CSSProperties = {
    fontSize: style.fontSize,
    textAlign: style.align,
    ...(style.color !== undefined ? { color: style.color } : {}),
    ...(style.bold ? { fontWeight: "bold" } : {}),
    ...(style.italic ? { fontStyle: "italic" } : {}),
  };

  return (
    <div className="miniapp-widget__text" style={textStyle}>
      {resolvedContent}
    </div>
  );
}

/**
 * Per-widget renderer for a Mini-App runtime panel. Switches on
 * `widget.kind` and delegates to the matching internal sub-component, which
 * owns its own interaction state (running flag, reveal toggle, switch
 * position, artifact input). The runner supplies shared status poller
 * results, a run-completed callback, and the live artifact context (values,
 * change handler, name set, resolver map, execution values) via props.
 */
export function MiniAppWidget({
  widget,
  statusResult,
  onActionComplete,
  onExecutionStarted,
  onRefreshStatus,
  artifactValues,
  onArtifactChange,
  artifactNames,
  valuesMap,
  executionValues,
  artifactSpecs,
  bordered = true,
}: MiniAppWidgetProps): ReactElement {
  const sharedContext = {
    artifactValues,
    onArtifactChange,
    artifactNames,
    valuesMap,
    executionValues,
    artifactSpecs,
  };
  let body: ReactElement;
  // Button and toggle cards host a `.btn` / `.toggle-switch` control that
  // already carries its own vertical chrome; `--button` trims the card's own
  // padding so the two don't stack (see the CSS comment in theme.css) at the
  // compact minimum height the editor now enforces for these kinds.
  let cardModifier = "";
  switch (widget.kind) {
    case "button":
      body = (
        <ButtonWidget
          widget={widget}
          onActionComplete={onActionComplete}
          onExecutionStarted={onExecutionStarted}
          {...sharedContext}
        />
      );
      cardModifier = " miniapp-widget--button";
      break;
    case "toggle":
      body = (
        <ToggleWidget
          widget={widget}
          statusResult={statusResult}
          onActionComplete={onActionComplete}
          onExecutionStarted={onExecutionStarted}
          onRefreshStatus={onRefreshStatus}
          {...sharedContext}
        />
      );
      cardModifier = " miniapp-widget--button";
      break;
    case "status":
      body = (
        <StatusWidgetView
          widget={widget}
          statusResult={statusResult}
          {...sharedContext}
        />
      );
      break;
    case "artifact":
      body = <ArtifactWidget widget={widget} {...sharedContext} />;
      break;
    case "text":
      body = <TextWidget widget={widget} {...sharedContext} />;
      break;
  }

  return (
    <div
      className={`miniapp-widget${cardModifier}${
        bordered ? "" : " miniapp-widget--chromeless"
      }`}
    >
      {body}
    </div>
  );
}
